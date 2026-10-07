//! Errors from reading the kubeconfig or the cluster, as the webview sees them.

use serde::Serialize;

/// Crosses to the webview as `{ "kind": "<snake_case>", ...fields }`. Messages
/// come from `kube`'s own error text, never from the kubeconfig's credentials.
#[derive(Debug, Clone, Serialize, PartialEq, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClusterError {
    #[error("no kubeconfig found")]
    NoKubeconfig,
    #[error("the kubeconfig has no context named {context:?}")]
    ContextNotFound { context: String },
    #[error("the cluster credentials could not be obtained: {message}")]
    AuthPlugin { message: String },
    #[error("not allowed to read {resource}")]
    Forbidden { resource: String },
    #[error("namespace {namespace:?} does not exist")]
    NamespaceNotFound { namespace: String },
    #[error("the cluster could not be reached: {message}")]
    Unreachable { message: String },
    #[error("{message}")]
    Other { message: String },
}

impl ClusterError {
    /// Map a failure to load the kubeconfig for `context` (the context that
    /// was asked for, so the UI can name it).
    pub fn from_kubeconfig(e: kube::config::KubeconfigError, context: &str) -> Self {
        use kube::config::KubeconfigError as K;
        match e {
            K::LoadContext(_) => ClusterError::ContextNotFound {
                context: context.to_string(),
            },
            K::FindPath => ClusterError::NoKubeconfig,
            // A YAML error can quote a value from the file, such as a token.
            K::Parse(_) => ClusterError::Other {
                message: "the kubeconfig could not be parsed".to_string(),
            },
            K::ReadConfig(io, _) if io.kind() == std::io::ErrorKind::NotFound => {
                ClusterError::NoKubeconfig
            }
            other => ClusterError::Other {
                message: other.to_string(),
            },
        }
    }

    /// Map an API error for `resource` (e.g. "pods"); `namespace` names the
    /// namespace when `resource` is "namespace" itself.
    pub fn from_api(e: &kube::Error, resource: &str, namespace: &str) -> Self {
        match e {
            kube::Error::Api(s) if s.code == 403 => ClusterError::Forbidden {
                resource: resource.into(),
            },
            kube::Error::Api(s) if s.code == 404 && resource == "namespace" => {
                ClusterError::NamespaceNotFound {
                    namespace: namespace.into(),
                }
            }
            other => Self::from_client(other),
        }
    }

    /// Map an error that is not about a specific resource (building the
    /// client, or transport/auth failures).
    pub fn from_client(e: &kube::Error) -> Self {
        match e {
            kube::Error::Auth(a) => ClusterError::AuthPlugin {
                message: auth_message(a),
            },
            kube::Error::HyperError(_) | kube::Error::Service(_) => ClusterError::Unreachable {
                message: e.to_string(),
            },
            other => ClusterError::Other {
                message: other.to_string(),
            },
        }
    }
}

/// What an auth failure may tell the webview. A failed plugin's stdout (which
/// could hold a partial credential) and its command line (whose `Debug` form
/// includes the environment it was given) are never included, and neither is
/// unparseable plugin output.
fn auth_message(a: &kube::client::AuthError) -> String {
    use kube::client::AuthError as A;
    match a {
        A::AuthExecRun { status, out, .. } => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stderr: String = stderr.trim().chars().take(500).collect();
            if stderr.is_empty() {
                format!("the auth plugin failed ({status})")
            } else {
                format!("the auth plugin failed ({status}): {stderr}")
            }
        }
        A::AuthExecParse(_) => "the auth plugin's output could not be parsed".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::core::Status;

    fn api(code: u16) -> kube::Error {
        kube::Error::Api(
            Status {
                code,
                ..Default::default()
            }
            .boxed(),
        )
    }

    #[test]
    fn forbidden_names_the_resource() {
        assert_eq!(
            ClusterError::from_api(&api(403), "pods", "wardby"),
            ClusterError::Forbidden {
                resource: "pods".into()
            }
        );
    }

    #[test]
    fn missing_namespace_is_its_own_error_only_for_the_namespace() {
        assert_eq!(
            ClusterError::from_api(&api(404), "namespace", "wardby"),
            ClusterError::NamespaceNotFound {
                namespace: "wardby".into()
            }
        );
        assert!(matches!(
            ClusterError::from_api(&api(404), "pods", "wardby"),
            ClusterError::Other { .. }
        ));
    }

    #[test]
    fn a_parse_error_never_quotes_the_file() {
        let e = kube::config::Kubeconfig::from_yaml("users: [{name: u, user: {token: [s3cret]}}]")
            .unwrap_err();
        let mapped = ClusterError::from_kubeconfig(e, "x");
        assert!(!mapped.to_string().contains("s3cret"), "{mapped}");
    }

    #[test]
    fn transport_failures_are_unreachable() {
        let e = kube::Error::Service("connection refused".into());
        assert!(matches!(
            ClusterError::from_api(&e, "pods", "wardby"),
            ClusterError::Unreachable { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_plugin_reports_stderr_but_never_stdout_or_its_environment() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(256);
        let e = kube::Error::Auth(kube::client::AuthError::AuthExecRun {
            cmd: "PATH=\"/secret/env\" \"gke-gcloud-auth-plugin\"".into(),
            status,
            out: std::process::Output {
                status,
                stdout: b"ya29.partial-token".to_vec(),
                stderr: b"run gcloud auth login\n".to_vec(),
            },
        });
        let ClusterError::AuthPlugin { message } = ClusterError::from_client(&e) else {
            panic!("expected AuthPlugin");
        };
        assert!(message.contains("run gcloud auth login"), "{message}");
        assert!(!message.contains("ya29"), "{message}");
        assert!(!message.contains("/secret/env"), "{message}");
    }

    #[test]
    fn serializes_with_a_kind_tag() {
        let v = serde_json::to_value(ClusterError::Forbidden {
            resource: "pods".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"kind": "forbidden", "resource": "pods"})
        );
        let v = serde_json::to_value(ClusterError::NoKubeconfig).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "no_kubeconfig"}));
    }

    #[test]
    fn unknown_context_carries_the_requested_name() {
        let e = kube::config::KubeconfigError::LoadContext("whatever".into());
        assert_eq!(
            ClusterError::from_kubeconfig(e, "kind-dev"),
            ClusterError::ContextNotFound {
                context: "kind-dev".into()
            }
        );
    }

    #[test]
    fn missing_file_maps_to_no_kubeconfig() {
        let e = kube::config::KubeconfigError::FindPath;
        assert_eq!(
            ClusterError::from_kubeconfig(e, "x"),
            ClusterError::NoKubeconfig
        );
        let e = kube::config::KubeconfigError::ReadConfig(
            std::io::Error::from(std::io::ErrorKind::NotFound),
            "/nope".into(),
        );
        assert_eq!(
            ClusterError::from_kubeconfig(e, "x"),
            ClusterError::NoKubeconfig
        );
    }
}
