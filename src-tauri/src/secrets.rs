//! OS credential storage (macOS Keychain, Windows Credential Manager,
//! Secret Service on Linux). API keys never touch disk in plaintext and are
//! never sent to the webview — the frontend only learns whether a key exists.

//!
//! Each secret is read from the OS store at most once per run and then kept in
//! process memory, so macOS asks for keychain access once per launch instead of
//! on every request (unsigned dev builds can't be "always allowed" permanently).

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::OnceLock;

const SERVICE: &str = "dev.phantom.companion";

/// name → value (None = known to be absent). Process memory only, never disk.
fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn entry(name: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, name).map_err(|e| anyhow!("credential store unavailable: {e}"))
}

pub fn set(name: &str, value: &str) -> Result<()> {
    let value = value.trim();
    if value.is_empty() {
        return delete(name);
    }
    entry(name)?.set_password(value).map_err(|e| anyhow!("could not save to the credential store: {e}"))?;
    cache().lock().insert(name.to_string(), Some(value.to_string()));
    Ok(())
}

pub fn get(name: &str) -> Result<Option<String>> {
    // Hold the lock while reading so concurrent callers trigger only one OS prompt.
    let mut c = cache().lock();
    if let Some(v) = c.get(name) {
        return Ok(v.clone());
    }
    let v = match entry(name)?.get_password() {
        Ok(v) => Some(v),
        Err(keyring::Error::NoEntry) => None,
        // Denied or failed: don't cache, so the user can allow it next time.
        Err(e) => return Err(anyhow!("could not read the credential store (access denied?): {e}")),
    };
    c.insert(name.to_string(), v.clone());
    Ok(v)
}

pub fn delete(name: &str) -> Result<()> {
    let r = match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow!("could not delete from the credential store: {e}")),
    };
    if r.is_ok() {
        cache().lock().insert(name.to_string(), None);
    }
    r
}

/// A non-reversible hint like "sk-or-…a1b2" for display.
pub fn mask(value: &str) -> String {
    let v: Vec<char> = value.chars().collect();
    if v.len() <= 10 {
        return "•".repeat(v.len());
    }
    let head: String = v[..6].iter().collect();
    let tail: String = v[v.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

pub const OPENROUTER_KEY: &str = "openrouter-api-key";
pub const GROQ_KEY: &str = "groq-api-key";

#[cfg(test)]
mod tests {
    #[test]
    fn mask_hides_middle() {
        assert_eq!(super::mask("sk-or-v1-0123456789abcdef"), "sk-or-…cdef");
        assert_eq!(super::mask("short"), "•••••");
    }
}
