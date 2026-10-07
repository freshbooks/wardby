//! Read-only access to the user's Kubernetes cluster through their kubeconfig.
//! Credentials stay in this module: nothing here returns, logs or serializes
//! a token, certificate or exec plugin output.

pub mod errors;
pub mod kubeconfig;
pub mod model;
pub mod watch;

/// Tauri event that carries every cluster frame to the UI, as
/// `{ "server": <url>, "frame": ClusterFrame }`.
pub const CLUSTER_EVENT: &str = "viewer://cluster";
