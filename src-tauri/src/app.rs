//! Thin Tauri adapter over the Codebase Atlas library API.

use std::{fs, path::Path};

use tauri::{AppHandle, Manager};

use crate::{RepositoryGraph, companion, scan};

#[tauri::command]
async fn scan_repository(app: AppHandle, path: String) -> Result<RepositoryGraph, String> {
    let graph = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || scan(Path::new(&path))
    })
    .await
    .map_err(|_| "Repository scan stopped unexpectedly.".to_owned())??;
    if let Some(companion) = app.try_state::<companion::CompanionControl>() {
        companion.remember_root(Path::new(&path));
    }
    Ok(graph)
}

#[tauri::command]
fn save_map(path: String, contents: String) -> Result<(), String> {
    fs::write(path, contents).map_err(|error| format!("Could not save the map file: {error}"))
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
