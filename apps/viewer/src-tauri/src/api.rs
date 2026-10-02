//! Authenticated API client. A `Session` owns the in-memory access token for
//! one server and refreshes it, serialised, when the server answers 401.
//!
//! wardby rotates refresh tokens and treats reuse of a spent one as theft, so
//! two requests must never both spend the same refresh token: refreshes run
//! under one lock, and a request that lost the race reuses the winner's result.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::AppError;
use crate::oauth::{self, AuthServer, Tokens};

/// Where the rotating refresh token lives between runs (the Keychain in the app).
pub trait RefreshStore: Send + Sync + 'static {
    fn get(&self) -> Result<Option<String>, AppError>;
    fn set(&self, refresh_token: &str) -> Result<(), AppError>;
}

/// `RefreshStore` backed by the macOS Keychain entry for one server.
pub struct KeychainStore {
    server_url: String,
}

impl KeychainStore {
    pub fn new(server_url: &str) -> Self {
        Self {
            server_url: server_url.to_string(),
        }
    }
}

impl RefreshStore for KeychainStore {
    fn get(&self) -> Result<Option<String>, AppError> {
        crate::servers::keychain_get(&self.server_url)
    }
    fn set(&self, refresh_token: &str) -> Result<(), AppError> {
        crate::servers::keychain_set(&self.server_url, refresh_token)
    }
}

/// Upper bound on one API response body (the graph can be large; this only
/// stops a misbehaving server from exhausting memory).
const MAX_API_BODY_BYTES: usize = 32 * 1024 * 1024;
/// Refresh this long before the access token's stated expiry.
const EXPIRY_SKEW: Duration = Duration::from_secs(30);

struct Access {
    token: String,
    expires_at: Option<Instant>,
}

impl Access {
    fn fresh(&self) -> bool {
        self.expires_at
            .is_none_or(|t| t > Instant::now() + EXPIRY_SKEW)
    }
}

pub struct Session {
    server_url: String,
    auth: AuthServer,
    client_id: String,
    http: reqwest::Client,
    stream_http: reqwest::Client,
    store: Arc<dyn RefreshStore>,
    access: std::sync::Mutex<Option<Access>>,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
}

/// Reads the stored refresh token, spends it, and persists the rotated one.
/// Runs to completion even if the caller is dropped: a rotated token that was
/// issued but never stored would lock the user out.
async fn run_refresh(
    http: reqwest::Client,
    auth: AuthServer,
    client_id: String,
    store: Arc<dyn RefreshStore>,
) -> Result<Tokens, AppError> {
    let s = store.clone();
    let stored = tokio::task::spawn_blocking(move || s.get())
        .await
        .map_err(|_| AppError::Keychain("keychain task failed".to_string()))??;
    let refresh_token = stored.ok_or(AppError::NotSignedIn)?;
    let tokens = match oauth::refresh(&http, &auth, &client_id, &refresh_token).await {
        Ok(t) => t,
        // The grant is gone (revoked, expired, or already spent): sign in again.
        Err(AppError::Http {
            status: 400 | 401, ..
        }) => return Err(AppError::NotSignedIn),
        Err(e) => return Err(e),
    };
    // Persist the rotated token BEFORE the new access token is used anywhere.
    if let Some(new_rt) = tokens.refresh_token.clone() {
        let s = store.clone();
        tokio::task::spawn_blocking(move || s.set(&new_rt))
            .await
            .map_err(|_| AppError::Keychain("keychain task failed".to_string()))??;
    }
    Ok(tokens)
}

