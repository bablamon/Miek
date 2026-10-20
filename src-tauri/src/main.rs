#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive;
mod commons;
mod library;
mod local;
mod player;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(player::Player::new())
        .invoke_handler(tauri::generate_handler![
            player::player_load,
            player::player_toggle,
            player::player_seek,
            player::player_volume,
            player::player_state,
            local::local_get,
            local::local_set_folders,
            local::local_scan,
            archive::ia_search,
            archive::ia_shelf,
            archive::ia_item,
            commons::commons_search,
            library::library_load,
            library::library_save
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Miek");
}
