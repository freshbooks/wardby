//! The commands the webview may call. Tokens never leave Rust: commands return
//! server names, URLs, sign-in state and server JSON, and errors cross as
//! `{ kind, message, status? }`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

use crate::api::{KeychainStore, RefreshStore, Session};
use crate::error::AppError;
use crate::events::{EventsHandle, StreamFrame, spawn_events};
use crate::loopback;
use crate::oauth;
use crate::servers::{self, ServerConfig, normalize_server_url};

/// Tauri event that carries every stream frame to the UI.
pub const FRAME_EVENT: &str = "viewer://frame";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const STORE_FILE: &str = "servers.json";
const STORE_KEY: &str = "servers";

fn epoch_of(map: &std::sync::Mutex<HashMap<String, u64>>, url: &str) -> u64 {
    map.lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(url)
        .copied()
        .unwrap_or(0)
}

type Slot = Arc<tokio::sync::Mutex<Option<Arc<Session>>>>;

#[derive(Default)]
pub struct AppState {
    /// One slot per server (normalized URL). The slot's mutex is that server's
    /// AUTH LOCK: every session-lifecycle and Keychain-ownership step for the
    /// server (build from the Keychain, sign-in commit + install, sign-out,
    /// removal, dead-grant cleanup) runs holding it, so they are totally
    /// ordered and a stale session can never write over, or delete, a newer
    /// token. Lock order: auth lock -> a session's refresh lock (`revoke` waits
    /// on it), never the reverse; the refresh path itself never takes the auth
    /// lock. Per-server, so a slow server never blocks another. Slots are never
    /// removed.
    slots: std::sync::Mutex<HashMap<String, Slot>>,
    /// The current event stream and the server it belongs to.
    events: std::sync::Mutex<Option<(String, EventsHandle)>>,
    /// Serialises read-modify-write of the saved server list.
    config: std::sync::Mutex<()>,
    /// Per-server cancel counter, bumped by every `cancel_sign_in`. A sign-in
    /// remembers the value it started at and its commit is skipped under the
    /// auth lock if it has changed (see `commit_sign_in`).
    cancel_epochs: Arc<std::sync::Mutex<HashMap<String, u64>>>,
    /// Sign-ins in flight, by server URL.
    signins: std::sync::Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

/// Removes a sign-in's registration (and aborts it if still running) when the
/// command finishes or is dropped.
struct SignInGuard<'a> {
    state: &'a AppState,
    url: String,
    abort: tokio::task::AbortHandle,
}

impl Drop for SignInGuard<'_> {
    fn drop(&mut self) {
        self.abort.abort();
        self.state
            .signins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.url);
    }
}

impl AppState {
    fn events_slot(&self) -> std::sync::MutexGuard<'_, Option<(String, EventsHandle)>> {
        self.events.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Replaces (and so aborts) the current stream.
    fn set_stream(&self, server_url: String, handle: EventsHandle) {
        *self.events_slot() = Some((server_url, handle));
    }

    fn stop_stream_for(&self, server_url: &str) {
        let mut slot = self.events_slot();
        if slot.as_ref().is_some_and(|(u, _)| u == server_url) {
            *slot = None;
        }
    }

    fn slot(&self, server_url: &str) -> Slot {
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(server_url.to_string())
            .or_default()
            .clone()
    }

    /// Ends a server's session under its auth lock: stops its stream, revokes
    /// the session (after any in-flight refresh has finished persisting, so it
    /// can never write the Keychain again), then runs `delete` (the Keychain
    /// delete) before any other step for this server can start.
    async fn end_session<F>(&self, server_url: &str, delete: F) -> Result<(), AppError>
    where
        F: FnOnce(&str) -> Result<(), AppError> + Send + 'static,
    {
        let slot = self.slot(server_url);
        let mut g = slot.lock().await;
        self.stop_stream_for(server_url);
        if let Some(s) = g.take() {
            s.revoke().await;
        }
        let url = server_url.to_string();
        tokio::task::spawn_blocking(move || delete(&url))
            .await
            .map_err(|_| AppError::Keychain("keychain task failed".to_string()))?
    }

    /// A session whose grant is dead (refresh refused): forget it and delete the
    /// stale Keychain item, so the server shows as signed out. All under the auth
    /// lock, and only if the slot still holds this very session: if a re-sign-in
    /// replaced it, its newly committed token is left alone.
    async fn drop_dead<F>(&self, session: &Arc<Session>, delete: F)
    where
        F: FnOnce(&str) -> Result<(), AppError> + Send + 'static,
    {
        let url = session.server_url().to_string();
        let slot = self.slot(&url);
        let mut g = slot.lock().await;
        if !g.as_ref().is_some_and(|cur| Arc::ptr_eq(cur, session)) {
            return;
        }
        *g = None;
        self.stop_stream_for(&url);
        session.revoke().await;
        let _ = tokio::task::spawn_blocking(move || delete(&url)).await;
    }

    /// The server's session, building it from the Keychain on first use.
    async fn session_for(
        &self,
        server_url: &str,
        client_id: Option<&str>,
        store: Arc<dyn RefreshStore>,
    ) -> Result<Arc<Session>, AppError> {
        let slot = self.slot(server_url);
        let mut g = slot.lock().await;
        if let Some(s) = g.as_ref() {
            return Ok(s.clone());
        }
        let client_id = client_id.ok_or(AppError::NotSignedIn)?;
        let session = Arc::new(build_session(server_url, client_id, store).await?);
        *g = Some(session.clone());
        Ok(session)
    }

