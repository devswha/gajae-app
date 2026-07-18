#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;

use fs2::FileExt;

mod supervisor;

struct SingleInstanceLock(std::fs::File);

fn acquire_single_instance_lock() -> Result<SingleInstanceLock, String> {
    let lock_path = std::env::temp_dir().join("gajae-app-desktop.lock");
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| format!("could not open desktop instance lock: {error}"))?;
    file.try_lock_exclusive()
        .map_err(|_| "Gajae App is already running.".to_owned())?;
    Ok(SingleInstanceLock(file))
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let lock = acquire_single_instance_lock().map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            app.manage(lock);
            supervisor::start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Gajae App desktop shell");
}