impl Session {
    pub fn new(
        server_url: &str,
        auth: AuthServer,
        client_id: &str,
        store: Arc<dyn RefreshStore>,
        initial: Option<Tokens>,
    ) -> Result<Self, AppError> {
        let server_url = crate::servers::normalize_server_url(server_url)?;
        let http = oauth::http_client()?;
        // No total timeout (the stream is long-lived); only a connect timeout.
        let stream_http =
            oauth::build_client(oauth::client_builder().connect_timeout(Duration::from_secs(15)))?;
        Ok(Self {
            server_url,
            auth,
            client_id: client_id.to_string(),
            http,
            stream_http,
            store,
            access: std::sync::Mutex::new(initial.map(|t| Access {
                token: t.access_token,
                expires_at: t.expires_at,
            })),
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub fn server_url(&self) -> &str {
        &self.server_url
    }

    pub(crate) fn stream_client(&self) -> &reqwest::Client {
        &self.stream_http
    }

    /// Absolute URL for a server-relative path; refuses anything that could
    /// send the bearer token to another host.
    pub(crate) fn url_for(&self, path_and_query: &str) -> Result<String, AppError> {
        if !path_and_query.starts_with('/') || path_and_query.starts_with("//") {
            return Err(AppError::Protocol("invalid API path".to_string()));
        }
        Ok(format!("{}{}", self.server_url, path_and_query))
    }

    fn current(&self) -> Option<(String, bool)> {
        let g = self.access.lock().unwrap_or_else(|e| e.into_inner());
        g.as_ref().map(|a| (a.token.clone(), a.fresh()))
    }

    /// Returns a usable access token, refreshing if `rejected` was refused by
    /// the server (or is absent/expired). Refreshes are serialised: whoever
    /// gets the lock second finds the new token already installed and reuses it.
    async fn token_after(&self, rejected: Option<&str>) -> Result<String, AppError> {
        let guard = self.refresh_lock.clone().lock_owned().await;
        if let Some((tok, fresh)) = self.current()
            && fresh
            && Some(tok.as_str()) != rejected
        {
            return Ok(tok);
        }
        let task = tokio::spawn(run_refresh(
            self.http.clone(),
            self.auth.clone(),
            self.client_id.clone(),
            self.store.clone(),
        ));
        // Hold the lock inside the refresh itself so a dropped caller cannot
        // release it while the token endpoint call is still in flight.
        let tokens = tokio::spawn(async move {
            let _guard = guard;
            task.await
                .map_err(|_| AppError::Network("refresh task failed".to_string()))?
        })
        .await
        .map_err(|_| AppError::Network("refresh task failed".to_string()))??;
        let token = tokens.access_token.clone();
        *self.access.lock().unwrap_or_else(|e| e.into_inner()) = Some(Access {
            token: tokens.access_token,
            expires_at: tokens.expires_at,
        });
        Ok(token)
    }

    /// Sends a request with the bearer token; on 401 refreshes once and retries
    /// once. A second 401 means the grant no longer works: `NotSignedIn`.
    pub(crate) async fn authed_send(
        &self,
        build: impl Fn(&str) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, AppError> {
        let used = match self.current() {
            Some((tok, true)) => tok,
            Some((tok, false)) => self.token_after(Some(&tok)).await?,
            None => self.token_after(None).await?,
        };
        let resp = build(&used).send().await?;
        if resp.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Ok(resp);
        }
        let fresh = self.token_after(Some(&used)).await?;
        let resp = build(&fresh).send().await?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AppError::NotSignedIn);
        }
        Ok(resp)
    }

    pub async fn get_json(&self, path_and_query: &str) -> Result<serde_json::Value, AppError> {
        let url = self.url_for(path_and_query)?;
        let resp = self
            .authed_send(|tok| {
                self.http
                    .get(&url)
                    .bearer_auth(tok)
                    .header(reqwest::header::ACCEPT, "application/json")
            })
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(AppError::Http {
                status: status.as_u16(),
            });
        }
        let body = oauth::read_capped_to(resp, MAX_API_BODY_BYTES).await?;
        serde_json::from_slice(&body)
            .map_err(|_| AppError::Protocol("unexpected response shape".to_string()))
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use url::Url;

    #[derive(Default)]
    pub(crate) struct MemStore {
        pub token: std::sync::Mutex<Option<String>>,
        pub writes: AtomicUsize,
    }
    impl MemStore {
        pub fn with(token: &str) -> Arc<Self> {
            Arc::new(Self {
                token: std::sync::Mutex::new(Some(token.to_string())),
                writes: AtomicUsize::new(0),
            })
        }
    }
    impl RefreshStore for MemStore {
        fn get(&self) -> Result<Option<String>, AppError> {
            Ok(self.token.lock().unwrap().clone())
        }
        fn set(&self, t: &str) -> Result<(), AppError> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            *self.token.lock().unwrap() = Some(t.to_string());
            Ok(())
        }
    }

    pub(crate) fn auth_for(base: &str) -> AuthServer {
        AuthServer {
            authorization_endpoint: Url::parse(&format!("{base}/authorize")).unwrap(),
            token_endpoint: Url::parse(&format!("{base}/token")).unwrap(),
            registration_endpoint: None,
            resource: format!("{base}/mcp"),
            issuer: format!("{base}/mcp"),
        }
    }

