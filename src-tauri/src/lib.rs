mod companion;
mod imports;
mod scanner;
mod symbols;

use scanner::{save_map, scan_repository_path};

pub use companion::{generate_token, serve_blocking, DEFAULT_PORT};
pub use scanner::scan_repository_path as scan_path;

use std::path::Path;

use tauri::{AppHandle, Manager};

#[tauri::command]
async fn scan_repository(app: AppHandle, path: String) -> Result<scanner::RepositoryGraph, String> {
    let graph = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || scan_repository_path(Path::new(&path))
    })
    .await
    .map_err(|_| "Repository scan stopped unexpectedly.".to_owned())??;
    if let Some(companion) = app.try_state::<companion::CompanionControl>() {
        companion.remember_root(Path::new(&path));
    }
    Ok(graph)
}

/// Starts the Codebase Atlas desktop application.
///
/// # Panics
///
/// Panics if Tauri cannot initialize or run the application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            companion::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_map,
            scan_repository,
            companion::start_companion,
            companion::stop_companion,
            companion::companion_status,
            companion::share_companion_root,
            companion::unshare_companion_root,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
