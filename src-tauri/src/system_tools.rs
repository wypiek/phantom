//! Computer control for Noli: screenshots, opening apps/URLs, mouse and
//! keyboard input, and shell commands.
//!
//! Nothing here asks for permission by itself — `agent.rs` decides what needs
//! the user's approval before calling these functions.
//!
//! Coordinates: screenshots are scaled so that 1 image pixel maps to
//! `scale` logical screen points; the model clicks in image pixels and
//! [`ScreenGeometry::to_screen`] converts them.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::process::Command;
use std::time::Duration;

/// Largest screenshot side sent to the model (keeps requests small and fast).
const MAX_SHOT_WIDTH: u32 = 1280;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenGeometry {
    /// Screenshot size in pixels.
    pub image_w: u32,
    pub image_h: u32,
    /// Logical points per screenshot pixel.
    pub scale: f64,
    /// Origin of the captured display in logical points.
    pub origin_x: f64,
    pub origin_y: f64,
}

impl ScreenGeometry {
    pub fn to_screen(&self, x: f64, y: f64) -> (i32, i32) {
        let x = x.clamp(0.0, self.image_w as f64 - 1.0);
        let y = y.clamp(0.0, self.image_h as f64 - 1.0);
        ((self.origin_x + x * self.scale).round() as i32, (self.origin_y + y * self.scale).round() as i32)
    }
}

#[derive(Debug, Clone)]
pub struct Screenshot {
    pub jpeg_base64: String,
    pub geometry: ScreenGeometry,
    pub summary: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

// ---- permissions (macOS) ------------------------------------------------------

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        static kAXTrustedCheckOptionPrompt: *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: *const c_void;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFDictionaryCreate(alloc: *const c_void, keys: *const *const c_void, values: *const *const c_void, n: isize, kcb: *const c_void, vcb: *const c_void) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }
    /// Adds PHANTOM to System Settings → Accessibility and shows the system prompt.
    pub fn request_accessibility() -> bool {
        unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let opts = CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), values.as_ptr(), 1, &kCFTypeDictionaryKeyCallBacks as *const _ as *const c_void, &kCFTypeDictionaryValueCallBacks as *const _ as *const c_void);
            let ok = AXIsProcessTrustedWithOptions(opts);
            if !opts.is_null() {
                CFRelease(opts);
            }
            ok
        }
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    pub fn accessibility() -> bool {
        unsafe { AXIsProcessTrusted() }
    }
    /// This process's own view of the permission. macOS caches it at launch,
    /// so it stays false after the user switches it on until PHANTOM restarts.
    pub fn screen_recording_cached() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }
    /// The current permission: asks a fresh copy of PHANTOM when the cached
    /// answer is "no", so turning it on in System Settings works immediately.
    pub fn screen_recording() -> bool {
        use std::sync::atomic::{AtomicBool, Ordering};
        static GRANTED: AtomicBool = AtomicBool::new(false);
        if GRANTED.load(Ordering::Relaxed) || screen_recording_cached() {
            return true;
        }
        let fresh = std::env::current_exe()
            .ok()
            .and_then(|exe| std::process::Command::new(exe).arg(super::SCREEN_PROBE_ARG).output().ok())
            .is_some_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "1");
        if fresh {
            GRANTED.store(true, Ordering::Relaxed);
        }
        fresh
    }
    pub fn request_screen_recording() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }
}

/// `phantom --probe-screen-permission` prints 1 or 0 and exits (see `main.rs`).
pub const SCREEN_PROBE_ARG: &str = "--probe-screen-permission";

/// Entry point for the probe process: the Screen Recording permission as macOS sees it right now.
pub fn probe_screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::screen_recording_cached()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ControlPermissions {
    /// Needed to move the mouse and type (macOS: Accessibility).
    pub input: bool,
    /// Needed to see other apps' windows (macOS: Screen Recording).
    pub screen: bool,
}