    pub(crate) fn tokens(access: &str) -> Tokens {
        Tokens {
            access_token: access.into(),
            refresh_token: Some("RT0".into()),
            expires_at: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::sync::atomic::Ordering;
    use wiremock::matchers::{body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn token_ok(access: &str, refresh: &str) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": access, "token_type": "Bearer",
            "refresh_token": refresh, "expires_in": 3600
        }))
    }

    fn session(base: &str, store: Arc<MemStore>, initial: Option<&str>) -> Session {
        Session::new(base, auth_for(base), "cid", store, initial.map(tokens)).unwrap()
    }

    #[tokio::test]
    async fn get_json_returns_body_with_bearer_auth() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/admin/api/graph"))
            .and(header("authorization", "Bearer AT0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"a": 1})))
            .expect(1)
            .mount(&s)
            .await;
        let sess = session(&s.uri(), MemStore::with("RT0"), Some("AT0"));
        let v = sess.get_json("/admin/api/graph?limit=5").await.unwrap();
        assert_eq!(v["a"], 1);
    }

    #[tokio::test]
    async fn refreshes_once_on_401_persists_rotated_token_and_retries() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("authorization", "Bearer AT0"))
            .respond_with(ResponseTemplate::new(401))
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(header("authorization", "Bearer AT1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true})))
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("refresh_token=RT0"))
            .respond_with(token_ok("AT1", "RT1"))
            .expect(1)
            .mount(&s)
            .await;
        let store = MemStore::with("RT0");
        let sess = session(&s.uri(), store.clone(), Some("AT0"));
        assert_eq!(sess.get_json("/x").await.unwrap()["ok"], true);
        assert_eq!(store.get().unwrap().as_deref(), Some("RT1"));
    }

    #[tokio::test]
    async fn refresh_failure_is_not_signed_in() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({"error": "invalid_grant"})),
            )
            .expect(1)
            .mount(&s)
            .await;
        let sess = session(&s.uri(), MemStore::with("RT0"), Some("AT0"));
        assert!(matches!(
            sess.get_json("/x").await,
            Err(AppError::NotSignedIn)
        ));
    }

    #[tokio::test]
    async fn second_401_after_refresh_is_not_signed_in() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401))
            .expect(2)
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(token_ok("AT1", "RT1"))
            .expect(1)
            .mount(&s)
            .await;
        let sess = session(&s.uri(), MemStore::with("RT0"), Some("AT0"));
        assert!(matches!(
            sess.get_json("/x").await,
            Err(AppError::NotSignedIn)
        ));
    }

    #[tokio::test]
    async fn no_refresh_token_is_not_signed_in() {
        let s = MockServer::start().await;
        let store = Arc::new(MemStore::default());
        let sess = session(&s.uri(), store, None);
        assert!(matches!(
            sess.get_json("/x").await,
            Err(AppError::NotSignedIn)
        ));
    }

    #[tokio::test]
    async fn no_initial_token_refreshes_before_first_request() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(token_ok("AT1", "RT1"))
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(header("authorization", "Bearer AT1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&s)
            .await;
        let sess = session(&s.uri(), MemStore::with("RT0"), None);
        sess.get_json("/x").await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_401s_spend_the_refresh_token_once() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("authorization", "Bearer AT0"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(header("authorization", "Bearer AT1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": 1})))
            .expect(4)
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(token_ok("AT1", "RT1").set_delay(Duration::from_millis(150)))
            .expect(1)
            .mount(&s)
            .await;
        let store = MemStore::with("RT0");
        let sess = Arc::new(session(&s.uri(), store.clone(), Some("AT0")));
        let rs = futures_util::future::join_all((0..4).map(|_| {
            let sess = sess.clone();
            async move { sess.get_json("/x").await }
        }))
        .await;
        assert!(rs.iter().all(|r| r.is_ok()), "{rs:?}");
        assert_eq!(store.writes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn other_statuses_are_http_errors_and_do_not_refresh() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(token_ok("AT1", "RT1"))
            .expect(0)
            .mount(&s)
            .await;
        let sess = session(&s.uri(), MemStore::with("RT0"), Some("AT0"));
        assert!(matches!(
            sess.get_json("/x").await,
            Err(AppError::Http { status: 403 })
        ));
    }

    #[tokio::test]
    async fn rejects_paths_that_are_not_server_relative() {
        let s = MockServer::start().await;
        let sess = session(&s.uri(), MemStore::with("RT0"), Some("AT0"));
        assert!(sess.get_json("https://evil.example/x").await.is_err());
        assert!(sess.get_json("//evil.example/x").await.is_err());
    }
}
