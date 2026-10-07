//! Reduces Kubernetes objects to the small, display-oriented structs the
//! Infrastructure tab shows. Everything here is pure. Secrets only ever arrive
//! as metadata (`PartialObjectMeta`); their data is never requested or read.

use std::collections::BTreeMap;

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{
    Container, ContainerState, ContainerStatus, Event, Pod, ResourceRequirements, Secret, Service,
    ServiceAccount,
};
use k8s_openapi::api::networking::v1::{
    Ingress, NetworkPolicy, NetworkPolicyPeer, NetworkPolicyPort,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::core::PartialObjectMeta;
use serde::Serialize;
use serde_json::Value;

const LABEL_PREFIXES: [&str; 2] = ["wardby.io/", "app.kubernetes.io/"];
const IDENTITY_KEYS: [&str; 3] = [
    "iam.gke.io/gcp-service-account",
    "eks.amazonaws.com/role-arn",
    "azure.workload.identity/client-id",
];
const EDGE_ANNOTATION_PREFIXES: [&str; 4] = [
    "networking.gke.io/",
    "cloud.google.com/",
    "alb.ingress.kubernetes.io/",
    "service.beta.kubernetes.io/aws-load-balancer-",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Resources {
    pub cpu: Option<String>,
    pub memory: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraContainer {
    pub name: String,
    pub role: &'static str,
    pub image: String,
    pub state: &'static str,
    pub reason: Option<String>,
    pub ready: bool,
    pub restarts: i32,
    pub requests: Resources,
    pub limits: Resources,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraPod {
    pub name: String,
    pub phase: String,
    pub labels: BTreeMap<String, String>,
    pub owner: Option<Owner>,
    pub node: Option<String>,
    pub runtime_class: Option<String>,
    pub service_account: Option<String>,
    pub started_at: Option<String>,
    pub ready: bool,
    pub containers: Vec<InfraContainer>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraDeployment {
    pub name: String,
    pub ready: i32,
    pub desired: i32,
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraJob {
    pub name: String,
    pub active: i32,
    pub succeeded: i32,
    pub failed: i32,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraService {
    pub name: String,
    pub service_type: String,
    pub ports: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraServiceAccount {
    pub name: String,
    pub identity: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraNetworkPolicy {
    pub name: String,
    pub pod_selector: BTreeMap<String, String>,
    pub policy_types: Vec<String>,
    pub egress: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraEdge {
    pub kind: &'static str,
    pub name: String,
    pub class: Option<String>,
    pub hosts: Vec<String>,
    pub annotations: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraSecretStore {
    pub name: String,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraExternalSecret {
    pub name: String,
    pub store: Option<String>,
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraSecretName {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InfraEvent {
    pub at: Option<String>,
    pub kind: String,
    pub reason: String,
    pub message: String,
}

// ---- shared helpers -------------------------------------------------------

fn name_of(meta: &ObjectMeta) -> String {
    meta.name.clone().unwrap_or_default()
}

fn wardby_labels(meta: &ObjectMeta) -> BTreeMap<String, String> {
    meta.labels
        .iter()
        .flatten()
        .filter(|(k, _)| LABEL_PREFIXES.iter().any(|p| k.starts_with(p)))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn annotations_where(meta: &ObjectMeta, keep: impl Fn(&str) -> bool) -> BTreeMap<String, String> {
    meta.annotations
        .iter()
        .flatten()
        .filter(|(k, _)| keep(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn edge_annotations(meta: &ObjectMeta) -> BTreeMap<String, String> {
    annotations_where(meta, |k| {
        EDGE_ANNOTATION_PREFIXES.iter().any(|p| k.starts_with(p))
    })
}

/// Keeps `repo/path:tag`; a digest reference becomes `repo/path@sha256:` plus
/// the first 12 hex characters and an ellipsis.
pub fn short_image(image: &str) -> String {
    match image.split_once("@sha256:") {
        Some((repo, hex)) => format!(
            "{repo}@sha256:{}…",
            hex.chars().take(12).collect::<String>()
        ),
        None => image.to_string(),
    }
}

fn time_string(t: &k8s_openapi::apimachinery::pkg::apis::meta::v1::Time) -> String {
    t.0.to_string()
}

// ---- pods -----------------------------------------------------------------

fn resources_of(res: Option<&ResourceRequirements>, limits: bool) -> Resources {
    let map = res.and_then(|r| {
        if limits {
            r.limits.as_ref()
        } else {
            r.requests.as_ref()
        }
    });
    let get = |key: &str| map.and_then(|m| m.get(key)).map(|q| q.0.clone());
    Resources {
        cpu: get("cpu"),
        memory: get("memory"),
    }
}

fn state_of(status: Option<&ContainerStatus>) -> (&'static str, Option<String>) {
    let Some(ContainerState {
        running,
        waiting,
        terminated,
    }) = status.and_then(|s| s.state.as_ref())
    else {
        return ("unknown", None);
    };
    if running.is_some() {
        ("running", None)
    } else if let Some(w) = waiting {
        ("waiting", w.reason.clone())
    } else if let Some(t) = terminated {
        ("terminated", t.reason.clone())
    } else {
        ("unknown", None)
    }
}

fn container_from(
    c: &Container,
    role: &'static str,
    statuses: &[ContainerStatus],
) -> InfraContainer {
    let status = statuses.iter().find(|s| s.name == c.name);
    let (state, reason) = state_of(status);
    InfraContainer {
        name: c.name.clone(),
        role,
        image: short_image(c.image.as_deref().unwrap_or_default()),
        state,
        reason,
        ready: status.is_some_and(|s| s.ready),
        restarts: status.map_or(0, |s| s.restart_count),
        requests: resources_of(c.resources.as_ref(), false),
        limits: resources_of(c.resources.as_ref(), true),
    }
}

fn is_sidecar(c: &Container) -> bool {
    c.restart_policy.as_deref() == Some("Always")
}

/// Init containers first, then sidecars, then the main containers.
fn containers_of(pod: &Pod) -> Vec<InfraContainer> {
    let spec = pod.spec.as_ref();
    let status = pod.status.as_ref();
    let init_statuses = status
        .and_then(|s| s.init_container_statuses.as_deref())
        .unwrap_or_default();
    let main_statuses = status
        .and_then(|s| s.container_statuses.as_deref())
        .unwrap_or_default();
    let init: &[Container] = spec
        .and_then(|s| s.init_containers.as_deref())
        .unwrap_or_default();
    let main: &[Container] = spec.map(|s| s.containers.as_slice()).unwrap_or_default();

    let inits = init
        .iter()
        .filter(|c| !is_sidecar(c))
        .map(|c| container_from(c, "init", init_statuses));
    let sidecars = init
        .iter()
        .filter(|c| is_sidecar(c))
        .map(|c| container_from(c, "sidecar", init_statuses));
    let mains = main
        .iter()
        .map(|c| container_from(c, "main", main_statuses));
    inits.chain(sidecars).chain(mains).collect()
}

fn pod_ready(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .is_some_and(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
}

pub fn pod_from(pod: &Pod) -> InfraPod {
    let spec = pod.spec.as_ref();
    let owner = pod
        .metadata
        .owner_references
        .iter()
        .flatten()
        .next()
        .map(|o| Owner {
            kind: o.kind.clone(),
            name: o.name.clone(),
        });
    InfraPod {
        name: name_of(&pod.metadata),
        phase: pod
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".into()),
        labels: wardby_labels(&pod.metadata),
        owner,
        node: spec.and_then(|s| s.node_name.clone()),
        runtime_class: spec.and_then(|s| s.runtime_class_name.clone()),
        service_account: spec.and_then(|s| s.service_account_name.clone()),
        started_at: pod
            .status
            .as_ref()
            .and_then(|s| s.start_time.as_ref())
            .map(time_string),
        ready: pod_ready(pod),
        containers: containers_of(pod),
    }
}

// ---- workloads ------------------------------------------------------------

pub fn deployment_from(d: &Deployment) -> InfraDeployment {
    InfraDeployment {
        name: name_of(&d.metadata),
        ready: d
            .status
            .as_ref()
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0),
        desired: d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1),
        labels: wardby_labels(&d.metadata),
    }
}

pub fn job_from(j: &Job) -> InfraJob {
    let status = j.status.as_ref();
    InfraJob {
        name: name_of(&j.metadata),
        active: status.and_then(|s| s.active).unwrap_or(0),
        succeeded: status.and_then(|s| s.succeeded).unwrap_or(0),
        failed: status.and_then(|s| s.failed).unwrap_or(0),
        started_at: status.and_then(|s| s.start_time.as_ref()).map(time_string),
        finished_at: status
            .and_then(|s| s.completion_time.as_ref())
            .map(time_string),
        labels: wardby_labels(&j.metadata),
    }
}

// ---- services and edges ---------------------------------------------------

fn int_or_string(v: &IntOrString) -> String {
    match v {
        IntOrString::Int(i) => i.to_string(),
        IntOrString::String(s) => s.clone(),
    }
}

pub fn service_from(s: &Service) -> InfraService {
    let spec = s.spec.as_ref();
    let ports = spec
        .and_then(|sp| sp.ports.as_ref())
        .into_iter()
        .flatten()
        .map(|p| {
            let proto = p.protocol.as_deref().unwrap_or("TCP");
            match &p.target_port {
                Some(t) => format!("{}/{proto}→{}", p.port, int_or_string(t)),
                None => format!("{}/{proto}", p.port),
            }
        })
        .collect();
    InfraService {
        name: name_of(&s.metadata),
        service_type: spec
            .and_then(|sp| sp.type_.clone())
            .unwrap_or_else(|| "ClusterIP".into()),
        ports,
    }
}

pub fn edge_from_service(s: &Service) -> Option<InfraEdge> {
    let spec = s.spec.as_ref()?;
    if spec.type_.as_deref() != Some("LoadBalancer") {
        return None;
    }
    let hosts = s
        .status
        .as_ref()
        .and_then(|st| st.load_balancer.as_ref())
        .and_then(|lb| lb.ingress.as_ref())
        .into_iter()
        .flatten()
        .filter_map(|i| i.hostname.clone().or_else(|| i.ip.clone()))
        .collect();
    Some(InfraEdge {
        kind: "loadbalancer",
        name: name_of(&s.metadata),
        class: spec.load_balancer_class.clone(),
        hosts,
        annotations: edge_annotations(&s.metadata),
    })
}

pub fn ingress_from(i: &Ingress) -> InfraEdge {
    let spec = i.spec.as_ref();
    let class = spec.and_then(|s| s.ingress_class_name.clone()).or_else(|| {
        i.metadata
            .annotations
            .as_ref()?
            .get("kubernetes.io/ingress.class")
            .cloned()
    });
    let hosts = spec
        .and_then(|s| s.rules.as_ref())
        .into_iter()
        .flatten()
        .filter_map(|r| r.host.clone())
        .collect();
    InfraEdge {
        kind: "ingress",
        name: name_of(&i.metadata),
        class,
        hosts,
        annotations: edge_annotations(&i.metadata),
    }
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |cur, key| cur.get(key))?.as_str()
}

fn strings_at(v: &Value, path: &[&str], field: Option<&str>) -> Vec<String> {
    let Some(arr) = path
        .iter()
        .try_fold(v, |cur, key| cur.get(key))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| match field {
            Some(f) => item.get(f)?.as_str(),
            None => item.as_str(),
        })
        .map(str::to_string)
        .collect()
}

fn dynamic_annotations(v: &Value) -> BTreeMap<String, String> {
    v.pointer("/metadata/annotations")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(k, _)| EDGE_ANNOTATION_PREFIXES.iter().any(|p| k.starts_with(p)))
        .filter_map(|(k, val)| Some((k.clone(), val.as_str()?.to_string())))
        .collect()
}

/// A Gateway or HTTPRoute (`kind` is `"gateway"` or `"httproute"`).
pub fn edge_from_dynamic(kind: &'static str, v: &Value) -> InfraEdge {
    let (class, hosts) = if kind == "gateway" {
        (
            str_at(v, &["spec", "gatewayClassName"]).map(str::to_string),
            strings_at(v, &["spec", "listeners"], Some("hostname")),
        )
    } else {
        (None, strings_at(v, &["spec", "hostnames"], None))
    };
    InfraEdge {
        kind,
        name: str_at(v, &["metadata", "name"])
            .unwrap_or_default()
            .to_string(),
        class,
        hosts,
        annotations: dynamic_annotations(v),
    }
}

// ---- identity, policy, secrets, events ------------------------------------

pub fn service_account_from(sa: &ServiceAccount) -> InfraServiceAccount {
    InfraServiceAccount {
        name: name_of(&sa.metadata),
        identity: annotations_where(&sa.metadata, |k| IDENTITY_KEYS.contains(&k)),
    }
}

/// A label selector in kubectl syntax (`k=v,k in (a,b),k notin (c),k,!k`);
/// `*` only when it has neither labels nor expressions (it selects everything).
fn selector_string(sel: &LabelSelector) -> String {
    let labels = sel
        .match_labels
        .iter()
        .flatten()
        .map(|(k, v)| format!("{k}={v}"));
    let expressions = sel.match_expressions.iter().flatten().map(|e| {
        let values = e.values.as_deref().unwrap_or_default().join(",");
        match e.operator.as_str() {
            "In" => format!("{} in ({values})", e.key),
            "NotIn" => format!("{} notin ({values})", e.key),
            "Exists" => e.key.clone(),
            "DoesNotExist" => format!("!{}", e.key),
            op => format!("{} {op} ({values})", e.key),
        }
    });
    let parts: Vec<String> = labels.chain(expressions).collect();
    if parts.is_empty() {
        "*".into()
    } else {
        parts.join(",")
    }
}

fn peer_summary(p: &NetworkPolicyPeer) -> String {
    if let Some(block) = &p.ip_block {
        return format!("cidr {}", block.cidr);
    }
    match (&p.pod_selector, &p.namespace_selector) {
        (Some(pods), Some(ns)) => format!(
            "pods {} in namespace {}",
            selector_string(pods),
            selector_string(ns)
        ),
        (Some(pods), None) => format!("pods {}", selector_string(pods)),
        (None, Some(ns)) => format!("namespace {}", selector_string(ns)),
        (None, None) => "any".into(),
    }
}

fn port_summary(p: &NetworkPolicyPort) -> Option<String> {
    let port = int_or_string(p.port.as_ref()?);
    Some(format!(
        ":{port}/{}",
        p.protocol.as_deref().unwrap_or("TCP")
    ))
}

pub fn network_policy_from(np: &NetworkPolicy) -> InfraNetworkPolicy {
    let spec = np.spec.as_ref();
    let egress = spec
        .and_then(|s| s.egress.as_ref())
        .into_iter()
        .flatten()
        .flat_map(|rule| {
            let ports: Vec<String> = rule
                .ports
                .iter()
                .flatten()
                .filter_map(port_summary)
                .collect();
            let peers: Vec<String> = match rule.to.as_deref() {
                Some(to) if !to.is_empty() => to.iter().map(peer_summary).collect(),
                _ => vec!["any".into()],
            };
            peers.into_iter().map(move |peer| {
                if ports.is_empty() {
                    peer
                } else {
                    format!("{peer} {}", ports.join(" "))
                }
            })
        })
        .collect();
    InfraNetworkPolicy {
        name: name_of(&np.metadata),
        pod_selector: spec
            .and_then(|s| s.pod_selector.as_ref()?.match_labels.clone())
            .unwrap_or_default(),
        policy_types: spec
            .and_then(|s| s.policy_types.clone())
            .unwrap_or_default(),
        egress,
    }
}

pub fn secret_store_from(v: &Value) -> InfraSecretStore {
    InfraSecretStore {
        name: str_at(v, &["metadata", "name"])
            .unwrap_or_default()
            .to_string(),
        provider: v
            .pointer("/spec/provider")
            .and_then(Value::as_object)
            .and_then(|o| o.keys().next().cloned()),
    }
}

pub fn external_secret_from(v: &Value) -> InfraExternalSecret {
    InfraExternalSecret {
        name: str_at(v, &["metadata", "name"])
            .unwrap_or_default()
            .to_string(),
        store: str_at(v, &["spec", "secretStoreRef", "name"]).map(str::to_string),
        target: str_at(v, &["spec", "target", "name"]).map(str::to_string),
    }
}

pub fn secret_name_from(s: &PartialObjectMeta<Secret>) -> InfraSecretName {
    InfraSecretName {
        name: name_of(&s.metadata),
    }
}

pub fn event_from(e: &Event) -> InfraEvent {
    let at = e
        .last_timestamp
        .as_ref()
        .map(time_string)
        .or_else(|| e.event_time.as_ref().map(|t| t.0.to_string()));
    InfraEvent {
        at,
        kind: e.type_.clone().unwrap_or_default(),
        reason: e.reason.clone().unwrap_or_default(),
        message: e.message.clone().unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture<T: serde::de::DeserializeOwned>(name: &str) -> T {
        let path = format!(
            "{}/tests/fixtures/cluster/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn run_pod_orders_init_sidecars_main_and_keeps_wardby_labels() {
        let pod = pod_from(&fixture("run-pod"));
        let roles: Vec<_> = pod
            .containers
            .iter()
            .map(|c| (c.name.as_str(), c.role))
            .collect();
        assert_eq!(
            roles,
            vec![
                ("storage-init", "init"),
                ("postgres", "sidecar"),
                ("redis", "sidecar"),
                ("worker", "main")
            ]
        );
        assert_eq!(pod.runtime_class.as_deref(), Some("gvisor"));
        assert!(pod.labels.contains_key("wardby.io/run-sha256"));
        assert!(
            pod.labels
                .keys()
                .all(|k| k.starts_with("wardby.io/") || k.starts_with("app.kubernetes.io/"))
        );
    }

    #[test]
    fn container_state_reason_restarts_and_resources() {
        let pod = pod_from(&fixture("run-pod"));
        let worker = pod.containers.iter().find(|c| c.name == "worker").unwrap();
        assert_eq!(worker.state, "running");
        assert_eq!(
            worker.requests,
            Resources {
                cpu: Some("2".into()),
                memory: Some("4Gi".into())
            }
        );
        let init = &pod.containers[0];
        assert_eq!(
            (init.state, init.reason.as_deref()),
            ("terminated", Some("Completed"))
        );
        let redis = pod.containers.iter().find(|c| c.name == "redis").unwrap();
        assert_eq!(
            (
                redis.state,
                redis.reason.as_deref(),
                redis.restarts,
                redis.ready
            ),
            ("waiting", Some("CrashLoopBackOff"), 3, false)
        );
    }

    #[test]
    fn pod_metadata_owner_and_readiness() {
        let pod = pod_from(&fixture("run-pod"));
        assert_eq!(
            pod.owner,
            Some(Owner {
                kind: "Job".into(),
                name: "wardby-run-0123456789abcdef0123".into()
            })
        );
        assert_eq!(pod.node.as_deref(), Some("gke-node-1"));
        assert_eq!(pod.service_account.as_deref(), Some("wardby-run"));
        assert_eq!(pod.phase, "Running");
        assert!(pod.ready);
        assert!(pod.started_at.is_some());
    }

    #[test]
    fn digest_images_are_shortened_to_twelve_hex() {
        let pod = pod_from(&fixture("run-pod"));
        let pg = pod
            .containers
            .iter()
            .find(|c| c.name == "postgres")
            .unwrap();
        assert_eq!(pg.image, "docker.io/library/postgres@sha256:aaaaaaaaaaaa…");
        assert_eq!(short_image("repo/app:1.0"), "repo/app:1.0");
    }

    #[test]
    fn service_account_keeps_only_identity_annotations() {
        let sa = service_account_from(&fixture("serviceaccount-gke"));
        assert_eq!(sa.identity.len(), 1);
        assert!(sa.identity.contains_key("iam.gke.io/gcp-service-account"));
    }

    #[test]
    fn network_policy_summarizes_egress_peers() {
        let np = network_policy_from(&fixture("networkpolicy-run-egress"));
        assert_eq!(
            np.egress,
            vec!["pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP"]
        );
        assert_eq!(np.policy_types, vec!["Egress"]);
    }

    #[test]
    fn selector_with_expressions_is_never_shown_as_everything() {
        let sel: LabelSelector = serde_json::from_value(serde_json::json!({
            "matchLabels": {"app": "proxy"},
            "matchExpressions": [
                {"key": "tier", "operator": "In", "values": ["a", "b"]},
                {"key": "env", "operator": "NotIn", "values": ["dev"]},
                {"key": "owned", "operator": "Exists"},
                {"key": "legacy", "operator": "DoesNotExist"}
            ]
        }))
        .unwrap();
        assert_eq!(
            selector_string(&sel),
            "app=proxy,tier in (a,b),env notin (dev),owned,!legacy"
        );
        let only: LabelSelector = serde_json::from_value(serde_json::json!({
            "matchExpressions": [{"key": "tier", "operator": "In", "values": ["a"]}]
        }))
        .unwrap();
        assert_eq!(selector_string(&only), "tier in (a)");
        assert_eq!(selector_string(&LabelSelector::default()), "*");
    }

    #[test]
    fn secret_store_provider_and_external_secret_target() {
        assert_eq!(
            secret_store_from(&fixture("secretstore-gcpsm"))
                .provider
                .as_deref(),
            Some("gcpsm")
        );
        let es = external_secret_from(&fixture("externalsecret"));
        assert_eq!(
            (es.store.as_deref(), es.target.as_deref()),
            (Some("gcp-secret-manager"), Some("wardby-control-plane-env"))
        );
    }

    #[test]
    fn image_is_shortened_but_identifiable() {
        let pod = pod_from(&fixture("control-plane-pod"));
        let proxy = pod
            .containers
            .iter()
            .find(|c| c.name == "cloud-sql-proxy")
            .unwrap();
        assert!(
            proxy
                .image
                .starts_with("gcr.io/cloud-sql-connectors/cloud-sql-proxy")
        );
    }

    #[test]
    fn deployment_job_service_event_secret_name() {
        let d = deployment_from(&fixture("deployment"));
        assert_eq!((d.ready, d.desired), (1, 2));
        assert_eq!(d.labels.len(), 1);
        let j = job_from(&fixture("job"));
        assert_eq!((j.active, j.succeeded, j.failed), (0, 1, 0));
        assert!(j.finished_at.is_some());
        assert_eq!(service_from(&fixture("service")).ports, vec!["80/TCP→8080"]);
        assert_eq!(
            service_from(&fixture("service-lb")).ports,
            vec!["443/TCP→https"]
        );
        let ev = event_from(&fixture("event"));
        assert_eq!(
            (ev.kind.as_str(), ev.reason.as_str()),
            ("Warning", "BackOff")
        );
        assert!(ev.at.is_some());
        assert_eq!(
            secret_name_from(&fixture("secret-meta")).name,
            "wardby-control-plane-env"
        );
    }

    #[test]
    fn edges_from_service_ingress_and_gateway_api() {
        assert!(edge_from_service(&fixture("service")).is_none());
        let lb = edge_from_service(&fixture("service-lb")).unwrap();
        assert_eq!(lb.kind, "loadbalancer");
        assert_eq!(
            lb.annotations.keys().collect::<Vec<_>>(),
            vec!["cloud.google.com/neg"]
        );
        let ing = ingress_from(&fixture("ingress"));
        assert_eq!((ing.kind, ing.class.as_deref()), ("ingress", Some("alb")));
        assert_eq!(ing.hosts, vec!["wardby.example.com"]);
        assert_eq!(ing.annotations.len(), 1);
        let gw = edge_from_dynamic("gateway", &fixture("gateway"));
        assert_eq!(gw.class.as_deref(), Some("gke-l7-global-external-managed"));
        assert_eq!(gw.hosts, vec!["wardby.example.com"]);
        assert!(gw.annotations.contains_key("networking.gke.io/certmap"));
        let route = edge_from_dynamic("httproute", &fixture("httproute"));
        assert_eq!((route.kind, route.hosts.len()), ("httproute", 2));
    }
}