    /// Finishes a sign-in under the auth lock: revokes the session being
    /// replaced (so its in-flight refresh finishes, and can never persist an
    /// old-grant token over the new one), re-checks via `check` that the server
    /// is still saved, writes the FIRST refresh token to the store, and installs
    /// the new session.
    ///
    /// The commit runs as a DETACHED task: aborting the sign-in task (cancel,
    /// sign-out, removal) cannot drop it halfway, and the blocking Keychain
    /// write always finishes while the auth lock is still held, so a later
    /// `end_session` runs strictly after it. Cancellation is honoured by
    /// `epoch` (the server's cancel counter when the sign-in began): if it moved,
    /// the commit is skipped under the lock. A commit that had already started
    /// writing is NOT undone: the user is signed in until the following
    /// sign-out/removal (which is ordered after it) ends the session.
    async fn commit_sign_in<C>(
        &self,
        session: Session,
        refresh: String,
        store: Arc<dyn RefreshStore>,
        epoch: u64,
        check: C,
    ) -> Result<(), AppError>
    where
        C: FnOnce() -> Result<(), AppError> + Send + 'static,
    {
        let url = session.server_url().to_string();
        let slot = self.slot(&url);
        let epochs = self.cancel_epochs.clone();
        self.stop_stream_for(&url);
        tokio::spawn(async move {
            let mut g = slot.lock().await;
            if epoch_of(&epochs, &url) != epoch {
                return Err(AppError::Cancelled);
            }
            if let Some(old) = g.take() {
                old.revoke().await;
            }
            tokio::task::spawn_blocking(move || {
                check()?;
                store.set(&refresh)
            })
            .await
            .map_err(|_| AppError::Keychain("keychain task failed".to_string()))??;
            *g = Some(Arc::new(session));
            Ok(())
        })
        .await
        .map_err(|_| AppError::Network("sign-in commit failed".to_string()))?
    }

    /// Runs one sign-in per server at a time, as its own task so
    /// `cancel_sign_in` can abort it (dropping its loopback listener).
    async fn single_flight<T, Fut>(&self, server_url: &str, fut: Fut) -> Result<T, AppError>
    where
        T: Send + 'static,
        Fut: Future<Output = Result<T, AppError>> + Send + 'static,
    {
        let (handle, _guard) = {
            let mut g = self.signins.lock().unwrap_or_else(|e| e.into_inner());
            if g.contains_key(server_url) {
                return Err(AppError::Protocol(
                    "sign-in already in progress".to_string(),
                ));
            }
            let handle = tokio::spawn(fut);
            let abort = handle.abort_handle();
            g.insert(server_url.to_string(), abort.clone());
            (
                handle,
                SignInGuard {
                    state: self,
                    url: server_url.to_string(),
                    abort,
                },
            )
        };
        match handle.await {
            Ok(r) => r,
            Err(e) if e.is_cancelled() => Err(AppError::Cancelled),
            Err(_) => Err(AppError::Network("sign-in task failed".to_string())),
        }
    }

    fn epoch(&self, server_url: &str) -> u64 {
        epoch_of(&self.cancel_epochs, server_url)
    }

    fn cancel_sign_in(&self, server_url: &str) -> bool {
        *self
            .cancel_epochs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(server_url.to_string())
            .or_insert(0) += 1;
        match self
            .signins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(server_url)
        {
            Some(h) => {
                h.abort();
                true
            }
            None => false,
        }
    }
}

// ------------------------------------------------------ saved servers

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ServerSummary {
    pub name: String,
    pub url: String,
    pub signed_in: bool,
}

fn summaries(list: &[ServerConfig], signed_in: impl Fn(&str) -> bool) -> Vec<ServerSummary> {
    list.iter()
        .map(|c| ServerSummary {
            name: c.name.clone(),
            url: c.url.clone(),
            signed_in: signed_in(&c.url),
        })
        .collect()
}

/// Adds a server, or updates the name (and client id, when one is given) of the
/// one with the same normalized URL.
fn upsert_server(
    list: &mut Vec<ServerConfig>,
    name: &str,
    url: &str,
    client_id: Option<&str>,
) -> Result<(), AppError> {
    let url = normalize_server_url(url)?;
    let client_id = client_id
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    let name = {
        let n = name.trim();
        if n.is_empty() {
            url::Url::parse(&url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_else(|| url.clone())
        } else {
            n.to_string()
        }
    };
    match list.iter_mut().find(|c| c.url == url) {
        Some(existing) => {
            existing.name = name;
            if client_id.is_some() {
                existing.client_id = client_id;
            }
        }
        None => list.push(ServerConfig {
            name,
            url,
            client_id,
        }),
    }
    Ok(())
}

/// Records a registered client id for a server that is still saved; an error if
/// it was removed meanwhile, so nothing is stored for a deleted server.
fn set_client_id(list: &mut [ServerConfig], url: &str, client_id: &str) -> Result<(), AppError> {
    let c = list
        .iter_mut()
        .find(|c| c.url == url)
        .ok_or_else(removed_error)?;
    c.client_id = Some(client_id.to_string());
    Ok(())
}

fn removed_error() -> AppError {
    AppError::Protocol("server was removed".to_string())
}

fn load_servers(app: &AppHandle) -> Result<Vec<ServerConfig>, AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|_| AppError::Storage("could not open the saved servers".to_string()))?;
    match store.get(STORE_KEY) {
        None => Ok(Vec::new()),
        Some(v) => serde_json::from_value(v)
            .map_err(|_| AppError::Storage("saved servers are unreadable".to_string())),
    }
}

fn save_servers(app: &AppHandle, list: &[ServerConfig]) -> Result<(), AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|_| AppError::Storage("could not open the saved servers".to_string()))?;
    store.set(STORE_KEY, json!(list));
    store
        .save()
        .map_err(|_| AppError::Storage("could not save the servers".to_string()))
}

