//! Live, read-only watches of one namespace, one task per kind, turned into
//! the frames the Infrastructure tab consumes.

use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::BoxStream;
use futures_util::{Stream, StreamExt};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Event, Namespace, Pod, Secret, Service, ServiceAccount};
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use kube::api::{Api, DynamicObject, ListParams};
use kube::core::PartialObjectMeta;
use kube::discovery::Discovery;
use kube::runtime::WatchStreamExt;
use kube::runtime::watcher::{self, watcher};
use serde::Serialize;
use serde_json::Value;

use crate::cluster::errors::ClusterError;
use crate::cluster::model::{self, InfraEvent};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClusterFrame {
    /// Full list for one kind (sent on start and after any watch restart).
    Snapshot {
        kind: Kind,
        items: Vec<serde_json::Value>,
    },
    Applied {
        kind: Kind,
        item: serde_json::Value,
    },
    Deleted {
        kind: Kind,
        name: String,
    },
    /// A kind could not be watched (e.g. forbidden); the rest keep going.
    KindError {
        kind: Kind,
        error: ClusterError,
    },
    Status {
        connected: bool,
        error: Option<ClusterError>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Pod,
    Deployment,
    Job,
    Service,
    ServiceAccount,
    NetworkPolicy,
    Ingress,
    Gateway,
    HttpRoute,
    BackendPolicy,
    SecretStore,
    ExternalSecret,
    Secret,
}

impl Kind {
    pub const ALL: [Kind; 13] = [
        Kind::Pod,
        Kind::Deployment,
        Kind::Job,
        Kind::Service,
        Kind::ServiceAccount,
        Kind::NetworkPolicy,
        Kind::Ingress,
        Kind::Gateway,
        Kind::HttpRoute,
        Kind::BackendPolicy,
        Kind::SecretStore,
        Kind::ExternalSecret,
        Kind::Secret,
    ];
}

/// One stream of watch events per kind; production wraps `kube::runtime::watcher`.
pub enum WatchEvent {
    /// The full list after a (re)start of the watch.
    Restarted(Vec<serde_json::Value>),
    Applied(serde_json::Value),
    Deleted(String),
}

pub type WatchStream = BoxStream<'static, Result<WatchEvent, ClusterError>>;

#[async_trait::async_trait]
pub trait ClusterSource: Send + Sync + 'static {
    async fn namespace_exists(&self, ns: &str) -> Result<(), ClusterError>;
    /// None when the kind's CRD is not installed (gateways, httproutes, gcpbackendpolicies, secretstores, externalsecrets).
    async fn watch(&self, kind: Kind, ns: &str) -> Result<Option<WatchStream>, ClusterError>;
}

type Emit = Arc<dyn Fn(ClusterFrame) + Send + Sync>;

/// Checks the namespace, reports `Status`, then watches every kind in its own
/// task. The children live in a `JoinSet` owned by the returned task, so
/// aborting the handle drops (and so aborts) every watch.
pub fn spawn_cluster(
    source: Arc<dyn ClusterSource>,
    ns: String,
    emit: impl Fn(ClusterFrame) + Send + Sync + 'static,
) -> tokio::task::JoinHandle<()> {
    let emit: Emit = Arc::new(emit);
    tokio::spawn(async move {
        if let Err(error) = source.namespace_exists(&ns).await {
            emit(ClusterFrame::Status {
                connected: false,
                error: Some(error),
            });
            return;
        }
        emit(ClusterFrame::Status {
            connected: true,
            error: None,
        });
        let mut children = tokio::task::JoinSet::new();
        for kind in Kind::ALL {
            children.spawn(watch_kind(source.clone(), kind, ns.clone(), emit.clone()));
        }
        while children.join_next().await.is_some() {}
    })
}

/// Backoff between recreating a failed watch (short under test).
const RESTART_MIN: Duration = if cfg!(test) {
    Duration::from_millis(1)
} else {
    Duration::from_secs(1)
};
const RESTART_MAX: Duration = if cfg!(test) {
    Duration::from_millis(8)
} else {
    Duration::from_secs(30)
};

