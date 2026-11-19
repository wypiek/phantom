//! Push-to-talk on a single modifier key (e.g. Left Control).
//!
//! OS global-shortcut APIs can't register a bare modifier, so this watches
//! the key state directly. Reading modifier state needs no special permission:
//! macOS `CGEventSourceFlagsState`, Windows `GetAsyncKeyState`. The check is a
//! single cheap syscall every 30 ms.
//!
//! To avoid hijacking keyboard chords (Ctrl+C…), the press only counts once the
//! key has been held alone for 150 ms, and very short holds are reported so the
//! companion can discard them instead of transcribing.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const ARM_AFTER: Duration = Duration::from_millis(150);
const POLL: Duration = Duration::from_millis(30);

#[cfg(target_os = "macos")]
mod os {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state_id: i32) -> u64;
    }
    // Device-dependent modifier bits (IOKit NX_DEVICE*KEYMASK).
    const LCTL: u64 = 0x0000_0001;
    const LSHIFT: u64 = 0x0000_0002;
    const RSHIFT: u64 = 0x0000_0004;
    const LCMD: u64 = 0x0000_0008;
    const RCMD: u64 = 0x0000_0010;
    const LALT: u64 = 0x0000_0020;
    const RALT: u64 = 0x0000_0040;
    const RCTL: u64 = 0x0000_2000;
    const ALL: u64 = LCTL | LSHIFT | RSHIFT | LCMD | RCMD | LALT | RALT | RCTL;

    pub fn mask(key: &str) -> Option<u64> {
        Some(match key {
            "ControlLeft" => LCTL,
            "ControlRight" => RCTL,
            "ShiftLeft" => LSHIFT,
            "ShiftRight" => RSHIFT,
            "MetaLeft" => LCMD,
            "MetaRight" => RCMD,
            "AltLeft" => LALT,
            "AltRight" => RALT,
            _ => return None,
        })
    }

    /// (target held, any other modifier held)
    pub fn state(target: u64) -> (bool, bool) {
        // 0 = kCGEventSourceStateCombinedSessionState
        let flags = unsafe { CGEventSourceFlagsState(0) };
        (flags & target != 0, flags & ALL & !target != 0)
    }
}

#[cfg(target_os = "windows")]
mod os {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(v_key: i32) -> i16;
    }
    const KEYS: &[(&str, i32)] = &[
        ("ControlLeft", 0xA2),
        ("ControlRight", 0xA3),
        ("ShiftLeft", 0xA0),
        ("ShiftRight", 0xA1),
        ("AltLeft", 0xA4),
        ("AltRight", 0xA5),
        ("MetaLeft", 0x5B),
        ("MetaRight", 0x5C),
    ];

    pub fn mask(key: &str) -> Option<u64> {
        KEYS.iter().find(|(k, _)| *k == key).map(|(_, vk)| *vk as u64)
    }

    pub fn state(target: u64) -> (bool, bool) {
        let down = |vk: i32| unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000 != 0;
        let held = down(target as i32);
        let others = KEYS.iter().any(|(_, vk)| *vk as u64 != target && down(*vk));
        (held, others)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod os {
    pub fn mask(_key: &str) -> Option<u64> {
        None
    }
    pub fn state(_t: u64) -> (bool, bool) {
        (false, false)
    }
}

/// Starts a watcher thread; it exits when `gen` no longer matches `current`.
pub fn watch(app: AppHandle, key: String, gen: u64, current: &'static AtomicU64) -> Result<(), String> {
    let target = os::mask(&key).ok_or_else(|| "single-key push-to-talk isn't supported on this system yet — choose a key combination".to_string())?;
    std::thread::Builder::new()
        .name("phantom-ptt-key".into())
        .spawn(move || {
            let mut down_since: Option<Instant> = None;
            let mut armed_at: Option<Instant> = None;
            while current.load(Ordering::SeqCst) == gen {
                std::thread::sleep(POLL);
                let (held, others) = os::state(target);
                match (held && !others, down_since, armed_at) {
                    (true, None, _) => down_since = Some(Instant::now()),
                    (true, Some(t), None) if t.elapsed() >= ARM_AFTER => {
                        armed_at = Some(Instant::now());
                        let _ = app.emit_to(crate::windows::COMPANION, "shortcut://ptt", serde_json::json!({ "pressed": true }));
                    }
                    (false, _, Some(t)) => {
                        let held_ms = t.elapsed().as_millis() as u64 + ARM_AFTER.as_millis() as u64;
                        // Another modifier joined → it was a chord, not push-to-talk.
                        let chord = held && others;
                        let _ = app.emit_to(crate::windows::COMPANION, "shortcut://ptt", serde_json::json!({ "pressed": false, "heldMs": held_ms, "chord": chord }));
                        down_since = None;
                        armed_at = None;
                    }
                    (false, Some(_), None) => down_since = None,
                    _ => {}
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn known_keys_map() {
        if cfg!(any(target_os = "macos", target_os = "windows")) {
            assert!(super::os::mask("ControlLeft").is_some());
        }
        assert!(super::os::mask("Banana").is_none());
    }
}