/// Read-modify-write of the saved list under the state's lock.
fn edit_servers<T>(
    app: &AppHandle,
    state: &AppState,
    f: impl FnOnce(&mut Vec<ServerConfig>) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _g = state.config.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load_servers(app)?;
    let out = f(&mut list)?;
    save_servers(app, &list)?;
    Ok(out)
}

fn find_server(list: &[ServerConfig], url: &str) -> Result<ServerConfig, AppError> {
    list.iter()
        .find(|c| c.url == url)
        .cloned()
        .ok_or_else(|| AppError::Protocol("unknown server".to_string()))
}

// ------------------------------------------------------------ sign-in

struct SignedIn {
    session: Session,
    /// The first refresh token, to be committed (not yet stored anywhere).
    refresh: String,
}

type Hook = Box<dyn FnOnce(&str) -> Result<(), AppError> + Send>;

/// The side effects of a sign-in, injected so the flow is testable.
struct SignInHooks {
    /// Called with a freshly registered client id, BEFORE the browser opens, so
    /// a retry reuses it instead of registering again.
    on_registered: Hook,
    /// Opens the authorize URL in the system browser.
    open: Hook,
}

/// Discover, register if needed, send the user to the system browser, wait for
/// the loopback callback, exchange the code, and return the session with the
/// FIRST refresh token, which the caller commits via `commit_sign_in`.
async fn sign_in_flow(
    server_url: &str,
    saved_client_id: Option<String>,
    hooks: SignInHooks,
    store: Arc<dyn RefreshStore>,
    timeout: Duration,
) -> Result<SignedIn, AppError> {
    let http = oauth::http_client()?;
    let auth = oauth::discover(&http, server_url).await?;
    let client_id = match saved_client_id.filter(|c| !c.is_empty()) {
        Some(id) => id,
        None => {
            let id = oauth::register(&http, &auth, oauth::REGISTRATION_REDIRECT).await?;
            (hooks.on_registered)(&id)?;
            id
        }
    };

    let (callback, listener) = loopback::bind().await?;
    let pkce = oauth::new_pkce();
    let state = oauth::new_state();
    let url = oauth::authorize_url(&auth, &client_id, &callback.redirect_uri, &pkce, &state);
    (hooks.open)(url.as_str())?;
    let code = loopback::wait_for_code(listener, &state, Some(&auth.issuer), timeout).await?;

    let tokens = oauth::exchange_code(
        &http,
        &auth,
        &client_id,
        &callback.redirect_uri,
        &code,
        &pkce,
    )
    .await?;
    let refresh = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| AppError::Protocol("server issued no refresh token".to_string()))?;
    let session = Session::new(server_url, auth, &client_id, store, Some(tokens))?;
    Ok(SignedIn { session, refresh })
}

/// A session for a server that is already signed in (Keychain holds its
/// refresh token); the first request refreshes to get an access token.
async fn build_session(
    server_url: &str,
    client_id: &str,
    store: Arc<dyn RefreshStore>,
) -> Result<Session, AppError> {
    let s = store.clone();
    let have = tokio::task::spawn_blocking(move || s.get())
        .await
        .map_err(|_| AppError::Keychain("keychain task failed".to_string()))??;
    if have.is_none() {
        return Err(AppError::NotSignedIn);
    }
    let http = oauth::http_client()?;
    let auth = oauth::discover(&http, server_url).await?;
    Session::new(server_url, auth, client_id, store, None)
}

// -------------------------------------------------------------- frames

fn frame_json(frame: StreamFrame) -> Value {
    match frame {
        StreamFrame::Hello { connected } => json!({"type": "hello", "connected": connected}),
        StreamFrame::Status { connected } => json!({"type": "status", "connected": connected}),
        StreamFrame::Resync => json!({"type": "resync"}),
        StreamFrame::Event { kind, data } => json!({"type": "event", "kind": kind, "data": data}),
        StreamFrame::Reconnecting { attempt, delay_ms } => {
            json!({"type": "reconnecting", "attempt": attempt, "delay_ms": delay_ms})
        }
        StreamFrame::Ended { error } => json!({"type": "ended", "error": error}),
    }
}

fn frame_payload(server: &str, frame: StreamFrame) -> Value {
    json!({"server": server, "frame": frame_json(frame)})
}

// ------------------------------------------------------------ commands

fn keychain_has(url: &str) -> bool {
    matches!(servers::keychain_get(url), Ok(Some(_)))
}

