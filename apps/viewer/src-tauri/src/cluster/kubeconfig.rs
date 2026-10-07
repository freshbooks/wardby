//! The user's kubeconfig: which contexts exist, and a client for one of them.
//! Credentials (including `exec` plugins such as gke-gcloud-auth-plugin or
//! `aws eks get-token`) are resolved by `kube` and never leave this module.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use kube::config::{KubeConfigOptions, Kubeconfig};
use serde::Serialize;

use super::errors::ClusterError;

#[derive(Debug, Serialize, PartialEq)]
pub struct KubeContexts {
    pub current: Option<String>,
    pub contexts: Vec<String>,
}

fn summarize(cfg: &Kubeconfig) -> KubeContexts {
    KubeContexts {
        current: cfg.current_context.clone(),
        contexts: cfg.contexts.iter().map(|c| c.name.clone()).collect(),
    }
}

fn read_error(e: kube::config::KubeconfigError) -> ClusterError {
    // Reading never fails with `LoadContext`, so no context name is needed.
    ClusterError::from_kubeconfig(e, "")
}

pub fn contexts_from_yaml(yaml: &str) -> Result<KubeContexts, ClusterError> {
    let cfg = Kubeconfig::from_yaml(yaml).map_err(read_error)?;
    Ok(summarize(&cfg))
}

pub fn contexts_from_path(path: &Path) -> Result<KubeContexts, ClusterError> {
    if !path.exists() {
        return Err(ClusterError::NoKubeconfig);
    }
    let cfg = Kubeconfig::read_from(path).map_err(read_error)?;
    Ok(summarize(&cfg))
}

/// The kubeconfig kubectl would use: every file in `$KUBECONFIG`, merged, or
/// `~/.kube/config`.
fn load() -> Result<Kubeconfig, ClusterError> {
    Kubeconfig::read().map_err(read_error)
}

pub fn list_contexts() -> Result<KubeContexts, ClusterError> {
    Ok(summarize(&load()?))
}

/// Directories `exec` credential plugins (gke-gcloud-auth-plugin, `aws`)
/// usually live in. A macOS app launched from the Dock does not inherit the
/// shell's `PATH`, so without these the plugins are not found.
fn plugin_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(Path::new(&home).join("google-cloud-sdk").join("bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/share/google-cloud-sdk/bin"));
    dirs
}

/// `current` with each plugin directory appended once (entries already
/// present keep their position).
pub fn augmented_path(current: &str) -> OsString {
    let mut parts: Vec<PathBuf> = std::env::split_paths(current).collect();
    for dir in plugin_dirs() {
        if !parts.contains(&dir) {
            parts.push(dir);
        }
    }
    std::env::join_paths(parts).unwrap_or_else(|_| OsString::from(current))
}

/// Gives every `exec` plugin an explicit `PATH` (unless the kubeconfig sets
/// one), so the plugin and the tools it calls are found. Set on the plugin's
/// own environment rather than this process's: changing the process
/// environment while other threads run is unsound.
fn with_plugin_path(cfg: &mut Kubeconfig, path: &str) {
    for info in cfg.auth_infos.iter_mut() {
        let Some(exec) = info.auth_info.as_mut().and_then(|a| a.exec.as_mut()) else {
            continue;
        };
        let env = exec.env.get_or_insert_with(Vec::new);
        if env
            .iter()
            .any(|e| e.get("name").map(String::as_str) == Some("PATH"))
        {
            continue;
        }
        env.push(
            [
                ("name".to_string(), "PATH".to_string()),
                ("value".to_string(), path.to_string()),
            ]
            .into_iter()
            .collect(),
        );
    }
}

async fn client_from(mut cfg: Kubeconfig, context: &str) -> Result<kube::Client, ClusterError> {
    if !cfg.contexts.iter().any(|c| c.name == context) {
        return Err(ClusterError::ContextNotFound {
            context: context.to_string(),
        });
    }
    let current = std::env::var("PATH").unwrap_or_default();
    let path = augmented_path(&current);
    with_plugin_path(&mut cfg, &path.to_string_lossy());
    let opts = KubeConfigOptions {
        context: Some(context.to_string()),
        ..Default::default()
    };
    let config = kube::Config::from_custom_kubeconfig(cfg, &opts)
        .await
        .map_err(|e| ClusterError::from_kubeconfig(e, context))?;
    kube::Client::try_from(config).map_err(|e| ClusterError::from_client(&e))
}

