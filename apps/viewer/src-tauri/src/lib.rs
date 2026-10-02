pub mod api;
pub mod commands;
pub mod error;
pub mod events;
pub mod loopback;
pub mod oauth;
pub mod servers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_servers,
            commands::add_server,
            commands::remove_server,
            commands::sign_in,
            commands::cancel_sign_in,
            commands::sign_out,
            commands::connect,
            commands::disconnect,
            commands::fetch_graph,
            commands::fetch_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