#[tauri::command]
pub async fn list_servers(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<ServerSummary>, AppError> {
    let list = {
        let _g = state.config.lock().unwrap_or_else(|e| e.into_inner());
        load_servers(&app)?
    };
    tokio::task::spawn_blocking(move || summaries(&list, keychain_has))
        .await
        .map_err(|_| AppError::Keychain("keychain task failed".to_string()))
}

#[tauri::command]
pub async fn add_server(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    url: String,
    client_id: Option<String>,
) -> Result<(), AppError> {
    edit_servers(&app, &state, |list| {
        upsert_server(list, &name, &url, client_id.as_deref())
    })
}

#[tauri::command]
pub async fn remove_server(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    // Config first: from here on a sign-in in flight can no longer commit.
    edit_servers(&app, &state, |list| {
        list.retain(|c| c.url != url);
        Ok(())
    })?;
    state.cancel_sign_in(&url);
    state.end_session(&url, servers::keychain_delete).await
}

#[tauri::command]
pub async fn sign_in(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    let cfg = find_server(&load_servers(&app)?, &url)?;
    let fut = {
        let app = app.clone();
        let url = url.clone();
        async move {
            let st = app.state::<AppState>();
            let epoch = st.epoch(&url);
            let hooks = SignInHooks {
                on_registered: {
                    let (app, url) = (app.clone(), url.clone());
                    Box::new(move |id| {
                        edit_servers(&app, &app.state::<AppState>(), |l| {
                            set_client_id(l, &url, id)
                        })
                    })
                },
                open: {
                    let app = app.clone();
                    Box::new(move |authorize| {
                        app.opener().open_url(authorize, None::<&str>).map_err(|_| {
                            AppError::Network("could not open the system browser".to_string())
                        })
                    })
                },
            };
            let store: Arc<dyn RefreshStore> = Arc::new(KeychainStore::new(&url));
            let signed = sign_in_flow(
                &url,
                cfg.client_id.clone(),
                hooks,
                store.clone(),
                SIGN_IN_TIMEOUT,
            )
            .await?;
            // The server may have been removed during the browser step.
            let check = {
                let (app, url) = (app.clone(), url.clone());
                move || {
                    let st = app.state::<AppState>();
                    let _g = st.config.lock().unwrap_or_else(|e| e.into_inner());
                    find_server(&load_servers(&app)?, &url)
                        .map(|_| ())
                        .map_err(|_| removed_error())
                }
            };
            st.commit_sign_in(signed.session, signed.refresh, store, epoch, check)
                .await
        }
    };
    state.single_flight(&url, fut).await
}

#[tauri::command]
pub async fn cancel_sign_in(state: State<'_, AppState>, url: String) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    state.cancel_sign_in(&url);
    Ok(())
}

async fn sign_out_with<F>(state: &AppState, url: &str, delete: F) -> Result<(), AppError>
where
    F: FnOnce(&str) -> Result<(), AppError> + Send + 'static,
{
    // Revoke (waits out any in-flight refresh), then delete, under the auth lock.
    state.end_session(url, delete).await
}

#[tauri::command]
pub async fn sign_out(state: State<'_, AppState>, url: String) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    state.cancel_sign_in(&url);
    sign_out_with(&state, &url, servers::keychain_delete).await
}

async fn session_of(
    app: &AppHandle,
    state: &AppState,
    url: &str,
) -> Result<Arc<Session>, AppError> {
    let cfg = find_server(&load_servers(app)?, url)?;
    let store: Arc<dyn RefreshStore> = Arc::new(KeychainStore::new(url));
    state
        .session_for(url, cfg.client_id.as_deref(), store)
        .await
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    let session = session_of(&app, &state, &url).await?;
    let server = url.clone();
    let emitter = app.clone();
    let sess = session.clone();
    let handle = spawn_events(session, move |frame| {
        let dead = matches!(
            &frame,
            StreamFrame::Ended {
                error: AppError::NotSignedIn
            }
        );
        let _ = emitter.emit(FRAME_EVENT, frame_payload(&server, frame));
        if dead {
            let (app, sess) = (emitter.clone(), sess.clone());
            tauri::async_runtime::spawn(async move {
                app.state::<AppState>()
                    .drop_dead(&sess, servers::keychain_delete)
                    .await;
            });
        }
    });
    state.set_stream(url, handle);
    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, url: String) -> Result<(), AppError> {
    // Only that server's stream: a late cleanup must not kill the next server's.
    state.stop_stream_for(&normalize_server_url(&url)?);
    Ok(())
}

fn graph_path(since: &str, limit: u32) -> Result<String, AppError> {
    let since = since.trim();
    if since.is_empty() {
        return Err(AppError::Protocol("missing since".to_string()));
    }
    let enc: String = url::form_urlencoded::byte_serialize(since.as_bytes()).collect();
    Ok(format!("/admin/api/graph?since={enc}&limit={limit}"))
}

fn run_path(id: &str) -> Result<String, AppError> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        return Err(AppError::Protocol("invalid run id".to_string()));
    }
    Ok(format!("/admin/api/runs/{id}"))
}

/// GET through the server's session; a dead grant also clears the session and
/// the stale Keychain item so the server shows as signed out.
async fn fetch(
    app: &AppHandle,
    state: &AppState,
    url: &str,
    path: &str,
) -> Result<Value, AppError> {
    let session = session_of(app, state, url).await?;
    let r = session.get_json(path).await;
    if matches!(r, Err(AppError::NotSignedIn)) {
        state.drop_dead(&session, servers::keychain_delete).await;
    }
    r
}

#[tauri::command]
pub async fn fetch_graph(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    since: String,
    limit: u32,
) -> Result<Value, AppError> {
    let url = normalize_server_url(&url)?;
    let path = graph_path(&since, limit)?;
    fetch(&app, &state, &url, &path).await
}