/// A client for `context` in the user's kubeconfig.
pub async fn client_for(context: &str) -> Result<kube::Client, ClusterError> {
    client_from(load()?, context).await
}

#[cfg(test)]
mod tests {
    use super::*;
    const KUBECONFIG: &str = r#"
apiVersion: v1
kind: Config
current-context: gke_p_us-central1_c
contexts:
- name: gke_p_us-central1_c
  context: { cluster: c1, user: u1 }
- name: kind-dev
  context: { cluster: c2, user: u2 }
clusters: []
users: []
"#;

    #[test]
    fn lists_contexts_and_current() {
        let ctx = contexts_from_yaml(KUBECONFIG).unwrap();
        assert_eq!(ctx.current.as_deref(), Some("gke_p_us-central1_c"));
        assert_eq!(ctx.contexts, vec!["gke_p_us-central1_c", "kind-dev"]);
    }

    #[test]
    fn missing_kubeconfig_is_its_own_error() {
        let err = contexts_from_path(std::path::Path::new("/nonexistent/kubeconfig")).unwrap_err();
        assert!(matches!(err, ClusterError::NoKubeconfig));
    }

    #[test]
    fn path_includes_common_plugin_dirs() {
        let p = augmented_path("/usr/bin");
        let parts: Vec<PathBuf> = std::env::split_paths(&p).collect();
        assert_eq!(parts[0], PathBuf::from("/usr/bin"));
        for dir in plugin_dirs() {
            assert_eq!(parts.iter().filter(|p| **p == dir).count(), 1, "{dir:?}");
        }
        // Already-present directories are not added again.
        let again = augmented_path(&p.to_string_lossy());
        assert_eq!(again, p);
    }

    const EXEC: &str = r#"
apiVersion: v1
kind: Config
current-context: gke
contexts:
- name: gke
  context: { cluster: c1, user: u1 }
- name: kind-dev
  context: { cluster: c1, user: u2 }
- name: token-ctx
  context: { cluster: c1, user: u3 }
clusters:
- name: c1
  cluster: { server: "https://127.0.0.1:6443" }
users:
- name: u1
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
- name: u2
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      env:
      - { name: PATH, value: /custom/bin }
- name: u3
  user: { token: not-a-real-token }
"#;

    fn env_of(cfg: &Kubeconfig, user: &str) -> Vec<(String, String)> {
        let info = cfg.auth_infos.iter().find(|a| a.name == user).unwrap();
        let exec = info.auth_info.as_ref().unwrap().exec.as_ref().unwrap();
        exec.env
            .iter()
            .flatten()
            .map(|e| (e["name"].clone(), e["value"].clone()))
            .collect()
    }

    #[test]
    fn exec_plugins_get_a_path_unless_they_set_one() {
        let mut cfg = Kubeconfig::from_yaml(EXEC).unwrap();
        with_plugin_path(&mut cfg, "/usr/bin:/opt/homebrew/bin");
        assert_eq!(
            env_of(&cfg, "u1"),
            vec![("PATH".into(), "/usr/bin:/opt/homebrew/bin".into())]
        );
        assert_eq!(
            env_of(&cfg, "u2"),
            vec![("PATH".into(), "/custom/bin".into())]
        );
    }

    #[tokio::test]
    async fn unknown_context_names_the_requested_context() {
        let cfg = Kubeconfig::from_yaml(EXEC).unwrap();
        let Err(err) = client_from(cfg, "nope").await else {
            panic!("expected an error");
        };
        assert_eq!(
            err,
            ClusterError::ContextNotFound {
                context: "nope".into()
            }
        );
    }

    #[tokio::test]
    async fn builds_a_client_for_a_known_context_without_contacting_it() {
        let cfg = Kubeconfig::from_yaml(EXEC).unwrap();
        if let Err(e) = client_from(cfg, "token-ctx").await {
            panic!("{e:?}");
        }
    }

    #[tokio::test]
    async fn an_exec_plugin_that_cannot_run_is_an_auth_plugin_error() {
        // u2's plugin is looked up only in its own PATH, /custom/bin.
        let cfg = Kubeconfig::from_yaml(EXEC).unwrap();
        let Err(err) = client_from(cfg, "kind-dev").await else {
            panic!("expected an error");
        };
        assert!(matches!(err, ClusterError::AuthPlugin { .. }), "{err:?}");
    }
}