pub fn permissions() -> ControlPermissions {
    #[cfg(target_os = "macos")]
    {
        ControlPermissions { input: mac::accessibility(), screen: mac::screen_recording() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        ControlPermissions { input: true, screen: true }
    }
}

/// Opens the OS settings page where the user grants a permission.
pub fn open_permission_settings(which: &str) {
    #[cfg(target_os = "macos")]
    {
        if which == "screen" {
            // Shows the system prompt the first time; afterwards the settings page.
            if !mac::request_screen_recording() {
                let _ = Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture").status();
            }
        } else if !mac::request_accessibility() {
            // the system prompt adds PHANTOM to the list (switched off); open the page so the user can switch it on
            let _ = Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").status();
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = which;
}

// ---- apps & URLs ----------------------------------------------------------------

pub fn open_app(app_name: &str) -> Result<String> {
    let name = app_name.trim().trim_matches('"');
    if name.is_empty() {
        return Err(anyhow!("Application name cannot be empty"));
    }
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("open").arg("-a").arg(name).output()?;
        if out.status.success() {
            return Ok(format!("Opened {name}"));
        }
        Err(anyhow!("Could not find an app called \"{name}\". Use the exact name shown in /Applications."))
    }
    #[cfg(target_os = "windows")]
    {
        let status = Command::new("cmd").args(["/C", "start", "", name]).status()?;
        if status.success() {
            return Ok(format!("Launched {name}"));
        }
        Err(anyhow!("Could not launch \"{name}\""))
    }
    #[cfg(target_os = "linux")]
    {
        let status = Command::new("gtk-launch").arg(name).status().or_else(|_| Command::new("xdg-open").arg(name).status())?;
        if status.success() {
            return Ok(format!("Opened {name}"));
        }
        Err(anyhow!("Could not open \"{name}\""))
    }
}

pub fn open_url(url: &str) -> Result<String> {
    let url = url.trim();
    let url = if url.contains("://") { url.to_string() } else { format!("https://{url}") };
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(anyhow!("Only http(s) links can be opened"));
    }
    #[cfg(target_os = "macos")]
    let st = Command::new("open").arg(&url).status()?;
    #[cfg(target_os = "windows")]
    let st = Command::new("cmd").args(["/C", "start", "", &url]).status()?;
    #[cfg(target_os = "linux")]
    let st = Command::new("xdg-open").arg(&url).status()?;
    if st.success() {
        Ok(format!("Opened {url}"))
    } else {
        Err(anyhow!("Could not open {url}"))
    }
}

// ---- screen -----------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn osascript(script: &str) -> Option<String> {
    let o = Command::new("osascript").arg("-e").arg(script).output().ok()?;
    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (o.status.success() && !s.is_empty()).then_some(s)
}

/// Text description of what's on screen (front app, window, running apps).
pub fn screen_summary() -> String {
    #[cfg(target_os = "macos")]
    {
        let front = osascript("tell application \"System Events\" to get name of first application process whose frontmost is true");
        let window = osascript("tell application \"System Events\" to tell (first application process whose frontmost is true) to get name of front window");
        let apps = osascript("tell application \"System Events\" to get name of every application process whose background only is false");
        let mut s = format!("Frontmost app: {}", front.unwrap_or_else(|| "unknown".into()));
        if let Some(w) = window {
            s.push_str(&format!(" — window \"{w}\""));
        }
        if let Some(a) = apps {
            s.push_str(&format!(". Open apps: {a}"));
        }
        s
    }
    #[cfg(target_os = "windows")]
    {
        let o = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.ProcessName + ': ' + $_.MainWindowTitle }"])
            .output();
        match o {
            Ok(o) if o.status.success() => format!("Open windows: {}", String::from_utf8_lossy(&o.stdout).lines().take(25).collect::<Vec<_>>().join("; ")),
            _ => "Open windows: unknown".to_string(),
        }
    }
    #[cfg(target_os = "linux")]
    {
        match Command::new("wmctrl").arg("-l").output() {
            Ok(o) if o.status.success() => format!(
                "Open windows: {}",
                String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.splitn(4, char::is_whitespace).nth(3)).take(25).collect::<Vec<_>>().join("; ")
            ),
            _ => "Open windows: unknown (install wmctrl for window titles)".to_string(),
        }
    }
}