/// Watches one kind. kube's watcher resumes after a watch error without a
/// fresh list, so when it is healthy again nothing says so (and a quiet
/// namespace sends no frame at all). Instead, a failed watch is dropped and
/// recreated with backoff: its initial list arrives as a `Snapshot`, which
/// tells the UI the kind recovered.
async fn watch_kind(source: Arc<dyn ClusterSource>, kind: Kind, ns: String, emit: Emit) {
    // Report each distinct failure once until the watch recovers.
    let mut last_error: Option<ClusterError> = None;
    let mut delay = RESTART_MIN;
    loop {
        let mut stream = match source.watch(kind, &ns).await {
            Ok(Some(s)) => s,
            Ok(None) => {
                emit(ClusterFrame::Snapshot {
                    kind,
                    items: Vec::new(),
                });
                return;
            }
            Err(error) => {
                emit(ClusterFrame::KindError { kind, error });
                return;
            }
        };
        let started = tokio::time::Instant::now();
        let mut failed = false;
        while let Some(item) = stream.next().await {
            match item {
                Ok(ev) => {
                    last_error = None;
                    emit(match ev {
                        WatchEvent::Restarted(items) => ClusterFrame::Snapshot { kind, items },
                        WatchEvent::Applied(item) => ClusterFrame::Applied { kind, item },
                        WatchEvent::Deleted(name) => ClusterFrame::Deleted { kind, name },
                    });
                }
                Err(error) => {
                    if last_error.as_ref() != Some(&error) {
                        last_error = Some(error.clone());
                        emit(ClusterFrame::KindError { kind, error });
                    }
                    failed = true;
                    break;
                }
            }
        }
        if !failed {
            return;
        }
        drop(stream);
        // A watch that stayed up a while starts the backoff over.
        if started.elapsed() >= RESTART_MAX {
            delay = RESTART_MIN;
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(RESTART_MAX);
    }
}

// ---- production source ------------------------------------------------------

/// The production `ClusterSource`: list/watch/get only, through the user's own
/// credentials. Secrets are watched as metadata only.
pub struct KubeSource {
    client: kube::Client,
}

impl KubeSource {
    pub fn new(client: kube::Client) -> Self {
        Self { client }
    }

    fn typed<K>(&self, ns: &str, resource: &'static str, reduce: fn(&K) -> Value) -> WatchStream
    where
        K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
            + Clone
            + serde::de::DeserializeOwned
            + std::fmt::Debug
            + Send
            + 'static,
        K::DynamicType: Default,
    {
        let api = Api::<K>::namespaced(self.client.clone(), ns);
        adapt(
            watcher(api, watcher::Config::default()).default_backoff(),
            resource,
            ns,
            reduce,
        )
    }

    /// A CRD-backed kind at the version the cluster prefers; `None` when the
    /// group or kind is not installed.
    async fn dynamic(
        &self,
        ns: &str,
        (group, kind, resource): (&'static str, &'static str, &'static str),
        reduce: fn(&DynamicObject) -> Value,
    ) -> Result<Option<WatchStream>, ClusterError> {
        let discovery = Discovery::new(self.client.clone())
            .filter(&[group])
            .run()
            .await
            .map_err(|e| ClusterError::from_api(&e, resource, ns))?;
        let Some((ar, _caps)) = discovery.get(group).and_then(|g| g.recommended_kind(kind)) else {
            return Ok(None);
        };
        let api = Api::<DynamicObject>::namespaced_with(self.client.clone(), ns, &ar);
        Ok(Some(adapt(
            watcher(api, watcher::Config::default()).default_backoff(),
            resource,
            ns,
            reduce,
        )))
    }
}

const GATEWAY: (&str, &str, &str) = ("gateway.networking.k8s.io", "Gateway", "gateways");
const HTTP_ROUTE: (&str, &str, &str) = ("gateway.networking.k8s.io", "HTTPRoute", "httproutes");
const BACKEND_POLICY: (&str, &str, &str) = (
    "networking.gke.io",
    "GCPBackendPolicy",
    "gcpbackendpolicies",
);
const SECRET_STORE: (&str, &str, &str) = ("external-secrets.io", "SecretStore", "secretstores");
const EXTERNAL_SECRET: (&str, &str, &str) =
    ("external-secrets.io", "ExternalSecret", "externalsecrets");

fn val<T: Serialize>(t: T) -> Value {
    serde_json::to_value(t).unwrap_or(Value::Null)
}

/// A Service, plus its load-balancer edge (`null` unless `type: LoadBalancer`).
fn service_value(s: &Service) -> Value {
    let mut v = val(model::service_from(s));
    v["edge"] = val(model::edge_from_service(s));
    v
}

#[async_trait::async_trait]
impl ClusterSource for KubeSource {
    async fn namespace_exists(&self, ns: &str) -> Result<(), ClusterError> {
        match Api::<Namespace>::all(self.client.clone()).get(ns).await {
            Ok(_) => Ok(()),
            // Many users may not get namespaces; the per-kind watches report.
            Err(kube::Error::Api(s)) if s.code == 403 => Ok(()),
            Err(e) => Err(ClusterError::from_api(&e, "namespace", ns)),
        }
    }

    async fn watch(&self, kind: Kind, ns: &str) -> Result<Option<WatchStream>, ClusterError> {
        Ok(Some(match kind {
            Kind::Pod => self.typed::<Pod>(ns, "pods", |o| val(model::pod_from(o))),
            Kind::Deployment => {
                self.typed::<Deployment>(ns, "deployments", |o| val(model::deployment_from(o)))
            }
            Kind::Job => self.typed::<Job>(ns, "jobs", |o| val(model::job_from(o))),
            Kind::Service => self.typed::<Service>(ns, "services", service_value),
            Kind::ServiceAccount => self.typed::<ServiceAccount>(ns, "serviceaccounts", |o| {
                val(model::service_account_from(o))
            }),
            Kind::NetworkPolicy => self.typed::<NetworkPolicy>(ns, "networkpolicies", |o| {
                val(model::network_policy_from(o))
            }),
            Kind::Ingress => {
                self.typed::<Ingress>(ns, "ingresses", |o| val(model::ingress_from(o)))
            }
            // Metadata only: `Api<PartialObjectMeta<_>>` lists and watches
            // with metadata-only requests, so a Secret's data is never fetched.
            Kind::Secret => {
                let api = Api::<PartialObjectMeta<Secret>>::namespaced(self.client.clone(), ns);
                adapt(
                    watcher(api, watcher::Config::default()).default_backoff(),
                    "secrets",
                    ns,
                    |o| val(model::secret_name_from(o)),
                )
            }
            Kind::Gateway => {
                return self
                    .dynamic(ns, GATEWAY, |o| {
                        val(model::edge_from_dynamic("gateway", &val(o)))
                    })
                    .await;
            }
            Kind::HttpRoute => {
                return self
                    .dynamic(ns, HTTP_ROUTE, |o| {
                        val(model::edge_from_dynamic("httproute", &val(o)))
                    })
                    .await;
            }
            Kind::BackendPolicy => {
                return self
                    .dynamic(ns, BACKEND_POLICY, |o| {
                        val(model::backend_policy_from(&val(o)))
                    })
                    .await;
            }
            Kind::SecretStore => {
                return self
                    .dynamic(ns, SECRET_STORE, |o| val(model::secret_store_from(&val(o))))
                    .await;
            }
            Kind::ExternalSecret => {
                return self
                    .dynamic(ns, EXTERNAL_SECRET, |o| {
                        val(model::external_secret_from(&val(o)))
                    })
                    .await;
            }
        }))
    }
}

// ---- pod events ---------------------------------------------------------------

const POD_EVENTS: usize = 20;

/// A DNS-1123 subdomain (pod names) or label (`label_only`, namespaces), so a
/// name can never reshape the request path or the field selector.
pub fn valid_name(name: &str, label_only: bool) -> bool {
    let max = if label_only { 63 } else { 253 };
    !name.is_empty()
        && name.len() <= max
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || (!label_only && b == b'.')
        })
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name.ends_with(|c: char| c.is_ascii_alphanumeric())
}

pub fn check_namespace(ns: &str) -> Result<(), ClusterError> {
    if valid_name(ns, true) {
        Ok(())
    } else {
        Err(ClusterError::Other {
            message: "invalid namespace name".to_string(),
        })
    }
}

/// The namespace and pod name are safe to put in a request.
pub fn check_pod_target(ns: &str, pod: &str) -> Result<(), ClusterError> {
    check_namespace(ns)?;
    if valid_name(pod, false) {
        Ok(())
    } else {
        Err(ClusterError::Other {
            message: "invalid pod name".to_string(),
        })
    }
}

/// The newest `POD_EVENTS` events, newest first.
fn newest_events(mut events: Vec<Event>) -> Vec<InfraEvent> {
    let at = |e: &Event| {
        e.last_timestamp
            .as_ref()
            .map(|t| t.0)
            .or_else(|| e.event_time.as_ref().map(|t| t.0))
            .or_else(|| e.metadata.creation_timestamp.as_ref().map(|t| t.0))
    };
    events.sort_by_key(|e| std::cmp::Reverse(at(e)));
    events
        .iter()
        .take(POD_EVENTS)
        .map(model::event_from)
        .collect()
}

/// The recent events for one pod (a single read-only list).
pub async fn pod_events(
    client: kube::Client,
    ns: &str,
    pod: &str,
) -> Result<Vec<InfraEvent>, ClusterError> {
    check_pod_target(ns, pod)?;
    let lp = ListParams::default().fields(&format!(
        "involvedObject.kind=Pod,involvedObject.name={pod}"
    ));
    let list = Api::<Event>::namespaced(client, ns)
        .list(&lp)
        .await
        .map_err(|e| ClusterError::from_api(&e, "events", ns))?;
    Ok(newest_events(list.items))
}

/// Turns a `kube` watcher stream into `WatchEvent`s: `Init`..`InitDone` is
/// buffered into one `Restarted`, `Apply`/`Delete` pass through reduced, and
/// errors are mapped for `resource`. A 410 (expired resource version) is
/// dropped: the watcher relists on its own and a fresh `Restarted` follows.
fn adapt<K, S>(stream: S, resource: &'static str, ns: &str, reduce: fn(&K) -> Value) -> WatchStream
where
    K: kube::Resource + Send + 'static,
    S: Stream<Item = Result<watcher::Event<K>, watcher::Error>> + Send + 'static,
{
    use kube::ResourceExt;
    use watcher::Event as E;
    let ns = ns.to_string();
    stream
        .scan(None::<Vec<Value>>, move |buffer, item| {
            let out = match item {
                Ok(E::Init) => {
                    *buffer = Some(Vec::new());
                    None
                }
                Ok(E::InitApply(o)) => {
                    buffer.get_or_insert_with(Vec::new).push(reduce(&o));
                    None
                }
                Ok(E::InitDone) => {
                    Some(Ok(WatchEvent::Restarted(buffer.take().unwrap_or_default())))
                }
                Ok(E::Apply(o)) => Some(Ok(WatchEvent::Applied(reduce(&o)))),
                Ok(E::Delete(o)) => Some(Ok(WatchEvent::Deleted(o.name_any()))),
                Err(e) => watch_error(&e, resource, &ns).map(Err),
            };
            futures_util::future::ready(Some(out))
        })
        .filter_map(futures_util::future::ready)
        .boxed()
}

fn watch_error(e: &watcher::Error, resource: &str, ns: &str) -> Option<ClusterError> {
    use watcher::Error as W;
    match e {
        W::InitialListFailed(k) | W::WatchStartFailed(k) | W::WatchFailed(k) => {
            Some(ClusterError::from_api(k, resource, ns))
        }
        W::WatchError(s) if s.code == 410 => None,
        W::WatchError(s) if s.code == 403 => Some(ClusterError::Forbidden {
            resource: resource.to_string(),
        }),
        W::WatchError(s) => Some(ClusterError::Other {
            message: format!("watching {resource} failed: {}", s.message),
        }),
        W::NoResourceVersion => Some(ClusterError::Other {
            message: format!("{resource} cannot be watched"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    type Segments = VecDeque<Vec<Result<WatchEvent, ClusterError>>>;

    #[derive(Default)]
    struct FakeSource {
        namespace: Option<ClusterError>,
        events: Mutex<HashMap<Kind, Vec<Result<WatchEvent, ClusterError>>>>,
        watch_errors: HashMap<Kind, ClusterError>,
        absent: HashSet<Kind>,
        /// Kinds whose stream never ends; the flag is set when it is dropped.
        hang: HashMap<Kind, Arc<AtomicBool>>,
        /// One stream per `watch` call, in order (a recreated watch takes the next).
        restarts: Mutex<HashMap<Kind, Segments>>,
        watch_calls: Mutex<HashMap<Kind, usize>>,
    }

    struct SetOnDrop(Arc<AtomicBool>);
    impl Drop for SetOnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[async_trait::async_trait]
    impl ClusterSource for FakeSource {
        async fn namespace_exists(&self, _ns: &str) -> Result<(), ClusterError> {
            match &self.namespace {
                Some(e) => Err(e.clone()),
                None => Ok(()),
            }
        }
        async fn watch(&self, kind: Kind, _ns: &str) -> Result<Option<WatchStream>, ClusterError> {
            *self.watch_calls.lock().unwrap().entry(kind).or_default() += 1;
            if let Some(e) = self.watch_errors.get(&kind) {
                return Err(e.clone());
            }
            if let Some(evs) = self
                .restarts
                .lock()
                .unwrap()
                .get_mut(&kind)
                .and_then(VecDeque::pop_front)
            {
                return Ok(Some(futures_util::stream::iter(evs).boxed()));
            }
            if self.absent.contains(&kind) {
                return Ok(None);
            }
            if let Some(flag) = self.hang.get(&kind) {
                let guard = SetOnDrop(flag.clone());
                let s = futures_util::stream::once(async move {
                    let _guard = guard;
                    futures_util::future::pending::<Result<WatchEvent, ClusterError>>().await
                });
                return Ok(Some(s.boxed()));
            }
            let evs = self
                .events
                .lock()
                .unwrap()
                .remove(&kind)
                .unwrap_or_default();
            Ok(Some(futures_util::stream::iter(evs).boxed()))
        }
    }

    type Frames = Arc<Mutex<Vec<ClusterFrame>>>;

    async fn run(source: FakeSource) -> Vec<ClusterFrame> {
        let frames: Frames = Arc::default();
        let sink = frames.clone();
        let handle = spawn_cluster(Arc::new(source), "wardby".into(), move |f| {
            sink.lock().unwrap().push(f)
        });
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("cluster task did not finish")
            .unwrap();
        frames.lock().unwrap().clone()
    }

    fn of_kind(frames: &[ClusterFrame], kind: Kind) -> Vec<ClusterFrame> {
        frames
            .iter()
            .filter(|f| match f {
                ClusterFrame::Snapshot { kind: k, .. }
                | ClusterFrame::Applied { kind: k, .. }
                | ClusterFrame::Deleted { kind: k, .. }
                | ClusterFrame::KindError { kind: k, .. } => *k == kind,
                ClusterFrame::Status { .. } => false,
            })
            .cloned()
            .collect()
    }

    fn forbidden(resource: &str) -> ClusterError {
        ClusterError::Forbidden {
            resource: resource.into(),
        }
    }

    #[tokio::test]
    async fn emits_status_then_per_kind_frames() {
        let source = FakeSource::default();
        source.events.lock().unwrap().insert(
            Kind::Pod,
            vec![
                Ok(WatchEvent::Restarted(vec![json!({"name": "p1"})])),
                Ok(WatchEvent::Applied(json!({"name": "p2"}))),
                Ok(WatchEvent::Deleted("p1".into())),
            ],
        );
        let frames = run(source).await;
        assert_eq!(
            frames[0],
            ClusterFrame::Status {
                connected: true,
                error: None
            }
        );
        assert_eq!(
            of_kind(&frames, Kind::Pod),
            vec![
                ClusterFrame::Snapshot {
                    kind: Kind::Pod,
                    items: vec![json!({"name": "p1"})]
                },
                ClusterFrame::Applied {
                    kind: Kind::Pod,
                    item: json!({"name": "p2"})
                },
                ClusterFrame::Deleted {
                    kind: Kind::Pod,
                    name: "p1".into()
                },
            ]
        );
    }

    #[tokio::test]
    async fn forbidden_secrets_do_not_stop_other_kinds() {
        let mut source = FakeSource::default();
        source
            .watch_errors
            .insert(Kind::Secret, forbidden("secrets"));
        source.events.lock().unwrap().insert(
            Kind::Pod,
            vec![Ok(WatchEvent::Restarted(vec![json!({"name": "p1"})]))],
        );
        let frames = run(source).await;
        assert_eq!(
            of_kind(&frames, Kind::Secret),
            vec![ClusterFrame::KindError {
                kind: Kind::Secret,
                error: forbidden("secrets")
            }]
        );
        assert_eq!(
            of_kind(&frames, Kind::Pod),
            vec![ClusterFrame::Snapshot {
                kind: Kind::Pod,
                items: vec![json!({"name": "p1"})]
            }]
        );
    }

    #[tokio::test]
    async fn missing_crd_is_an_empty_snapshot() {
        let mut source = FakeSource::default();
        source.absent.insert(Kind::Gateway);
        let frames = run(source).await;
        assert_eq!(
            of_kind(&frames, Kind::Gateway),
            vec![ClusterFrame::Snapshot {
                kind: Kind::Gateway,
                items: vec![]
            }]
        );
    }

    #[tokio::test]
    async fn unknown_namespace_stops_with_status_error() {
        let source = FakeSource {
            namespace: Some(ClusterError::NamespaceNotFound {
                namespace: "wardby".into(),
            }),
            ..Default::default()
        };
        let frames = run(source).await;
        assert_eq!(
            frames,
            vec![ClusterFrame::Status {
                connected: false,
                error: Some(ClusterError::NamespaceNotFound {
                    namespace: "wardby".into()
                })
            }]
        );
    }

    #[tokio::test]
    async fn a_repeated_stream_error_is_reported_once_until_it_recovers() {
        let source = FakeSource::default();
        source.restarts.lock().unwrap().insert(
            Kind::Job,
            VecDeque::from([
                vec![Err(forbidden("jobs"))],
                vec![Err(forbidden("jobs"))],
                vec![Ok(WatchEvent::Restarted(vec![])), Err(forbidden("jobs"))],
            ]),
        );
        let frames = run(source).await;
        let err = ClusterFrame::KindError {
            kind: Kind::Job,
            error: forbidden("jobs"),
        };
        assert_eq!(
            of_kind(&frames, Kind::Job),
            vec![
                err.clone(),
                ClusterFrame::Snapshot {
                    kind: Kind::Job,
                    items: vec![]
                },
                err
            ]
        );
    }

    #[tokio::test]
    async fn a_failed_watch_is_recreated_so_recovery_relists() {
        // kube's watcher resumes after a watch error without a fresh list, so
        // a quiet namespace would never show that it recovered: recreate it.
        let source = Arc::new(FakeSource::default());
        source.restarts.lock().unwrap().insert(
            Kind::Pod,
            VecDeque::from([
                vec![
                    Ok(WatchEvent::Restarted(vec![json!({"name": "p1"})])),
                    Err(ClusterError::Unreachable {
                        message: "connection refused".into(),
                    }),
                    // Never delivered: the failed stream is dropped.
                    Ok(WatchEvent::Applied(json!({"name": "stale"}))),
                ],
                vec![Ok(WatchEvent::Restarted(vec![json!({"name": "p1"})]))],
            ]),
        );
        let frames: Frames = Arc::default();
        let sink = frames.clone();
        let handle = spawn_cluster(source.clone(), "wardby".into(), move |f| {
            sink.lock().unwrap().push(f)
        });
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("cluster task did not finish")
            .unwrap();
        let snapshot = ClusterFrame::Snapshot {
            kind: Kind::Pod,
            items: vec![json!({"name": "p1"})],
        };
        assert_eq!(
            of_kind(&frames.lock().unwrap(), Kind::Pod),
            vec![
                snapshot.clone(),
                ClusterFrame::KindError {
                    kind: Kind::Pod,
                    error: ClusterError::Unreachable {
                        message: "connection refused".into()
                    }
                },
                snapshot
            ]
        );
        // Recreated once; the second stream ended cleanly.
        assert_eq!(source.watch_calls.lock().unwrap()[&Kind::Pod], 2);
    }

    #[tokio::test]
    async fn aborting_the_handle_stops_every_kind() {
        let flags: Vec<_> = (0..2).map(|_| Arc::new(AtomicBool::new(false))).collect();
        let mut source = FakeSource::default();
        source.hang.insert(Kind::Pod, flags[0].clone());
        source.hang.insert(Kind::Secret, flags[1].clone());
        let handle = spawn_cluster(Arc::new(source), "wardby".into(), |_| {});
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!handle.is_finished(), "watches should still be running");
        assert!(flags.iter().all(|f| !f.load(Ordering::SeqCst)));
        handle.abort();
        let _ = handle.await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while !flags.iter().all(|f| f.load(Ordering::SeqCst)) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("child watches were not stopped");
    }

    // ---- the kube watcher adapter --------------------------------------------

    fn pod(name: &str) -> Pod {
        serde_json::from_value(json!({"metadata": {"name": name}})).unwrap()
    }

    fn name_only(p: &Pod) -> Value {
        json!({ "name": p.metadata.name })
    }

    fn api_error(code: u16) -> kube::Error {
        kube::Error::Api(
            kube::core::Status {
                code,
                ..Default::default()
            }
            .boxed(),
        )
    }

    async fn adapted(
        items: Vec<Result<watcher::Event<Pod>, watcher::Error>>,
    ) -> Vec<Result<WatchEvent, ClusterError>> {
        adapt(
            futures_util::stream::iter(items),
            "pods",
            "wardby",
            name_only,
        )
        .collect()
        .await
    }

    fn describe(r: &Result<WatchEvent, ClusterError>) -> String {
        match r {
            Ok(WatchEvent::Restarted(v)) => format!("restarted {}", Value::from(v.clone())),
            Ok(WatchEvent::Applied(v)) => format!("applied {v}"),
            Ok(WatchEvent::Deleted(n)) => format!("deleted {n}"),
            Err(e) => format!("error {e:?}"),
        }
    }

    #[tokio::test]
    async fn the_initial_list_is_buffered_into_one_restart() {
        use watcher::Event as E;
        let out = adapted(vec![
            Ok(E::Init),
            Ok(E::InitApply(pod("a"))),
            Ok(E::InitApply(pod("b"))),
            Ok(E::InitDone),
            Ok(E::Apply(pod("c"))),
            Ok(E::Delete(pod("a"))),
            Ok(E::Init),
            Ok(E::InitDone),
        ])
        .await;
        let got: Vec<_> = out.iter().map(describe).collect();
        assert_eq!(
            got,
            vec![
                r#"restarted [{"name":"a"},{"name":"b"}]"#,
                r#"applied {"name":"c"}"#,
                "deleted a",
                "restarted []",
            ]
        );
    }

    #[tokio::test]
    async fn watcher_errors_map_to_cluster_errors_and_410_is_silent() {
        let out = adapted(vec![
            Err(watcher::Error::InitialListFailed(api_error(403))),
            Err(watcher::Error::WatchError(
                kube::core::Status {
                    code: 410,
                    ..Default::default()
                }
                .boxed(),
            )),
            Err(watcher::Error::WatchFailed(kube::Error::Service(
                "connection refused".into(),
            ))),
        ])
        .await;
        assert_eq!(
            out.len(),
            2,
            "{:?}",
            out.iter().map(describe).collect::<Vec<_>>()
        );
        assert!(matches!(&out[0], Err(e) if *e == forbidden("pods")));
        assert!(matches!(&out[1], Err(ClusterError::Unreachable { .. })));
    }

    #[test]
    fn a_service_carries_its_load_balancer_edge() {
        let svc: Service = serde_json::from_value(json!({
            "metadata": {"name": "web"},
            "spec": {"type": "ClusterIP", "ports": [{"port": 80}]}
        }))
        .unwrap();
        let v = service_value(&svc);
        assert_eq!(v["name"], "web");
        assert!(v["edge"].is_null());
    }

    // ---- KubeSource against a fake API server ---------------------------------

    mod kube_source {
        use super::*;
        use wiremock::matchers::{header_regex, method, path, query_param, query_param_is_missing};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        fn source(server: &MockServer) -> KubeSource {
            let config = kube::Config::new(server.uri().parse().unwrap());
            KubeSource::new(kube::Client::try_from(config).unwrap())
        }

        async fn namespace_status(code: u16) -> Result<(), ClusterError> {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/api/v1/namespaces/wardby"))
                .respond_with(ResponseTemplate::new(code).set_body_json(json!({
                    "kind": "Status", "apiVersion": "v1", "status": "Failure", "code": code
                })))
                .mount(&server)
                .await;
            source(&server).namespace_exists("wardby").await
        }

        #[tokio::test]
        async fn a_forbidden_namespace_get_is_not_fatal_but_a_missing_one_is() {
            assert_eq!(namespace_status(403).await, Ok(()));
            assert_eq!(
                namespace_status(404).await,
                Err(ClusterError::NamespaceNotFound {
                    namespace: "wardby".into()
                })
            );
        }

        #[tokio::test]
        async fn secrets_are_listed_and_watched_as_metadata_only() {
            let server = MockServer::start().await;
            // Only metadata-only requests match; a full list or watch would 404.
            Mock::given(method("GET"))
                .and(path("/api/v1/namespaces/wardby/secrets"))
                .and(query_param("watch", "true"))
                .and(header_regex("accept", "as=PartialObjectMetadata;"))
                .respond_with(
                    ResponseTemplate::new(200).set_body_string(
                        json!({
                            "type": "ADDED",
                            "object": {
                                "kind": "PartialObjectMetadata",
                                "apiVersion": "meta.k8s.io/v1",
                                "metadata": {"name": "api-key", "resourceVersion": "2"}
                            }
                        })
                        .to_string()
                            + "\n",
                    ),
                )
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .and(path("/api/v1/namespaces/wardby/secrets"))
                .and(query_param_is_missing("watch"))
                .and(header_regex("accept", "as=PartialObjectMetadataList"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "kind": "PartialObjectMetadataList",
                    "apiVersion": "meta.k8s.io/v1",
                    "metadata": {"resourceVersion": "1"},
                    "items": [{"metadata": {"name": "db-password"}}]
                })))
                .mount(&server)
                .await;
            let mut stream = source(&server)
                .watch(Kind::Secret, "wardby")
                .await
                .unwrap()
                .unwrap();
            let mut next = async || {
                tokio::time::timeout(Duration::from_secs(5), stream.next())
                    .await
                    .unwrap()
                    .unwrap()
            };
            assert_eq!(
                describe(&next().await),
                r#"restarted [{"name":"db-password"}]"#
            );
            assert_eq!(describe(&next().await), r#"applied {"name":"api-key"}"#);
        }

        #[tokio::test]
        async fn an_uninstalled_crd_is_none() {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/apis"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "kind": "APIGroupList", "apiVersion": "v1", "groups": []
                })))
                .mount(&server)
                .await;
            let src = source(&server);
            for kind in [
                Kind::Gateway,
                Kind::HttpRoute,
                Kind::BackendPolicy,
                Kind::SecretStore,
                Kind::ExternalSecret,
            ] {
                assert!(
                    src.watch(kind, "wardby").await.unwrap().is_none(),
                    "{kind:?}"
                );
            }
        }
    }

    // ---- pod events -------------------------------------------------------------

    fn event(reason: &str, last: Option<&str>) -> Event {
        serde_json::from_value(json!({
            "metadata": {"name": reason},
            "involvedObject": {},
            "reason": reason,
            "lastTimestamp": last
        }))
        .unwrap()
    }

    #[test]
    fn pod_events_are_newest_first_and_capped() {
        let mut evs: Vec<Event> = (0..25)
            .map(|i| {
                event(
                    &format!("r{i:02}"),
                    Some(&format!("2026-10-03T10:00:{i:02}Z")),
                )
            })
            .collect();
        evs.push(event("undated", None));
        evs.swap(0, 24);
        let out = newest_events(evs);
        assert_eq!(out.len(), POD_EVENTS);
        assert_eq!(out[0].reason, "r24");
        assert_eq!(out[1].reason, "r23");
        assert_eq!(out[19].reason, "r05");
    }

    #[test]
    fn names_that_could_reshape_a_request_are_rejected() {
        assert!(valid_name("run-abc.123", false));
        assert!(valid_name("wardby", true));
        for bad in ["", "a,b", "a=b", "A", "a/b", "-a", "a-", "a b", "../x"] {
            assert!(!valid_name(bad, false), "{bad:?}");
        }
        assert!(!valid_name("a.b", true));
        assert!(!valid_name(&"a".repeat(64), true));
    }
}
