//! Opt-in end-to-end check of the app's real sign-in core against a running
//! wardby server in self-hosted auth mode. Ignored by default.
//!
//! ```text
//! WARDBY_E2E_URL=http://127.0.0.1:8080 \
//! WARDBY_E2E_LOGIN_KEY=<login key of a user with the admin role> \
//!   cargo test --test e2e_local -- --ignored
//! ```
//!
//! The URL is the server's canonical URI (as entered in the app).
//!
//! No browser is involved: the test plays the browser's part over HTTP (login
//! form, consent form), then lets the app's own loopback listener receive the
//! redirect. It prints no tokens and never prints the login key.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::header::{ACCEPT, COOKIE, LOCATION, ORIGIN, SET_COOKIE};
use url::Url;
use wardby_viewer_lib::api::{RefreshStore, Session};
use wardby_viewer_lib::error::AppError;
use wardby_viewer_lib::events::{StreamFrame, spawn_events};
use wardby_viewer_lib::{loopback, oauth};

#[derive(Default)]
struct MemoryStore(Mutex<Option<String>>);

impl RefreshStore for MemoryStore {
    fn get(&self) -> Result<Option<String>, AppError> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn set(&self, refresh_token: &str) -> Result<(), AppError> {
        *self.0.lock().unwrap() = Some(refresh_token.to_string());
        Ok(())
    }
}

/// The browser's cookie jar, reduced to what the login flow needs.
#[derive(Default)]
struct Jar(Vec<(String, String)>);

impl Jar {
    fn absorb(&mut self, resp: &reqwest::Response) {
        for value in resp.headers().get_all(SET_COOKIE) {
            let Ok(text) = value.to_str() else { continue };
            let Some((pair, _)) = text.split_once(';') else {
                continue;
            };
            let Some((name, val)) = pair.split_once('=') else {
                continue;
            };
            self.0.retain(|(n, _)| n != name);
            if !val.is_empty() {
                self.0.push((name.to_string(), val.to_string()));
            }
        }
    }
    fn header(&self) -> String {
        self.0
            .iter()
            .map(|(n, v)| format!("{n}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    }
}

/// Value of `<input type="hidden" name="{name}" value="...">` in a page.
fn hidden(page: &str, name: &str) -> String {
    let marker = format!("name=\"{name}\" value=\"");
    let start = page.find(&marker).expect("hidden field present") + marker.len();
    let end = page[start..].find('"').expect("hidden field closed");
    page[start..start + end].to_string()
}

fn location(resp: &reqwest::Response, base: &Url) -> Url {
    let loc = resp
        .headers()
        .get(LOCATION)
        .expect("redirect has a Location")
        .to_str()
        .unwrap();
    base.join(loc).unwrap()
}

#[tokio::test]
#[ignore = "needs a running local wardby; set WARDBY_E2E_URL and WARDBY_E2E_LOGIN_KEY"]
async fn sign_in_graph_and_events_against_a_local_server() {
    let (Ok(server_url), Ok(login_key)) = (
        std::env::var("WARDBY_E2E_URL"),
        std::env::var("WARDBY_E2E_LOGIN_KEY"),
    ) else {
        eprintln!("WARDBY_E2E_URL / WARDBY_E2E_LOGIN_KEY not set; skipping");
        return;
    };
    let origin = Url::parse(&server_url)
        .unwrap()
        .origin()
        .ascii_serialization();
    let base = Url::parse(&origin).unwrap();

    // The app's own discovery, registration and authorize URL.
    let http = oauth::http_client().unwrap();
    let auth = oauth::discover(&http, &server_url).await.unwrap();
    let client_id = oauth::register(&http, &auth, oauth::REGISTRATION_REDIRECT)
        .await
        .unwrap();
    let (callback, listener) = loopback::bind().await.unwrap();
    let pkce = oauth::new_pkce();
    let state = oauth::new_state();
    let authorize = oauth::authorize_url(&auth, &client_id, &callback.redirect_uri, &pkce, &state);
    let issuer = auth.issuer.clone();
    let require_iss = auth.iss_required;
    let waiter = tokio::spawn(async move {
        loopback::wait_for_code(
            listener,
            &state,
            Some(&issuer),
            require_iss,
            Duration::from_secs(30),
        )
        .await
    });

    // Play the browser: authorize -> login form -> consent form -> callback.
    let browser = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let mut jar = Jar::default();

    let resp = browser.get(authorize).send().await.unwrap();
    assert!(resp.status().is_redirection(), "authorize redirects");
    let login_url = location(&resp, &base);

    let resp = browser
        .get(login_url)
        .header(COOKIE, jar.header())
        .send()
        .await
        .unwrap();
    jar.absorb(&resp);
    let page = resp.text().await.unwrap();
    let interaction = hidden(&page, "interaction");
    let resp = browser
        .post(base.join("/login").unwrap())
        .header(ORIGIN, &origin)
        .header(ACCEPT, "application/json")
        .header(COOKIE, jar.header())
        .form(&[
            ("interaction", interaction.as_str()),
            ("csrf", hidden(&page, "csrf").as_str()),
            ("login_key", login_key.as_str()),
        ])
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "login accepted");
    jar.absorb(&resp);
    let consent_url = base
        .join(
            resp.json::<serde_json::Value>().await.unwrap()["redirect"]
                .as_str()
                .expect("login returns a redirect"),
        )
        .unwrap();

    let resp = browser
        .get(consent_url)
        .header(COOKIE, jar.header())
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "consent page served");
    let page = resp.text().await.unwrap();
    assert!(page.contains("admin:view"), "consent asks for admin:view");
    let resp = browser
        .post(base.join("/consent").unwrap())
        .header(ORIGIN, &origin)
        .header(ACCEPT, "application/json")
        .header(COOKIE, jar.header())
        .form(&[
            ("interaction", interaction.as_str()),
            ("csrf", hidden(&page, "csrf").as_str()),
            ("decision", "approve"),
        ])
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "consent accepted");
    let callback_url = resp.json::<serde_json::Value>().await.unwrap()["redirect"]
        .as_str()
        .expect("consent returns a redirect")
        .to_string();
    assert!(
        callback_url.starts_with(&callback.redirect_uri),
        "server redirects to the loopback callback"
    );
    browser.get(&callback_url).send().await.unwrap();

    // The app's own code exchange and session.
    let code = waiter.await.unwrap().unwrap();
    let tokens = oauth::exchange_code(
        &http,
        &auth,
        &client_id,
        &callback.redirect_uri,
        &code,
        &pkce,
    )
    .await
    .unwrap();
    assert!(tokens.refresh_token.is_some(), "a refresh token is issued");
    let store: Arc<dyn RefreshStore> = Arc::new(MemoryStore::default());
    let session =
        Arc::new(Session::new(&server_url, auth, &client_id, store, Some(tokens)).unwrap());

    let graph = session
        .get_json("/admin/api/graph?since=1h&limit=50")
        .await
        .unwrap();
    assert!(graph.is_object(), "the graph is a JSON object");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = spawn_events(session.clone(), move |frame| {
        let _ = tx.send(frame);
    });
    let hello = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(frame) = rx.recv().await {
            if let StreamFrame::Hello { .. } = frame {
                return true;
            }
        }
        false
    })
    .await
    .expect("stream answers in time");
    assert!(hello, "the event stream sends hello");
    handle.abort();

    session.revoke().await;
}
