use base64::{engine::general_purpose::STANDARD, Engine as _};
use keyring::Entry;
use rand_core::{OsRng, RngCore};

const SERVICE: &str = "colloquiumapp";
const ACCOUNT: &str = "identity-private-key";
const DB_KEY_ACCOUNT: &str = "db-encryption-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

/// Returns the database encryption key as lowercase hex (64 chars), creating
/// and persisting a fresh 32-byte key on first run.
///
/// CRITICAL: unlike the identity entry, a stored value that fails to decode or
/// is the wrong length is a HARD error — never delete-and-regenerate. The key
/// is full entropy with no recovery path, so a fresh key would permanently
/// brick an already-encrypted database rather than unlock it.
pub fn load_or_create_db_key_hex() -> Result<String, String> {
    let entry = Entry::new(SERVICE, DB_KEY_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(encoded) => {
            let bytes = STANDARD
                .decode(&encoded)
                .map_err(|_| "stored database key is corrupt (undecodable)".to_string())?;
            if bytes.len() != 32 {
                return Err("stored database key has an unexpected length".into());
            }
            Ok(hex::encode(bytes))
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            entry
                .set_password(&STANDARD.encode(key))
                .map_err(|e| e.to_string())?;
            Ok(hex::encode(key))
        }
        Err(e) => Err(e.to_string()),
    }
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
