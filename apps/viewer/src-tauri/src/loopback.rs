//! One-shot loopback redirect listener (RFC 8252 section 7.3). Binds
//! 127.0.0.1 only, serves a single expected path, and is dropped (closing the
//! socket) after the first callback that carries a code or an error, or when the
//! timeout elapses.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

use crate::error::AppError;

pub const CALLBACK_PATH: &str = "/callback";
const MAX_REQUEST_BYTES: usize = 8 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct Callback {
    /// `http://127.0.0.1:<port>/callback`
    pub redirect_uri: String,
}

pub async fn bind() -> Result<(Callback, TcpListener), AppError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| AppError::Network("could not open the local callback listener".to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|_| AppError::Network("could not read the local callback port".to_string()))?
        .port();
    Ok((
        Callback {
            redirect_uri: format!("http://127.0.0.1:{port}{CALLBACK_PATH}"),
        },
        listener,
    ))
}

/// Constant-time equality for secrets of public length.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

/// Waits for one valid callback and returns the authorization code.
/// Consumes the listener, so the port closes on every exit path.
pub async fn wait_for_code(
    listener: TcpListener,
    expected_state: &str,
    timeout: Duration,
) -> Result<String, AppError> {
    tokio::time::timeout(timeout, accept_loop(&listener, expected_state))
        .await
        .map_err(|_| AppError::Timeout)?
}

async fn accept_loop(listener: &TcpListener, expected_state: &str) -> Result<String, AppError> {
    loop {
        let (mut stream, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => continue,
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let Some(target) = read_target(&mut stream).await else {
            respond(&mut stream, "400 Bad Request", PAGE_ERROR).await;
            continue;
        };
        let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
            respond(&mut stream, "400 Bad Request", PAGE_ERROR).await;
            continue;
        };
        if url.path() != CALLBACK_PATH {
            respond(&mut stream, "404 Not Found", PAGE_NOT_FOUND).await;
            continue;
        }
        let outcome = interpret(&url, expected_state);
        let page = match &outcome {
            Ok(_) => PAGE_OK,
            Err(_) => PAGE_ERROR,
        };
        respond(&mut stream, "200 OK", page).await;
        return outcome;
    }
}

fn interpret(url: &Url, expected_state: &str) -> Result<String, AppError> {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (k, v) in url.query_pairs() {
        let slot = match k.as_ref() {
            "code" => &mut code,
            "state" => &mut state,
            "error" => &mut error,
            _ => continue,
        };
        if slot.replace(v.into_owned()).is_some() {
            return Err(AppError::Protocol(
                "duplicate callback parameter".to_string(),
            ));
        }
    }
    match state {
        Some(s) if constant_time_eq(s.as_bytes(), expected_state.as_bytes()) => {}
        _ => return Err(AppError::Protocol("callback state mismatch".to_string())),
    }
    if error.is_some() {
        return Err(AppError::Denied);
    }
    match code {
        Some(c) if !c.is_empty() => Ok(c),
        _ => Err(AppError::Protocol("callback had no code".to_string())),
    }
}

