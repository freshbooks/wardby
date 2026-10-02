//! Reconnecting reader for the server's `/admin/api/events` SSE stream.

use std::sync::Arc;
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;

use crate::api::Session;
use crate::error::AppError;

#[derive(Debug)]
pub enum StreamFrame {
    Hello {
        connected: bool,
    },
    Status {
        connected: bool,
    },
    Resync,
    Event {
        kind: String,
        data: serde_json::Value,
    },
    Disconnected,
    Error(AppError),
}

#[derive(Clone, Debug)]
pub struct EventsConfig {
    pub default_retry: Duration,
    pub min_retry: Duration,
    pub max_backoff: Duration,
    pub idle_timeout: Duration,
}

impl Default for EventsConfig {
    fn default() -> Self {
        Self {
            default_retry: Duration::from_millis(3000),
            min_retry: Duration::from_millis(500),
            max_backoff: Duration::from_secs(30),
            idle_timeout: Duration::from_secs(45),
        }
    }
}

pub fn spawn_events(
    session: Arc<Session>,
    emit: impl Fn(StreamFrame) + Send + Sync + 'static,
) -> tokio::task::JoinHandle<()> {
    spawn_events_with(session, emit, EventsConfig::default())
}

pub fn spawn_events_with(
    session: Arc<Session>,
    emit: impl Fn(StreamFrame) + Send + Sync + 'static,
    cfg: EventsConfig,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run(session, emit, cfg))
}

/// Delay before reconnect number `failures` (0 = after a healthy stream that
/// simply ended): the server's `retry`, doubling per consecutive failure,
/// bounded below and above.
fn backoff(base: Duration, failures: u32, cfg: &EventsConfig) -> Duration {
    let factor = 1u32 << failures.saturating_sub(1).min(16);
    base.saturating_mul(factor)
        .max(cfg.min_retry)
        .min(cfg.max_backoff)
}

/// Why a connection attempt cannot be retried.
fn is_fatal(e: &AppError) -> bool {
    matches!(e, AppError::NotSignedIn | AppError::Http { status: 403 })
}

async fn connect(session: &Session, cfg: &EventsConfig) -> Result<reqwest::Response, AppError> {
    let url = session.url_for("/admin/api/events")?;
    let send = session.authed_send(|tok| {
        session
            .stream_client()
            .get(&url)
            .bearer_auth(tok)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .header(reqwest::header::CACHE_CONTROL, "no-store")
    });
    // The server sends headers and `hello` immediately, so silence here is a
    // dead connection just as it is mid-stream.
    let resp = tokio::time::timeout(cfg.idle_timeout, send)
        .await
        .map_err(|_| AppError::Network("request timed out".to_string()))??;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Http {
            status: status.as_u16(),
        });
    }
    Ok(resp)
}

/// Item error for the byte stream: either the transport failed or no bytes
/// (not even a ping) arrived for the idle timeout.
#[derive(Debug)]
struct StreamBroke;

impl std::fmt::Display for StreamBroke {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stream broke")
    }
}

impl std::error::Error for StreamBroke {}

