use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey, SECRET_KEY_LENGTH};
use rand_core::OsRng;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::keychain;

/// Public-facing identity info. The private key never leaves this module —
/// commands only ever return derived public data or signatures.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublicIdentity {
    pub identity_id: String,
    pub public_key: String,
}

fn derive_identity_id(public_key_bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(public_key_bytes);
    hex::encode(hasher.finalize())
}

fn to_public_identity(signing_key: &SigningKey) -> PublicIdentity {
    let public_key_bytes = signing_key.verifying_key().to_bytes();
    PublicIdentity {
        identity_id: derive_identity_id(&public_key_bytes),
        public_key: STANDARD.encode(public_key_bytes),
    }
}

fn load_signing_key() -> Result<Option<SigningKey>, String> {
    let seed = keychain::load_private_key_bytes()?;
    match seed {
        Some(bytes) => {
            if bytes.len() != SECRET_KEY_LENGTH {
                return Err("stored key has unexpected length".into());
            }
            let mut arr = [0u8; SECRET_KEY_LENGTH];
            arr.copy_from_slice(&bytes);
            Ok(Some(SigningKey::from_bytes(&arr)))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn identity_has_keypair() -> Result<bool, String> {
    Ok(load_signing_key()?.is_some())
}

#[tauri::command]
pub fn identity_generate_keypair() -> Result<PublicIdentity, String> {
    if load_signing_key()?.is_some() {
        return Err("an identity keypair already exists on this device".into());
    }
    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    keychain::save_private_key_bytes(&signing_key.to_bytes())?;
    Ok(to_public_identity(&signing_key))
}

#[tauri::command]
pub fn identity_get_public_key() -> Result<Option<PublicIdentity>, String> {
    Ok(load_signing_key()?.as_ref().map(to_public_identity))
}

/// Signs an arbitrary base64-encoded payload with this device's private key.
/// The key is loaded from the keychain for the duration of this call only.
#[tauri::command]
pub fn identity_sign(message_base64: String) -> Result<String, String> {
    let signing_key = load_signing_key()?.ok_or("no identity keypair found on this device")?;
    let message = STANDARD
        .decode(&message_base64)
        .map_err(|e| e.to_string())?;
    let signature: Signature = signing_key.sign(&message);
    Ok(STANDARD.encode(signature.to_bytes()))
}

/// Verifies a signature against a given public key. Pure function, no keychain access —
/// used to validate signed messages/invites from other trusted peers.
#[tauri::command]
pub fn identity_verify(
    public_key_base64: String,
    message_base64: String,
    signature_base64: String,
) -> Result<bool, String> {
    let public_key_bytes = STANDARD
        .decode(&public_key_base64)
        .map_err(|e| e.to_string())?;
    let message = STANDARD
        .decode(&message_base64)
        .map_err(|e| e.to_string())?;
    let signature_bytes = STANDARD
        .decode(&signature_base64)
        .map_err(|e| e.to_string())?;

    if public_key_bytes.len() != 32 {
        return Err("invalid public key length".into());
    }
    let mut vk_arr = [0u8; 32];
    vk_arr.copy_from_slice(&public_key_bytes);
    let verifying_key = VerifyingKey::from_bytes(&vk_arr).map_err(|e| e.to_string())?;

    if signature_bytes.len() != 64 {
        return Err("invalid signature length".into());
    }
    let mut sig_arr = [0u8; 64];
    sig_arr.copy_from_slice(&signature_bytes);
    let signature = Signature::from_bytes(&sig_arr);

    Ok(verifying_key.verify(&message, &signature).is_ok())
}

/// Destructive — deletes this device's identity keypair from the OS keychain.
/// Irreversible: the identity cannot be recovered afterwards. Intended for
/// dev/testing reset flows and an explicit user "remove this device" action.
#[tauri::command]
pub fn identity_delete_keypair() -> Result<(), String> {
    keychain::delete_private_key_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exercises the exact command functions the onboarding UI calls, against
    // the real OS keychain, and always cleans up afterwards so it never
    // leaves a stray identity behind for a real dev run to trip over.
    #[test]
    fn generate_sign_verify_roundtrip() {
        identity_delete_keypair().unwrap();
        assert!(!identity_has_keypair().unwrap());

        let pub1 = identity_generate_keypair().unwrap();
        assert!(identity_has_keypair().unwrap());

        let pub2 = identity_get_public_key().unwrap().unwrap();
        assert_eq!(pub1.public_key, pub2.public_key);
        assert_eq!(pub1.identity_id, pub2.identity_id);

        // generating again while a keypair already exists must be rejected
        assert!(identity_generate_keypair().is_err());

        let message = STANDARD.encode(b"hello haven");
        let signature = identity_sign(message.clone()).unwrap();

        assert!(identity_verify(pub1.public_key.clone(), message.clone(), signature.clone()).unwrap());

        let other_message = STANDARD.encode(b"tampered payload");
        assert!(!identity_verify(pub1.public_key.clone(), other_message, signature.clone()).unwrap());

        let other_signer = {
            let mut csprng = OsRng;
            SigningKey::generate(&mut csprng)
        };
        let wrong_public_key = STANDARD.encode(other_signer.verifying_key().to_bytes());
        assert!(!identity_verify(wrong_public_key, message.clone(), signature).unwrap());

        identity_delete_keypair().unwrap();
        assert!(!identity_has_keypair().unwrap());
        assert!(identity_get_public_key().unwrap().is_none());
    }
}