/// Reads the request head and returns the target of a `GET`.
async fn read_target(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let read = async {
        let mut chunk = [0u8; 1024];
        loop {
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(2).any(|w| w == b"\r\n") {
                return Some(());
            }
            if buf.len() > MAX_REQUEST_BYTES {
                return None;
            }
        }
    };
    tokio::time::timeout(READ_TIMEOUT, read).await.ok()??;
    let line_end = buf.windows(2).position(|w| w == b"\r\n")?;
    let line = std::str::from_utf8(&buf[..line_end]).ok()?;
    let mut parts = line.split(' ');
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    target.starts_with('/').then(|| target.to_string())
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
}

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>wardby viewer</title>\
<style>body{font:16px system-ui;margin:4rem auto;max-width:28rem;text-align:center}</style>\
<h1>Signed in</h1><p>You can close this tab and return to wardby viewer.</p>";
const PAGE_ERROR: &str = "<!doctype html><meta charset=utf-8><title>wardby viewer</title>\
<style>body{font:16px system-ui;margin:4rem auto;max-width:28rem;text-align:center}</style>\
<h1>Sign-in did not complete</h1><p>Return to wardby viewer and try again.</p>";
const PAGE_NOT_FOUND: &str =
    "<!doctype html><meta charset=utf-8><title>Not found</title><p>Not found.</p>";

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(addr: std::net::SocketAddr, target: &str) -> String {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    async fn start(
        state: &'static str,
        timeout: Duration,
    ) -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<Result<String, AppError>>,
        Callback,
    ) {
        let (cb, listener) = bind().await.unwrap();
        let addr = listener.local_addr().unwrap();
        let h = tokio::spawn(wait_for_code(listener, state, timeout));
        (addr, h, cb)
    }

    #[tokio::test]
    async fn binds_loopback_and_reports_redirect() {
        let (cb, l) = bind().await.unwrap();
        let addr = l.local_addr().unwrap();
        assert!(addr.ip().is_loopback());
        assert_eq!(
            cb.redirect_uri,
            format!("http://127.0.0.1:{}/callback", addr.port())
        );
    }

    #[tokio::test]
    async fn success_returns_code_and_serves_page() {
        let (addr, h, _) = start("st4te", Duration::from_secs(5)).await;
        let resp = get(addr, "/callback?code=abc%20123&state=st4te").await;
        assert!(resp.starts_with("HTTP/1.1 200"));
        assert!(resp.contains("Signed in"));
        assert_eq!(h.await.unwrap().unwrap(), "abc 123");
    }

    #[tokio::test]
    async fn ignores_other_paths_then_accepts_callback() {
        let (addr, h, _) = start("s", Duration::from_secs(5)).await;
        assert!(get(addr, "/favicon.ico").await.starts_with("HTTP/1.1 404"));
        assert!(
            get(addr, "/other?code=x&state=s")
                .await
                .starts_with("HTTP/1.1 404")
        );
        get(addr, "/callback?code=good&state=s").await;
        assert_eq!(h.await.unwrap().unwrap(), "good");
    }

    #[tokio::test]
    async fn wrong_state_is_a_protocol_error_without_leaking_values() {
        let (addr, h, _) = start("right", Duration::from_secs(5)).await;
        let resp = get(addr, "/callback?code=secretcode&state=wrong").await;
        assert!(!resp.contains("secretcode"));
        let err = h.await.unwrap().unwrap_err();
        assert!(matches!(err, AppError::Protocol(_)));
        let msg = err.to_string();
        assert!(!msg.contains("secretcode") && !msg.contains("right") && !msg.contains("wrong"));
    }

    #[tokio::test]
    async fn missing_state_is_rejected() {
        let (addr, h, _) = start("s", Duration::from_secs(5)).await;
        get(addr, "/callback?code=c").await;
        assert!(matches!(h.await.unwrap(), Err(AppError::Protocol(_))));
    }

    #[tokio::test]
    async fn access_denied_maps_to_denied() {
        let (addr, h, _) = start("s", Duration::from_secs(5)).await;
        get(addr, "/callback?error=access_denied&state=s").await;
        assert!(matches!(h.await.unwrap(), Err(AppError::Denied)));
    }

    #[tokio::test]
    async fn duplicate_params_are_rejected() {
        let (addr, h, _) = start("s", Duration::from_secs(5)).await;
        get(addr, "/callback?code=a&code=b&state=s").await;
        assert!(matches!(h.await.unwrap(), Err(AppError::Protocol(_))));
    }

    #[tokio::test]
    async fn non_get_is_ignored() {
        let (addr, h, _) = start("s", Duration::from_secs(5)).await;
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(b"POST /callback?code=x&state=s HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 400"));
        get(addr, "/callback?code=ok&state=s").await;
        assert_eq!(h.await.unwrap().unwrap(), "ok");
    }

    #[tokio::test]
    async fn times_out_and_closes_port() {
        let (addr, h, _) = start("s", Duration::from_millis(150)).await;
        assert!(matches!(h.await.unwrap(), Err(AppError::Timeout)));
        assert!(TcpStream::connect(addr).await.is_err());
    }

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