/// Takes a screenshot of the main display, scaled for the model.
/// `logical` = main display size and origin in logical points.
pub fn screenshot(logical: (f64, f64, f64, f64), tmp_dir: &std::path::Path) -> Result<Screenshot> {
    let perms = permissions();
    if !perms.screen {
        open_permission_settings("screen");
        return Err(anyhow!(
            "Screen Recording is switched off for PHANTOM. Switch PHANTOM on in System Settings → Privacy & Security → Screen & System Audio Recording, then ask again."
        ));
    }
    std::fs::create_dir_all(tmp_dir)?;
    let path = tmp_dir.join(format!("screen-{}.jpg", uuid::Uuid::new_v4()));
    #[cfg(target_os = "macos")]
    {
        let st = Command::new("screencapture").args(["-x", "-C", "-m", "-t", "jpg"]).arg(&path).status().context("screencapture failed")?;
        if !st.success() || !path.exists() {
            return Err(anyhow!("Could not take a screenshot"));
        }
        let (lw, lh, ox, oy) = logical;
        let target_w = (lw.round() as u32).min(MAX_SHOT_WIDTH).max(320);
        let _ = Command::new("sips").args(["-Z", &target_w.max((target_w as f64 * lh / lw) as u32).to_string(), "-s", "formatOptions", "70"]).arg(&path).output();
        let (iw, ih) = image_size(&path).unwrap_or((target_w, (target_w as f64 * lh / lw) as u32));
        let bytes = std::fs::read(&path)?;
        let _ = std::fs::remove_file(&path);
        Ok(Screenshot {
            jpeg_base64: base64_encode(&bytes),
            geometry: ScreenGeometry { image_w: iw, image_h: ih, scale: lw / iw as f64, origin_x: ox, origin_y: oy },
            summary: screen_summary(),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let png = path.with_extension("png");
        capture_png(&png)?;
        let img = image::open(&png).context("could not read the screenshot")?;
        let _ = std::fs::remove_file(&png);
        let (lw, _lh, ox, oy) = logical;
        let img = if img.width() > MAX_SHOT_WIDTH { img.resize(MAX_SHOT_WIDTH, u32::MAX, image::imageops::FilterType::Triangle) } else { img };
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 70).encode_image(&img.to_rgb8())?;
        let (iw, ih) = (img.width(), img.height());
        Ok(Screenshot {
            jpeg_base64: base64_encode(&bytes),
            geometry: ScreenGeometry { image_w: iw, image_h: ih, scale: lw / iw as f64, origin_x: ox, origin_y: oy },
            summary: screen_summary(),
        })
    }
}

/// Captures the primary screen to a PNG with whatever tool the system has.
#[cfg(target_os = "windows")]
fn capture_png(out: &std::path::Path) -> Result<()> {
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \
         $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); \
         $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('{}',[System.Drawing.Imaging.ImageFormat]::Png)",
        out.display().to_string().replace('\'', "''")
    );
    let st = Command::new("powershell").args(["-NoProfile", "-Command", &script]).status().context("PowerShell is not available")?;
    if !st.success() || !out.exists() {
        return Err(anyhow!("Could not take a screenshot"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn capture_png(out: &std::path::Path) -> Result<()> {
    let o = out.to_string_lossy().to_string();
    let tools: [(&str, Vec<&str>); 5] = [
        ("grim", vec![o.as_str()]),
        ("gnome-screenshot", vec!["-f", o.as_str()]),
        ("spectacle", vec!["-b", "-n", "-o", o.as_str()]),
        ("scrot", vec!["-o", o.as_str()]),
        ("import", vec!["-window", "root", o.as_str()]),
    ];
    for (tool, args) in tools {
        if Command::new(tool).args(&args).status().map(|s| s.success()).unwrap_or(false) && out.exists() {
            return Ok(());
        }
    }
    Err(anyhow!("No screenshot tool found. Install one of: grim (Wayland), gnome-screenshot, spectacle, scrot or ImageMagick."))
}

#[cfg(target_os = "macos")]
fn image_size(path: &std::path::Path) -> Option<(u32, u32)> {
    let o = Command::new("sips").args(["-g", "pixelWidth", "-g", "pixelHeight"]).arg(path).output().ok()?;
    let s = String::from_utf8_lossy(&o.stdout);
    let num = |k: &str| s.lines().find(|l| l.contains(k))?.split(':').nth(1)?.trim().parse::<u32>().ok();
    Some((num("pixelWidth")?, num("pixelHeight")?))
}

// ---- mouse & keyboard ----------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum InputAction {
    Move(i32, i32),
    Click { x: i32, y: i32, right: bool, double: bool },
    Scroll { x: Option<(i32, i32)>, amount: i32 },
    Type(String),
    Keys(String),
}

/// Parses "cmd+shift+t", "enter", "tab" into enigo keys.
pub fn parse_combo(combo: &str) -> Result<Vec<enigo::Key>> {
    use enigo::Key;
    let mut keys = vec![];
    for part in combo.split('+').map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()) {
        let k = match part.as_str() {
            "cmd" | "command" | "meta" | "win" | "super" => Key::Meta,
            "ctrl" | "control" => Key::Control,
            "shift" => Key::Shift,
            "alt" | "option" | "opt" => Key::Alt,
            "enter" | "return" => Key::Return,
            "tab" => Key::Tab,
            "esc" | "escape" => Key::Escape,
            "space" => Key::Space,
            "backspace" => Key::Backspace,
            "delete" | "del" => Key::Delete,
            "up" => Key::UpArrow,
            "down" => Key::DownArrow,
            "left" => Key::LeftArrow,
            "right" => Key::RightArrow,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" => Key::PageUp,
            "pagedown" => Key::PageDown,
            f if f.starts_with('f') && f.len() <= 3 && f[1..].parse::<u8>().is_ok() => match f[1..].parse::<u8>().unwrap() {
                1 => Key::F1,
                2 => Key::F2,
                3 => Key::F3,
                4 => Key::F4,
                5 => Key::F5,
                6 => Key::F6,
                7 => Key::F7,
                8 => Key::F8,
                9 => Key::F9,
                10 => Key::F10,
                11 => Key::F11,
                12 => Key::F12,
                _ => return Err(anyhow!("unsupported key {f}")),
            },
            s if s.chars().count() == 1 => Key::Unicode(s.chars().next().unwrap()),
            other => return Err(anyhow!("unknown key \"{other}\"")),
        };
        keys.push(k);
    }
    if keys.is_empty() {
        return Err(anyhow!("no keys given"));
    }
    Ok(keys)
}

/// Performs one input action. Must run on the main thread on macOS.
pub fn perform_input(action: &InputAction) -> Result<String> {
    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};
    if !permissions().input {
        open_permission_settings("accessibility");
        return Err(anyhow!(
            "Accessibility permission is missing, so I can't control the mouse or keyboard. Allow PHANTOM in System Settings → Privacy & Security → Accessibility, then ask again."
        ));
    }
    let mut e = Enigo::new(&Settings::default()).map_err(|e| anyhow!("input unavailable: {e}"))?;
    let pause = || std::thread::sleep(Duration::from_millis(40));
    match action {
        InputAction::Move(x, y) => {
            e.move_mouse(*x, *y, Coordinate::Abs)?;
            Ok(format!("moved the mouse to ({x}, {y})"))
        }
        InputAction::Click { x, y, right, double } => {
            e.move_mouse(*x, *y, Coordinate::Abs)?;
            pause();
            let b = if *right { Button::Right } else { Button::Left };
            e.button(b, Direction::Click)?;
            if *double {
                std::thread::sleep(Duration::from_millis(60));
                e.button(b, Direction::Click)?;
            }
            Ok(format!("{}clicked at ({x}, {y})", if *double { "double-" } else if *right { "right-" } else { "" }))
        }
        InputAction::Scroll { x, amount } => {
            if let Some((px, py)) = x {
                e.move_mouse(*px, *py, Coordinate::Abs)?;
                pause();
            }
            e.scroll(*amount, Axis::Vertical)?;
            Ok(format!("scrolled {} by {}", if *amount > 0 { "down" } else { "up" }, amount.abs()))
        }
        InputAction::Type(text) => {
            e.text(text)?;
            Ok(format!("typed {} characters", text.chars().count()))
        }
        InputAction::Keys(combo) => {
            let keys = parse_combo(combo)?;
            let (mods, last) = keys.split_at(keys.len() - 1);
            for m in mods {
                e.key(*m, Direction::Press)?;
            }
            pause();
            e.key(last[0], Direction::Click)?;
            pause();
            for m in mods.iter().rev() {
                e.key(*m, Direction::Release)?;
            }
            Ok(format!("pressed {combo}"))
        }
    }
}

