use base64::{engine::general_purpose::STANDARD, Engine as _};
use keyring::Entry;

const SERVICE: &str = "care.ayoo.haven";
const ACCOUNT: &str = "identity-private-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

/// Persists the raw private key seed bytes in the OS keychain (macOS Keychain /
/// Windows Credential Manager / Linux Secret Service). Never call this with
/// anything that should be visible to the webview — this module is the only
/// place the raw key touches disk.
pub fn save_private_key_bytes(bytes: &[u8]) -> Result<(), String> {
    entry()?
        .set_password(&STANDARD.encode(bytes))
        .map_err(|e| e.to_string())
}

/// Returns `Ok(None)` both when nothing is stored and when what's stored is
/// undecodable garbage (e.g. left over from an incompatible format) — either
/// way there's no usable key to return, and the caller (`identity.rs`) treats
/// `None` as "safe to generate a fresh one" rather than a permanent lockout.
pub fn load_private_key_bytes() -> Result<Option<Vec<u8>>, String> {
    match entry()?.get_password() {
        Ok(encoded) => match STANDARD.decode(&encoded) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(_) => {
                delete_private_key_bytes()?;
                Ok(None)
            }
        },
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