#[tauri::command]
pub async fn fetch_run(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    id: String,
) -> Result<Value, AppError> {
    let url = normalize_server_url(&url)?;
    let path = run_path(&id)?;
    fetch(&app, &state, &url, &path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_support::{MemStore, auth_for};
    use std::sync::atomic::{AtomicBool, Ordering};
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn cfg(name: &str, url: &str, id: Option<&str>) -> ServerConfig {
        ServerConfig {
            name: name.into(),
            url: url.into(),
            client_id: id.map(Into::into),
        }
    }

    #[test]
    fn upsert_normalizes_and_dedupes() {
        let mut list = Vec::new();
        upsert_server(
            &mut list,
            " Prod ",
            "HTTPS://Wardby.Example.com/",
            Some(" "),
        )
        .unwrap();
        assert_eq!(list, vec![cfg("Prod", "https://wardby.example.com", None)]);
        upsert_server(&mut list, "", "https://wardby.example.com", Some("cid")).unwrap();
        assert_eq!(
            list,
            vec![cfg(
                "wardby.example.com",
                "https://wardby.example.com",
                Some("cid")
            )]
        );
        // Re-adding without a client id keeps the saved one.
        upsert_server(&mut list, "x", "https://wardby.example.com/", None).unwrap();
        assert_eq!(list[0].client_id.as_deref(), Some("cid"));
        assert_eq!(list.len(), 1);
        assert!(upsert_server(&mut list, "bad", "ftp://h", None).is_err());
        assert!(upsert_server(&mut list, "bad", "http://remote.example", None).is_err());
        assert!(upsert_server(&mut list, "bad", "https://u:p@h.example", None).is_err());
        assert!(upsert_server(&mut list, "bad", "https://h.example/?q=1", None).is_err());
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn summaries_never_carry_tokens_or_client_ids() {
        let list = vec![cfg("a", "https://a.example", Some("secretish"))];
        let s = summaries(&list, |u| u == "https://a.example");
        assert_eq!(
            s,
            vec![ServerSummary {
                name: "a".into(),
                url: "https://a.example".into(),
                signed_in: true
            }]
        );
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v[0].as_object().unwrap().len(), 3);
    }

    #[test]
    fn saved_config_has_no_token_field() {
        let v = serde_json::to_value(cfg("a", "https://a.example", Some("c"))).unwrap();
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys.len(), 3);
        assert!(
            keys.iter()
                .all(|k| ["name", "url", "client_id"].contains(&k.as_str()))
        );
    }

    #[test]
    fn paths_are_encoded_and_validated() {
        assert_eq!(
            graph_path("2026-01-01T00:00:00+02:00", 50).unwrap(),
            "/admin/api/graph?since=2026-01-01T00%3A00%3A00%2B02%3A00&limit=50"
        );
        assert!(graph_path(" ", 1).is_err());
        assert_eq!(run_path("ckabc-1_x").unwrap(), "/admin/api/runs/ckabc-1_x");
        assert!(run_path("../x").is_err());
        assert!(run_path("").is_err());
    }

    #[test]
    fn frames_serialize_with_a_type_tag() {
        assert_eq!(
            frame_json(StreamFrame::Hello { connected: true }),
            json!({"type": "hello", "connected": true})
        );
        assert_eq!(frame_json(StreamFrame::Resync), json!({"type": "resync"}));
        assert_eq!(
            frame_json(StreamFrame::Event {
                kind: "run".into(),
                data: json!({"id": "r1"})
            }),
            json!({"type": "event", "kind": "run", "data": {"id": "r1"}})
        );
        assert_eq!(
            frame_json(StreamFrame::Reconnecting {
                attempt: 2,
                delay_ms: 500
            }),
            json!({"type": "reconnecting", "attempt": 2, "delay_ms": 500})
        );
        assert_eq!(
            frame_json(StreamFrame::Ended {
                error: AppError::Forbidden
            })["error"]["kind"],
            "forbidden"
        );
        let p = frame_payload("https://s", StreamFrame::Status { connected: false });
        assert_eq!(p["server"], "https://s");
        assert_eq!(p["frame"]["type"], "status");
    }

    async fn mount_server(s: &MockServer, with_registration: bool) {
        let base = s.uri();
        let issuer = format!("{base}/mcp");
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-protected-resource"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "resource": format!("{base}/mcp"), "authorization_servers": [issuer],
            })))
            .mount(s)
            .await;
        let mut meta = json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
        });
        if with_registration {
            meta["registration_endpoint"] = json!(format!("{base}/register"));
        }
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(ResponseTemplate::new(200).set_body_json(meta))
            .mount(s)
            .await;
    }

    type TestHook = Box<dyn FnOnce(&str) -> Result<(), AppError> + Send>;

    fn hooks(open: impl FnOnce(&str) -> Result<(), AppError> + Send + 'static) -> SignInHooks {
        hooks_with(Box::new(|_| Ok(())), Box::new(open))
    }

    fn hooks_with(on_registered: TestHook, open: TestHook) -> SignInHooks {
        SignInHooks {
            on_registered,
            open,
        }
    }

    /// Stands in for the user's browser: follows the authorize URL's redirect
    /// back to the loopback listener with a code.
    fn fake_browser(issuer: String) -> impl FnOnce(&str) -> Result<(), AppError> {
        move |authorize: &str| {
            let u = url::Url::parse(authorize).unwrap();
            let q: HashMap<_, _> = u.query_pairs().into_owned().collect();
            assert_eq!(q["scope"], "admin:view");
            assert_eq!(q["code_challenge_method"], "S256");
            assert!(q["redirect_uri"].starts_with("http://127.0.0.1:"));
            let mut cb = url::Url::parse(&q["redirect_uri"]).unwrap();
            cb.query_pairs_mut()
                .append_pair("code", "the-code")
                .append_pair("state", &q["state"])
                .append_pair("iss", &issuer);
            tokio::spawn(async move {
                let _ = reqwest::get(cb).await;
            });
            Ok(())
        }
    }

    #[tokio::test]
    async fn sign_in_registers_exchanges_and_stores_the_first_refresh_token() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/register"))
            .and(body_string_contains("http://127.0.0.1/callback"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({"client_id": "reg-id"})))
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("code=the-code"))
            .and(body_string_contains("client_id=reg-id"))
            .and(body_string_contains("code_verifier="))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "AT1", "token_type": "Bearer",
                "refresh_token": "RT1", "expires_in": 3600
            })))
            .expect(1)
            .mount(&s)
            .await;
        let store = MemStore::with("old");
        *store.token.lock().unwrap() = None;
        let issuer = format!("{}/mcp", s.uri());
        let registered = Arc::new(std::sync::Mutex::new(None::<String>));
        let (r1, r2) = (registered.clone(), registered.clone());
        let c_store2 = store.clone();
        let browser = fake_browser(issuer);
        let out = sign_in_flow(
            &s.uri(),
            None,
            hooks_with(
                Box::new(move |id| {
                    *r1.lock().unwrap() = Some(id.to_string());
                    Ok(())
                }),
                Box::new(move |u| {
                    // Registered client id is saved before the browser opens.
                    assert_eq!(r2.lock().unwrap().as_deref(), Some("reg-id"));
                    // And nothing is in the Keychain until the code exchange.
                    assert!(c_store2.token.lock().unwrap().is_none());
                    browser(u)
                }),
            ),
            store.clone(),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(out.refresh, "RT1");
        assert_eq!(out.session.server_url(), s.uri());
        // The flow itself stores nothing; the commit does, under the auth lock.
        assert!(store.token.lock().unwrap().is_none());
        let st = AppState::default();
        st.commit_sign_in(out.session, out.refresh, store.clone(), 0, || Ok(()))
            .await
            .unwrap();
        assert_eq!(store.token.lock().unwrap().as_deref(), Some("RT1"));
        assert!(st.slot(&s.uri()).lock().await.is_some());
    }

    #[tokio::test]
    async fn sign_in_without_registration_or_client_id_needs_one() {
        let s = MockServer::start().await;
        mount_server(&s, false).await;
        let opened = Arc::new(AtomicBool::new(false));
        let o = opened.clone();
        let err = sign_in_flow(
            &s.uri(),
            None,
            hooks(move |_| {
                o.store(true, Ordering::SeqCst);
                Ok(())
            }),
            MemStore::with("x"),
            Duration::from_secs(1),
        )
        .await
        .err()
        .unwrap();
        assert!(matches!(err, AppError::NeedsClientId));
        assert!(!opened.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn sign_in_with_saved_client_id_skips_registration_and_can_time_out() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/register"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&s)
            .await;
        let err = sign_in_flow(
            &s.uri(),
            Some("saved".into()),
            hooks(|_| Ok(())),
            MemStore::with("x"),
            Duration::from_millis(150),
        )
        .await
        .err()
        .unwrap();
        assert!(matches!(err, AppError::Timeout));
    }

    #[tokio::test]
    async fn build_session_needs_a_keychain_token() {
        let store = Arc::new(MemStore::default());
        let err = build_session("https://unused.invalid", "cid", store)
            .await
            .err()
            .unwrap();
        assert!(matches!(err, AppError::NotSignedIn));
        // And no client id means not signed in either, without any lookup.
        let st = AppState::default();
        let err = st
            .session_for("https://unused.invalid", None, MemStore::with("rt"))
            .await
            .err()
            .unwrap();
        assert!(matches!(err, AppError::NotSignedIn));
    }

    #[tokio::test]
    async fn session_is_built_once_and_reused() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        let st = AppState::default();
        let store = MemStore::with("rt");
        let a = st
            .session_for(&s.uri(), Some("cid"), store.clone())
            .await
            .unwrap();
        let b = st.session_for(&s.uri(), Some("cid"), store).await.unwrap();
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[tokio::test]
    async fn sign_out_deletes_the_keychain_item_and_drops_session_and_stream() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        let other = MockServer::start().await;
        mount_server(&other, true).await;
        let st = AppState::default();
        let a = st
            .session_for(&s.uri(), Some("cid"), MemStore::with("rt"))
            .await
            .unwrap();
        st.session_for(&other.uri(), Some("cid"), MemStore::with("rt"))
            .await
            .unwrap();
        st.set_stream(s.uri(), spawn_events(a, |_| {}));

        let deleted = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let d = deleted.clone();
        // Signing out of a different server leaves the stream alone.
        sign_out_with(&st, &other.uri(), |_| Ok(())).await.unwrap();
        assert!(st.events_slot().is_some());
        sign_out_with(&st, &s.uri(), move |u| {
            d.lock().unwrap().push(u.to_string());
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(*deleted.lock().unwrap(), vec![s.uri()]);
        assert!(st.events_slot().is_none());
        assert!(st.slot(&s.uri()).lock().await.is_none());
    }

    #[tokio::test]
    async fn replacing_the_stream_and_disconnect_drop_the_old_one() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        let st = AppState::default();
        let a = st
            .session_for(&s.uri(), Some("cid"), MemStore::with("rt"))
            .await
            .unwrap();
        st.set_stream("one".into(), spawn_events(a.clone(), |_| {}));
        st.set_stream("two".into(), spawn_events(a, |_| {}));
        assert_eq!(st.events_slot().as_ref().unwrap().0, "two");
        st.stop_stream_for("two");
        assert!(st.events_slot().is_none());
    }

    #[tokio::test]
    async fn disconnect_only_stops_the_named_servers_stream() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        let st = AppState::default();
        let a = st
            .session_for(&s.uri(), Some("cid"), MemStore::with("rt"))
            .await
            .unwrap();
        st.set_stream("https://new.example".into(), spawn_events(a, |_| {}));
        st.stop_stream_for("https://old.example");
        assert_eq!(st.events_slot().as_ref().unwrap().0, "https://new.example");
        st.stop_stream_for("https://new.example");
        assert!(st.events_slot().is_none());
    }

    #[tokio::test]
    async fn registered_client_id_survives_a_failed_sign_in() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/register"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({"client_id": "reg-id"})))
            .expect(1)
            .mount(&s)
            .await;
        let saved = Arc::new(std::sync::Mutex::new(None::<String>));
        let sv = saved.clone();
        let err = sign_in_flow(
            &s.uri(),
            None,
            hooks_with(
                Box::new(move |id| {
                    *sv.lock().unwrap() = Some(id.to_string());
                    Ok(())
                }),
                Box::new(|_| Ok(())),
            ),
            MemStore::with("x"),
            Duration::from_millis(150),
        )
        .await
        .err()
        .unwrap();
        assert!(matches!(err, AppError::Timeout));
        let id = saved.lock().unwrap().clone();
        assert_eq!(id.as_deref(), Some("reg-id"));
        // The retry uses the saved id: /register is still at its one call.
        let err = sign_in_flow(
            &s.uri(),
            id,
            hooks(|_| Ok(())),
            MemStore::with("x"),
            Duration::from_millis(150),
        )
        .await
        .err()
        .unwrap();
        assert!(matches!(err, AppError::Timeout));
    }

    #[tokio::test]
    async fn failed_commit_stores_nothing_and_installs_nothing() {
        let s = MockServer::start().await;
        let st = AppState::default();
        let store = Arc::new(MemStore::default());
        let session =
            Session::new(&s.uri(), auth_for(&s.uri()), "cid", store.clone(), None).unwrap();
        let err = st
            .commit_sign_in(session, "RT1".into(), store.clone(), 0, || {
                Err(removed_error())
            })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Protocol(m) if m == "server was removed"));
        assert!(store.token.lock().unwrap().is_none());
        assert!(st.slot(&s.uri()).lock().await.is_none());
    }

    #[test]
    fn client_id_is_not_saved_for_a_removed_server() {
        let mut list = vec![cfg("a", "https://a.example", None)];
        set_client_id(&mut list, "https://a.example", "id").unwrap();
        assert_eq!(list[0].client_id.as_deref(), Some("id"));
        let err = set_client_id(&mut list, "https://gone.example", "id").unwrap_err();
        assert!(matches!(err, AppError::Protocol(_)));
    }

    #[tokio::test]
    async fn second_sign_in_is_refused_and_cancel_aborts_and_closes_the_listener() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        let st = Arc::new(AppState::default());
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let first = {
            let st = st.clone();
            let uri = s.uri();
            tokio::spawn(async move {
                let key = uri.clone();
                st.single_flight(&key, async move {
                    sign_in_flow(
                        &uri,
                        Some("cid".into()),
                        hooks(move |authorize| {
                            let u = url::Url::parse(authorize).unwrap();
                            let q: HashMap<_, _> = u.query_pairs().into_owned().collect();
                            let _ = tx.send(q["redirect_uri"].clone());
                            Ok(())
                        }),
                        MemStore::with("x"),
                        Duration::from_secs(60),
                    )
                    .await
                    .map(|_| ())
                })
                .await
            })
        };
        let redirect = rx.await.unwrap();
        let err = st
            .single_flight(&s.uri(), async { Ok(()) })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Protocol(m) if m == "sign-in already in progress"));
        // Another server is unaffected.
        st.single_flight("https://other.example", async { Ok(()) })
            .await
            .unwrap();

        assert!(st.cancel_sign_in(&s.uri()));
        let r = first.await.unwrap();
        assert!(matches!(r, Err(AppError::Cancelled)));
        let addr = url::Url::parse(&redirect).unwrap();
        let port = addr.port().unwrap();
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err(),
            "listener must be closed"
        );
        // And a new sign-in may start again.
        st.single_flight(&s.uri(), async { Ok(()) }).await.unwrap();
        assert!(!st.cancel_sign_in(&s.uri()));
    }

    #[tokio::test]
    async fn sign_out_during_a_refresh_cannot_be_undone_by_it() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(400))
                    .set_body_json(json!({
                        "access_token": "AT1", "token_type": "Bearer",
                        "refresh_token": "RT1", "expires_in": 3600
                    })),
            )
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/admin/api/graph"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&s)
            .await;
        let st = AppState::default();
        let store = MemStore::with("RT0");
        let session = st
            .session_for(&s.uri(), Some("cid"), store.clone())
            .await
            .unwrap();
        let inflight = {
            let session = session.clone();
            tokio::spawn(async move { session.get_json("/admin/api/graph").await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        let wipe = store.clone();
        sign_out_with(&st, &s.uri(), move |_| {
            *wipe.token.lock().unwrap() = None;
            Ok(())
        })
        .await
        .unwrap();
        assert!(store.token.lock().unwrap().is_none(), "token resurrected");
        let _ = inflight.await;
        // No further refresh: the (single-call) token endpoint is not hit again.
        let err = session.get_json("/admin/api/graph").await.unwrap_err();
        assert!(matches!(err, AppError::NotSignedIn));
        assert!(store.token.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn dead_grant_clears_the_session_and_the_stale_keychain_item() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400))
            .mount(&s)
            .await;
        let st = AppState::default();
        let store = MemStore::with("rt");
        let old = st
            .session_for(&s.uri(), Some("cid"), store.clone())
            .await
            .unwrap();
        let err = old.get_json("/admin/api/graph").await.unwrap_err();
        assert!(matches!(err, AppError::NotSignedIn));

        let deleted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let d = deleted.clone();
        st.drop_dead(&old, move |_| {
            d.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await;
        assert_eq!(deleted.load(Ordering::SeqCst), 1);
        assert!(st.slot(&s.uri()).lock().await.is_none());

        // A session that was already replaced is left alone.
        let newer = st.session_for(&s.uri(), Some("cid"), store).await.unwrap();
        let d = deleted.clone();
        st.drop_dead(&old, move |_| {
            d.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await;
        assert_eq!(deleted.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(
            st.slot(&s.uri()).lock().await.as_ref().unwrap(),
            &newer
        ));
    }

    #[tokio::test]
    async fn slow_server_does_not_block_another() {
        let slow = MockServer::start().await;
        let base = slow.uri();
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(5)))
            .mount(&slow)
            .await;
        let fast = MockServer::start().await;
        mount_server(&fast, true).await;
        let st = Arc::new(AppState::default());
        let st2 = st.clone();
        let slow_build = tokio::spawn(async move {
            let _ = st2
                .session_for(&base, Some("cid"), MemStore::with("rt"))
                .await;
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        let got = tokio::time::timeout(
            Duration::from_secs(2),
            st.session_for(&fast.uri(), Some("cid"), MemStore::with("rt")),
        )
        .await;
        assert!(got.unwrap().is_ok());
        slow_build.abort();
    }

    #[tokio::test]
    async fn re_sign_in_revokes_the_replaced_session_so_its_refresh_cannot_win() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(400))
                    .set_body_json(json!({
                        "access_token": "AT-old", "token_type": "Bearer",
                        "refresh_token": "RT-old-rotated", "expires_in": 3600
                    })),
            )
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/admin/api/graph"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&s)
            .await;
        let st = AppState::default();
        let store = MemStore::with("RT-old");
        // Built from the old Keychain token during the browser step.
        let old = st
            .session_for(&s.uri(), Some("cid"), store.clone())
            .await
            .unwrap();
        let inflight = {
            let old = old.clone();
            tokio::spawn(async move { old.get_json("/admin/api/graph").await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        let new = Session::new(&s.uri(), auth_for(&s.uri()), "cid", store.clone(), None).unwrap();
        st.commit_sign_in(new, "RT-new".into(), store.clone(), 0, || Ok(()))
            .await
            .unwrap();
        assert_eq!(store.token.lock().unwrap().as_deref(), Some("RT-new"));
        let _ = inflight.await;
        assert_eq!(store.token.lock().unwrap().as_deref(), Some("RT-new"));
        assert!(matches!(
            old.get_json("/admin/api/graph").await,
            Err(AppError::NotSignedIn)
        ));
        let slot = st.slot(&s.uri());
        let g = slot.lock().await;
        assert!(!Arc::ptr_eq(g.as_ref().unwrap(), &old));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sign_out_vs_a_concurrent_rebuild_leaves_the_store_empty() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        for i in 0..20 {
            let st = Arc::new(AppState::default());
            let store = MemStore::with("rt");
            let uri = s.uri();
            let (wipe, st1, st2, store2, uri1, uri2) = (
                store.clone(),
                st.clone(),
                st.clone(),
                store.clone(),
                uri.clone(),
                uri.clone(),
            );
            let rebuild = tokio::spawn(async move {
                if i % 2 == 0 {
                    tokio::task::yield_now().await;
                }
                let _ = st2.session_for(&uri2, Some("cid"), store2).await;
            });
            let out = tokio::spawn(async move {
                sign_out_with(&st1, &uri1, move |_| {
                    *wipe.token.lock().unwrap() = None;
                    Ok(())
                })
                .await
            });
            out.await.unwrap().unwrap();
            rebuild.await.unwrap();
            assert!(store.token.lock().unwrap().is_none());
            // Whatever order they ran in, no live session is left behind.
            assert!(st.slot(&uri).lock().await.is_none());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn dead_session_cleanup_never_deletes_a_concurrently_committed_token() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        for i in 0..20 {
            let st = Arc::new(AppState::default());
            let store = MemStore::with("rt");
            let old = st
                .session_for(&s.uri(), Some("cid"), store.clone())
                .await
                .unwrap();
            let new =
                Session::new(&s.uri(), auth_for(&s.uri()), "cid", store.clone(), None).unwrap();
            let wipe = store.clone();
            let (st1, st2, store2) = (st.clone(), st.clone(), store.clone());
            let dead = tokio::spawn(async move {
                if i % 2 == 0 {
                    tokio::task::yield_now().await;
                }
                st1.drop_dead(&old, move |_| {
                    *wipe.token.lock().unwrap() = None;
                    Ok(())
                })
                .await;
            });
            let commit = tokio::spawn(async move {
                st2.commit_sign_in(new, "RT-new".into(), store2, 0, || Ok(()))
                    .await
            });
            commit.await.unwrap().unwrap();
            dead.await.unwrap();
            assert_eq!(store.token.lock().unwrap().as_deref(), Some("RT-new"));
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancel_and_sign_out_mid_write_leave_the_store_empty_and_no_session() {
        let s = MockServer::start().await;
        let st = Arc::new(AppState::default());
        let store = MemStore::with("old");
        store.set_delay_ms.store(400, Ordering::SeqCst);
        let session =
            Session::new(&s.uri(), auth_for(&s.uri()), "cid", store.clone(), None).unwrap();
        let uri = s.uri();
        let epoch = st.epoch(&uri);
        let signin = {
            let (st, store, uri) = (st.clone(), store.clone(), uri.clone());
            tokio::spawn(async move {
                let st2 = st.clone();
                st.single_flight(&uri, async move {
                    st2.commit_sign_in(session, "RT-new".into(), store, epoch, || Ok(()))
                        .await
                })
                .await
            })
        };
        // Land in the middle of the slow Keychain write.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wipe = store.clone();
        let out = {
            let (st, uri) = (st.clone(), uri.clone());
            tokio::spawn(async move {
                st.cancel_sign_in(&uri);
                sign_out_with(&st, &uri, move |_| {
                    *wipe.token.lock().unwrap() = None;
                    Ok(())
                })
                .await
            })
        };
        out.await.unwrap().unwrap();
        let _ = signin.await.unwrap();
        // The write finished under the lock first, then sign-out deleted it.
        assert!(store.token.lock().unwrap().is_none());
        assert!(st.slot(&uri).lock().await.is_none());
    }

    #[tokio::test]
    async fn a_commit_cancelled_before_it_starts_is_skipped() {
        let s = MockServer::start().await;
        let st = AppState::default();
        let store = Arc::new(MemStore::default());
        let session =
            Session::new(&s.uri(), auth_for(&s.uri()), "cid", store.clone(), None).unwrap();
        let epoch = st.epoch(&s.uri());
        st.cancel_sign_in(&s.uri());
        let err = st
            .commit_sign_in(session, "RT".into(), store.clone(), epoch, || Ok(()))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
        assert!(store.token.lock().unwrap().is_none());
        assert!(st.slot(&s.uri()).lock().await.is_none());
    }
}
