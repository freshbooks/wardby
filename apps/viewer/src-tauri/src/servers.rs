//! Saved servers and the Keychain wrapper. The refresh token lives only in the
//! OS credential store (service "wardby-viewer"); nothing else persists it.

use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::AppError;

pub const KEYCHAIN_SERVICE: &str = "wardby-viewer";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerConfig {
    pub name: String,
    pub url: String,
    pub client_id: Option<String>,
}

/// Canonical form of a server URL: lowercase scheme and host, no query or
/// fragment, no trailing slash. Used as the Keychain account name.
pub fn normalize_server_url(server_url: &str) -> Result<String, AppError> {
    let mut url = Url::parse(server_url.trim())
        .map_err(|_| AppError::Protocol("invalid server URL".to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AppError::Protocol("server URL must be http(s)".to_string()));
    }
    url.set_query(None);
    url.set_fragment(None);
    let _ = url.set_username("");
    let _ = url.set_password(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn entry(server_url: &str) -> Result<keyring::Entry, AppError> {
    let account = normalize_server_url(server_url)?;
    keyring::Entry::new(KEYCHAIN_SERVICE, &account).map_err(|e| AppError::Keychain(e.to_string()))
}

pub fn keychain_get(server_url: &str) -> Result<Option<String>, AppError> {
    match entry(server_url)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

pub fn keychain_set(server_url: &str, refresh_token: &str) -> Result<(), AppError> {
    entry(server_url)?
        .set_password(refresh_token)
        .map_err(|e| AppError::Keychain(e.to_string()))
}

pub fn keychain_delete(server_url: &str) -> Result<(), AppError> {
    match entry(server_url)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls() {
        assert_eq!(
            normalize_server_url(" HTTPS://Wardby.Example.com/?x=1#f ").unwrap(),
            "https://wardby.example.com"
        );
        assert_eq!(
            normalize_server_url("https://h.example/mcp/").unwrap(),
            "https://h.example/mcp"
        );
        assert!(normalize_server_url("ftp://h.example").is_err());
        assert!(normalize_server_url("not a url").is_err());
    }

    #[test]
    fn server_config_roundtrips() {
        let c = ServerConfig {
            name: "a".into(),
            url: "https://h.example".into(),
            client_id: None,
        };
        let back: ServerConfig = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back, c);
    }

    // Touches the real Keychain: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn keychain_roundtrip() {
        let url = "https://keychain-test.wardby-viewer.invalid";
        keychain_delete(url).unwrap();
        assert_eq!(keychain_get(url).unwrap(), None);
        keychain_set(url, "test-refresh-token").unwrap();
        assert_eq!(
            keychain_get(url).unwrap().as_deref(),
            Some("test-refresh-token")
        );
        keychain_delete(url).unwrap();
        assert_eq!(keychain_get(url).unwrap(), None);
    }
}
