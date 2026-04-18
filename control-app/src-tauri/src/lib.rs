use std::sync::{Arc, Mutex};

use tauri::{Manager, State};
use wifi_rs::{prelude::*, WiFi};
use tauri_plugin_dialog::DialogExt;

// DS4 controller no longer needed, remove module reference

#[tauri::command]
fn scan() -> Result<Vec<String>, String> {
    println!("scan");
    match wifi_scan::scan() {
        Ok(networks) => {
            println!("{networks:?}");
            Ok(networks.into_iter().filter_map(|w| {
                if w.ssid.is_empty() { None } else { Some(w.ssid) }
            }).collect())
        }
        Err(e) => {
            println!("Scan error: {e:?}");
            Err(format!("{e:?}"))
        }
    }
}

#[tauri::command]
fn get_url() -> String {
    "ws://192.168.4.1/ws".to_string()
}

#[tauri::command]
fn connect(state: State<'_, AppData>, ssid: String) -> Option<String> {
    println!("Connect to {ssid}");
    let mut wifi = state.wifi.lock().unwrap();
    // Using hardcoded "password" for WPA2 authentication
    match wifi.connect(&ssid, "password") {
        Ok(result) => {
            if result == true {
                println!("Connection Successful.");
                // TODO: Discover with mDNS
                return Some("ws://192.168.4.1/ws".to_string());
            } else {
                println!("Invalid password.");
            }
        }
        Err(err) => println!("The following error occurred: {:?}", err),
    }
    None
}

#[tauri::command]
async fn save_csv(app: tauri::AppHandle, csv_content: String, default_name: String) -> Result<String, String> {
    use std::path::PathBuf;

    // Open native save dialog
    let file_path = app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("CSV", &["csv"])
        .blocking_save_file();

    match file_path {
        Some(path) => {
            let path_buf: PathBuf = path.as_path().unwrap().to_path_buf();
            std::fs::write(&path_buf, csv_content)
                .map_err(|e| format!("Failed to write file: {}", e))?;
            Ok(path_buf.display().to_string())
        }
        None => Ok("cancelled".to_string()),
    }
}


#[derive(Clone, Debug)]
struct AppData {
    wifi: Arc<Mutex<WiFi>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = Some(Config {
        interface: Some("en0"),
    });

    let wifi = Arc::new(Mutex::new(WiFi::new(config)));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan,
            connect,
            get_url,
            save_csv,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            app.get_webview_window("main").unwrap().open_devtools();

            app.manage(AppData {
                wifi,
            });


            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
