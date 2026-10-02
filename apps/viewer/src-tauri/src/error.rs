//! Application error type. Every variant's message is safe to show and log:
//! none ever carries a token, authorization code, verifier or client secret.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("network error: {0}")]
    Network(String),
    #[error("server returned HTTP {status}")]
    Http { status: u16 },
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("sign-in was denied")]
    Denied,
    #[error("timed out waiting for sign-in")]
    Timeout,
    #[error("this server needs a client id")]
    NeedsClientId,
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("not signed in")]
    NotSignedIn,
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Network(_) => "network",
            AppError::Http { .. } => "http",
            AppError::Protocol(_) => "protocol",
            AppError::Denied => "denied",
            AppError::Timeout => "timeout",
            AppError::NeedsClientId => "needs_client_id",
            AppError::Keychain(_) => "keychain",
            AppError::NotSignedIn => "not_signed_in",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        // Drop the URL: it is not secret here, but there is no reason to echo it.
        let e = e.without_url();
        let what = if e.is_timeout() {
            "request timed out"
        } else if e.is_connect() {
            "could not connect"
        } else if e.is_decode() {
            "unreadable response body"
        } else {
            "request failed"
        };
        AppError::Network(what.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kind_and_message() {
        let v = serde_json::to_value(AppError::Http { status: 401 }).unwrap();
        assert_eq!(v["kind"], "http");
        assert_eq!(v["message"], "server returned HTTP 401");
        let v = serde_json::to_value(AppError::NeedsClientId).unwrap();
        assert_eq!(v["kind"], "needs_client_id");
    }
}
