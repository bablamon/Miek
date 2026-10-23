#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive;
mod commons;
mod library;
mod local;
mod player;
mod slsk;
mod update;
mod ytdlp;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(player::Player::new())
        .setup(|app| {
            slsk::boot();
            if update::configured(app.handle()) {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            player::player_load,
            player::player_toggle,
            player::player_pause,
            player::player_resume,
            player::player_seek,
            player::player_volume,
            player::player_state,
            player::player_prefetch,
            local::local_get,
            local::local_set_folders,
            local::local_scan,
            archive::ia_search,
            archive::ia_shelf,
            archive::ia_item,
            archive::ia_subject,
            commons::commons_search,
            library::library_load,
            library::library_save,
            slsk::slsk_status,
            slsk::slsk_config_get,
            slsk::slsk_config_set,
            slsk::slsk_search,
            slsk::slsk_results,
            slsk::slsk_stream,
            slsk::slsk_transfer,
            slsk::slsk_cancel,
            slsk::slsk_stop_streams,
            slsk::slsk_save,
            update::app_version,
            update::update_check,
            update::update_install,
            update::update_progress,
            ytdlp::yt_status,
            ytdlp::yt_search,
            ytdlp::yt_resolve,
            ytdlp::yt_update
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Miek");
}
