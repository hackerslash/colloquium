use base64::{engine::general_purpose::STANDARD, Engine as _};
use keyring::Entry;

const DEFAULT_SERVICE: &str = "care.ayoo.haven";
const ACCOUNT: &str = "identity-private-key";

/// Overridable only via HAVEN_KEYCHAIN_SERVICE, so a second dev instance on
/// the same machine can use an isolated keychain entry instead of colliding
/// with the default one. Unset in normal/production use.
fn service_name() -> String {
    std::env::var("HAVEN_KEYCHAIN_SERVICE").unwrap_or_else(|_| DEFAULT_SERVICE.to_string())
}

fn entry() -> Result<Entry, String> {
    Entry::new(&service_name(), ACCOUNT).map_err(|e| e.to_string())
}

/// Persists the raw private key seed bytes in the OS keychain (macOS Keychain /
/// Windows Credential Manager). Never call this with anything that should be
/// visible to the webview — this module is the only place the raw key touches disk.
pub fn save_private_key_bytes(bytes: &[u8]) -> Result<(), String> {
    entry()?
        .set_password(&STANDARD.encode(bytes))
        .map_err(|e| e.to_string())
}

pub fn load_private_key_bytes() -> Result<Option<Vec<u8>>, String> {
    match entry()?.get_password() {
        Ok(encoded) => STANDARD
            .decode(&encoded)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete_private_key_bytes() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
