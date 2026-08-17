mod scanner;

use scanner::scan_repository;

/// Starts the Codebase Atlas desktop application.
///
/// # Panics
///
/// Panics if Tauri cannot initialize or run the application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![scan_repository])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
