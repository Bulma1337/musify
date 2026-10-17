//! Server credentials (Subsonic passwords / API keys, Jellyfin access tokens) in the OS credential
//! store — Windows Credential Manager, macOS Keychain or the Secret Service on Linux.
//! Secrets never touch the settings files or logs.

const SERVICE: &str = "io.github.bulma1337.navify";

fn entry(server_id: &str) -> Result<keyring::Entry, String> {
    if server_id.is_empty() || server_id.len() > 128 {
        return Err("invalid server id".into());
    }
    keyring::Entry::new(SERVICE, &format!("server:{server_id}")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_set(server_id: String, secret: String) -> Result<(), String> {
    entry(&server_id)?
        .set_password(&secret)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_get(server_id: String) -> Result<Option<String>, String> {
    match entry(&server_id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_delete(server_id: String) -> Result<(), String> {
    match entry(&server_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