// ---- shell -----------------------------------------------------------------------------

/// Runs a shell command (30 s timeout, output truncated).
pub fn run_command(cmd_str: &str, cwd: &std::path::Path, path_env: Option<&str>) -> Result<CommandOutput> {
    let trimmed = cmd_str.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Command cannot be empty"));
    }
    #[cfg(unix)]
    let mut c = {
        // zsh on macOS; most Linux installs only guarantee sh
        let shell = if std::path::Path::new("/bin/zsh").exists() { "/bin/zsh" } else { "/bin/sh" };
        let mut c = Command::new(shell);
        c.args(["-c", trimmed]);
        c
    };
    #[cfg(windows)]
    let mut c = {
        let mut c = Command::new("cmd");
        c.args(["/C", trimmed]);
        c
    };
    if let Some(p) = path_env {
        c.env("PATH", p);
    }
    c.current_dir(cwd).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let child = c.spawn()?;
    let (tx, rx) = std::sync::mpsc::channel();
    let id = child.id();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let output = match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(o) => o?,
        Err(_) => {
            #[cfg(unix)]
            let _ = Command::new("kill").arg("-9").arg(id.to_string()).status();
            #[cfg(windows)]
            let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &id.to_string()]).status();
            return Err(anyhow!("Command timed out after 30 seconds"));
        }
    };
    let cut = |b: &[u8]| {
        let s = String::from_utf8_lossy(b).trim().to_string();
        if s.chars().count() > 4000 {
            format!("{}… (truncated)", s.chars().take(4000).collect::<String>())
        } else {
            s
        }
    };
    Ok(CommandOutput { success: output.status.success(), stdout: cut(&output.stdout), stderr: cut(&output.stderr), exit_code: output.status.code() })
}

