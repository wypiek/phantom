// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Helper mode: report the current Screen Recording permission and exit
    // (the running app's own answer is cached by macOS until it restarts).
    if std::env::args().any(|a| a == phantom_lib::SCREEN_PROBE_ARG) {
        println!("{}", if phantom_lib::probe_screen_permission() { 1 } else { 0 });
        return;
    }
    phantom_lib::run()
}