/// Turns the response body into a byte stream that yields one error and ends
/// when the connection fails or goes quiet for `idle`.
fn idle_bytes(
    resp: reqwest::Response,
    idle: Duration,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, StreamBroke>> {
    let body: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = reqwest::Result<bytes::Bytes>> + Send>,
    > = Box::pin(resp.bytes_stream());
    futures_util::stream::unfold(Some(body), move |state| async move {
        let mut body = state?;
        match tokio::time::timeout(idle, body.next()).await {
            Ok(Some(Ok(b))) => Some((Ok(b), Some(body))),
            Ok(None) => None,
            Ok(Some(Err(_))) | Err(_) => Some((Err(StreamBroke), None)),
        }
    })
}

#[derive(serde::Deserialize)]
struct Connected {
    connected: bool,
}

fn frame_for(name: &str, data: &str) -> Option<StreamFrame> {
    match name {
        "hello" => serde_json::from_str::<Connected>(data)
            .ok()
            .map(|c| StreamFrame::Hello {
                connected: c.connected,
            }),
        "status" => serde_json::from_str::<Connected>(data)
            .ok()
            .map(|c| StreamFrame::Status {
                connected: c.connected,
            }),
        "resync" => Some(StreamFrame::Resync),
        "run" | "service" | "outcome" => {
            serde_json::from_str(data)
                .ok()
                .map(|data| StreamFrame::Event {
                    kind: name.to_string(),
                    data,
                })
        }
        // Unknown names (and malformed payloads above) are skipped so a newer
        // server never breaks an older viewer.
        _ => None,
    }
}

async fn run(
    session: Arc<Session>,
    emit: impl Fn(StreamFrame) + Send + Sync + 'static,
    cfg: EventsConfig,
) {
    let mut failures: u32 = 0;
    let mut server_retry: Option<Duration> = None;
    loop {
        match connect(&session, &cfg).await {
            Err(e) if is_fatal(&e) => {
                emit(StreamFrame::Error(e));
                return;
            }
            Err(e) => {
                failures = failures.saturating_add(1);
                emit(StreamFrame::Error(e));
            }
            Ok(resp) => {
                let mut events = Box::pin(idle_bytes(resp, cfg.idle_timeout).eventsource());
                let mut healthy = false;
                while let Some(item) = events.next().await {
                    let Ok(ev) = item else { break };
                    if let Some(r) = ev.retry {
                        server_retry = Some(r);
                    }
                    if let Some(frame) = frame_for(&ev.event, &ev.data) {
                        healthy = true;
                        emit(frame);
                    }
                }
                emit(StreamFrame::Disconnected);
                failures = if healthy {
                    0
                } else {
                    failures.saturating_add(1)
                };
            }
        }
        let base = server_retry.unwrap_or(cfg.default_retry);
        tokio::time::sleep(backoff(base, failures, &cfg)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_support::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn fast() -> EventsConfig {
        EventsConfig {
            default_retry: Duration::from_millis(20),
            min_retry: Duration::from_millis(5),
            max_backoff: Duration::from_millis(80),
            idle_timeout: Duration::from_millis(200),
        }
    }

    fn session(base: &str) -> Arc<Session> {
        Arc::new(
            Session::new(
                base,
                auth_for(base),
                "cid",
                MemStore::with("RT0"),
                Some(tokens("AT0")),
            )
            .unwrap(),
        )
    }

    type Frames = Arc<Mutex<Vec<String>>>;

    fn collector() -> (Frames, impl Fn(StreamFrame) + Send + Sync + 'static) {
        let frames: Frames = Arc::new(Mutex::new(Vec::new()));
        let f = frames.clone();
        (frames, move |fr: StreamFrame| {
            let label = match fr {
                StreamFrame::Hello { connected } => format!("hello:{connected}"),
                StreamFrame::Status { connected } => format!("status:{connected}"),
                StreamFrame::Resync => "resync".into(),
                StreamFrame::Event { kind, data } => format!("event:{kind}:{}", data["id"]),
                StreamFrame::Disconnected => "disconnected".into(),
                StreamFrame::Error(e) => format!("error:{}", e.kind()),
            };
            f.lock().unwrap().push(label);
        })
    }

    async fn wait_for(frames: &Frames, n: usize) -> Vec<String> {
        for _ in 0..200 {
            if frames.lock().unwrap().len() >= n {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        frames.lock().unwrap().clone()
    }

    const BODY: &str = "retry: 20\n\nevent: hello\ndata: {\"connected\":true}\n\n: ping\n\nevent: status\ndata: {\"connected\":true}\n\nevent: resync\ndata: {}\n\nid: 1\nevent: run\ndata: {\"id\":\"r1\"}\n\nevent: mystery\ndata: {}\n\n";

    #[tokio::test]
    async fn maps_frames_in_order_ignores_pings_and_reconnects_after_end() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/admin/api/events"))
            .and(header("authorization", "Bearer AT0"))
            .and(header("accept", "text/event-stream"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(BODY, "text/event-stream"))
            .mount(&s)
            .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&s.uri()), emit, fast());
        let got = wait_for(&frames, 10).await;
        h.abort();
        let expect = [
            "hello:true",
            "status:true",
            "resync",
            "event:run:\"r1\"",
            "disconnected",
        ];
        assert_eq!(got[..5], expect, "{got:?}");
        // A second connection delivered the same frames again.
        assert_eq!(got[5..10], expect, "{got:?}");
        assert!(s.received_requests().await.unwrap().len() >= 2);
    }

    #[tokio::test]
    async fn unauthorized_refreshes_once_then_streams() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("authorization", "Bearer AT0"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "AT1", "token_type": "Bearer", "refresh_token": "RT1"
            })))
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(header("authorization", "Bearer AT1"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(BODY, "text/event-stream"))
            .mount(&s)
            .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&s.uri()), emit, fast());
        let got = wait_for(&frames, 1).await;
        h.abort();
        assert_eq!(got[0], "hello:true");
    }

    #[tokio::test]
    async fn not_signed_in_ends_the_task() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400))
            .mount(&s)
            .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&s.uri()), emit, fast());
        tokio::time::timeout(Duration::from_secs(5), h)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(*frames.lock().unwrap(), ["error:not_signed_in"]);
    }

    #[tokio::test]
    async fn forbidden_ends_the_task() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&s)
            .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&s.uri()), emit, fast());
        tokio::time::timeout(Duration::from_secs(5), h)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(*frames.lock().unwrap(), ["error:http"]);
    }

    #[tokio::test]
    async fn server_errors_back_off_exponentially_up_to_the_cap() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&s)
            .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&s.uri()), emit, fast());
        // Delays 20,40,80,80,...: well over 4 attempts in 600 ms, but far fewer than
        // a fixed 5 ms floor would allow.
        tokio::time::sleep(Duration::from_millis(600)).await;
        h.abort();
        let n = s.received_requests().await.unwrap().len();
        assert!((4..=12).contains(&n), "attempts: {n}");
        assert!(frames.lock().unwrap().iter().all(|f| f == "error:http"));
    }

    #[tokio::test]
    async fn silent_stream_is_dropped_after_the_idle_timeout_and_reconnected() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let conns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c2 = conns.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = l.accept().await else {
                    return;
                };
                c2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
                    let chunk = "retry: 20\n\nevent: hello\ndata: {\"connected\":true}\n\n";
                    let _ = sock
                        .write_all(format!("{head}{:x}\r\n{chunk}\r\n", chunk.len()).as_bytes())
                        .await;
                    // Then go silent without closing.
                    tokio::time::sleep(Duration::from_secs(30)).await;
                });
            }
        });
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&base), emit, fast());
        let got = wait_for(&frames, 3).await;
        h.abort();
        assert_eq!(
            got[..3],
            ["hello:true", "disconnected", "hello:true"],
            "{got:?}"
        );
        assert!(conns.load(std::sync::atomic::Ordering::SeqCst) >= 2);
    }
}