fn base64_encode(data: &[u8]) -> String {
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        result.push(CHARSET[(b0 >> 2) as usize] as char);
        result.push(CHARSET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        result.push(if chunk.len() > 1 { CHARSET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
        result.push(if chunk.len() > 2 { CHARSET[(b2 & 0x3f) as usize] as char } else { '=' });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"M"), "TQ==");
    }

    #[test]
    fn geometry_maps_and_clamps() {
        let g = ScreenGeometry { image_w: 1280, image_h: 800, scale: 1.5, origin_x: 0.0, origin_y: 0.0 };
        assert_eq!(g.to_screen(100.0, 200.0), (150, 300));
        assert_eq!(g.to_screen(5000.0, -3.0), (1919, 0));
    }

    #[test]
    fn parses_key_combos() {
        assert_eq!(parse_combo("cmd+shift+t").unwrap().len(), 3);
        assert!(matches!(parse_combo("Enter").unwrap()[0], enigo::Key::Return));
        assert!(parse_combo("cmd+banana").is_err());
        assert!(parse_combo("").is_err());
    }

    #[test]
    fn command_runs_with_timeout_wrapper() {
        let o = run_command("echo hi", std::path::Path::new("/tmp"), None).unwrap();
        assert!(o.success);
        assert_eq!(o.stdout, "hi");
    }
}
