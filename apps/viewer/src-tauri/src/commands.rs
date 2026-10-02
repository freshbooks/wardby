//! The commands the webview may call. Tokens never leave Rust: commands return
//! server names, URLs, sign-in state and server JSON, and errors cross as
//! `{ kind, message, status? }`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State};
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

#[derive(Default)]
pub struct AppState {
    /// One live `Session` per server (normalized URL). Held across a build so
    /// two callers can never both spend the same refresh token.
    sessions: tokio::sync::Mutex<HashMap<String, Arc<Session>>>,
    /// The current event stream and the server it belongs to.
    events: std::sync::Mutex<Option<(String, EventsHandle)>>,
    /// Serialises read-modify-write of the saved server list.
    config: std::sync::Mutex<()>,
}

impl AppState {
    fn events_slot(&self) -> std::sync::MutexGuard<'_, Option<(String, EventsHandle)>> {
        self.events.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Replaces (and so aborts) the current stream.
    fn set_stream(&self, server_url: String, handle: EventsHandle) {
        *self.events_slot() = Some((server_url, handle));
    }

    fn stop_stream(&self) {
        *self.events_slot() = None;
    }

    fn stop_stream_for(&self, server_url: &str) {
        let mut slot = self.events_slot();
        if slot.as_ref().is_some_and(|(u, _)| u == server_url) {
            *slot = None;
        }
    }

    /// Drops everything held for a server: its session and its stream.
    async fn forget(&self, server_url: &str) {
        self.sessions.lock().await.remove(server_url);
        self.stop_stream_for(server_url);
    }

    /// The server's session, building it from the Keychain on first use.
    async fn session_for(
        &self,
        server_url: &str,
        client_id: Option<&str>,
        store: Arc<dyn RefreshStore>,
    ) -> Result<Arc<Session>, AppError> {
        let mut sessions = self.sessions.lock().await;
        if let Some(s) = sessions.get(server_url) {
            return Ok(s.clone());
        }
        let client_id = client_id.ok_or(AppError::NotSignedIn)?;
        let session = Arc::new(build_session(server_url, client_id, store).await?);
        sessions.insert(server_url.to_string(), session.clone());
        Ok(session)
    }

    async fn install_session(&self, session: Session) {
        let url = session.server_url().to_string();
        self.sessions
            .lock()
            .await
            .insert(url.clone(), Arc::new(session));
        // A stream started with the old session must restart on the new one.
        self.stop_stream_for(&url);
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

fn set_client_id(list: &mut [ServerConfig], url: &str, client_id: &str) {
    if let Some(c) = list.iter_mut().find(|c| c.url == url) {
        c.client_id = Some(client_id.to_string());
    }
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
    /// The client id used (registered just now, or the saved one).
    client_id: String,
}

/// Discover, register if needed, send the user to the system browser, wait for
/// the loopback callback, exchange the code, keep the FIRST refresh token in
/// the store, and return the session.
async fn sign_in_flow(
    server_url: &str,
    saved_client_id: Option<String>,
    open: impl FnOnce(&str) -> Result<(), AppError>,
    store: Arc<dyn RefreshStore>,
    timeout: Duration,
) -> Result<SignedIn, AppError> {
    let http = oauth::http_client()?;
    let auth = oauth::discover(&http, server_url).await?;
    let client_id = match saved_client_id.filter(|c| !c.is_empty()) {
        Some(id) => id,
        None => oauth::register(&http, &auth, oauth::REGISTRATION_REDIRECT).await?,
    };

    let (callback, listener) = loopback::bind().await?;
    let pkce = oauth::new_pkce();
    let state = oauth::new_state();
    let url = oauth::authorize_url(&auth, &client_id, &callback.redirect_uri, &pkce, &state);
    open(url.as_str())?;
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
    let s = store.clone();
    tokio::task::spawn_blocking(move || s.set(&refresh))
        .await
        .map_err(|_| AppError::Keychain("keychain task failed".to_string()))??;

    let session = Session::new(server_url, auth, &client_id, store, Some(tokens))?;
    Ok(SignedIn { session, client_id })
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
    state.forget(&url).await;
    delete_refresh_token(&url).await?;
    edit_servers(&app, &state, |list| {
        list.retain(|c| c.url != url);
        Ok(())
    })
}

async fn delete_refresh_token(url: &str) -> Result<(), AppError> {
    let url = url.to_string();
    tokio::task::spawn_blocking(move || servers::keychain_delete(&url))
        .await
        .map_err(|_| AppError::Keychain("keychain task failed".to_string()))?
}

#[tauri::command]
pub async fn sign_in(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    let cfg = find_server(&load_servers(&app)?, &url)?;
    let opener_app = app.clone();
    let open = move |authorize: &str| {
        opener_app
            .opener()
            .open_url(authorize, None::<&str>)
            .map_err(|_| AppError::Network("could not open the system browser".to_string()))
    };
    let store: Arc<dyn RefreshStore> = Arc::new(KeychainStore::new(&url));
    let signed = sign_in_flow(&url, cfg.client_id.clone(), open, store, SIGN_IN_TIMEOUT).await?;
    if cfg.client_id.as_deref() != Some(signed.client_id.as_str()) {
        edit_servers(&app, &state, |list| {
            set_client_id(list, &url, &signed.client_id);
            Ok(())
        })?;
    }
    state.install_session(signed.session).await;
    Ok(())
}

async fn sign_out_with<F>(state: &AppState, url: &str, delete: F) -> Result<(), AppError>
where
    F: FnOnce(&str) -> Result<(), AppError> + Send + 'static,
{
    state.forget(url).await;
    let url = url.to_string();
    tokio::task::spawn_blocking(move || delete(&url))
        .await
        .map_err(|_| AppError::Keychain("keychain task failed".to_string()))?
}

#[tauri::command]
pub async fn sign_out(state: State<'_, AppState>, url: String) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
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
    let handle = spawn_events(session, move |frame| {
        let _ = emitter.emit(FRAME_EVENT, frame_payload(&server, frame));
    });
    state.set_stream(url, handle);
    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> Result<(), AppError> {
    state.stop_stream();
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
    session_of(&app, &state, &url).await?.get_json(&path).await
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
    session_of(&app, &state, &url).await?.get_json(&path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_support::MemStore;
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
        let out = sign_in_flow(
            &s.uri(),
            None,
            fake_browser(issuer),
            store.clone(),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(out.client_id, "reg-id");
        assert_eq!(store.token.lock().unwrap().as_deref(), Some("RT1"));
        assert_eq!(out.session.server_url(), s.uri());
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
            move |_| {
                o.store(true, Ordering::SeqCst);
                Ok(())
            },
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
            |_| Ok(()),
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
        assert!(st.sessions.lock().await.is_empty());
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
        st.stop_stream();
        assert!(st.events_slot().is_none());
    }
}
