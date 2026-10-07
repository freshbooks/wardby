//! Read-only access to the user's Kubernetes cluster through their kubeconfig.
//! Credentials stay in this module: nothing here returns, logs or serializes
//! a token, certificate or exec plugin output.

pub mod errors;
pub mod kubeconfig;
