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

fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
        None => false,
    }
}

/// Canonical form of a server URL: lowercase scheme and host, no trailing
/// slash. https only (http is allowed for 127.0.0.1, ::1 and localhost, for
/// local development). Userinfo, a query or a fragment are rejected rather
/// than dropped, so what the user typed is what gets used. Idempotent; also
/// the Keychain account name.
pub fn normalize_server_url(server_url: &str) -> Result<String, AppError> {
    let url = Url::parse(server_url.trim())
        .map_err(|_| AppError::Protocol("invalid server URL".to_string()))?;
    if url.host_str().is_none() {
        return Err(AppError::Protocol("invalid server URL".to_string()));
    }
    match url.scheme() {
        "https" => {}
        "http" if is_loopback_host(&url) => {}
        _ => {
            return Err(AppError::Protocol(
                "server URL must use https (http only for localhost)".to_string(),
            ));
        }
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::Protocol(
            "server URL must not contain a username or password".to_string(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(AppError::Protocol(
            "server URL must not contain a query or fragment".to_string(),
        ));
    }
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
            normalize_server_url(" HTTPS://Wardby.Example.com/ ").unwrap(),
            "https://wardby.example.com"
        );
        assert_eq!(
            normalize_server_url("https://h.example/mcp/").unwrap(),
            "https://h.example/mcp"
        );
        assert!(normalize_server_url("ftp://h.example").is_err());
        assert!(normalize_server_url("not a url").is_err());
        // Idempotent.
        let once = normalize_server_url("https://H.example:8443/a/").unwrap();
        assert_eq!(normalize_server_url(&once).unwrap(), once);
    }

    #[test]
    fn http_only_for_loopback_hosts() {
        for ok in [
            "http://localhost:3000",
            "http://127.0.0.1:8080/",
            "http://[::1]:8080",
        ] {
            assert!(normalize_server_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://wardby.example.com",
            "http://127.0.0.2",
            "http://10.0.0.1",
            "http://localhost.evil.example",
        ] {
            assert!(normalize_server_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn userinfo_query_and_fragment_are_rejected() {
        for bad in [
            "https://user:pw@h.example",
            "https://user@h.example",
            "https://h.example/?x=1",
            "https://h.example/#f",
            "https://h.example?",
        ] {
            let e = normalize_server_url(bad).unwrap_err();
            assert_eq!(e.kind(), "protocol", "{bad}");
        }
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
