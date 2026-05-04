use std::sync::{Arc, Mutex};

use tauri::{Manager, State};
use wifi_rs::{prelude::*, WiFi};
use tauri_plugin_dialog::DialogExt;

// DS4 controller no longer needed, remove module reference

/// Ask macOS for the Location Services permission required to read SSIDs.
///
/// Just having `NSLocationWhenInUseUsageDescription` in Info.plist is not
/// enough — Apple requires the app to actively call CoreLocation, otherwise
/// the privacy prompt is never shown and CoreWLAN keeps censoring SSIDs.
/// The first call (status `notDetermined`) triggers the prompt; subsequent
/// calls are no-ops. We leak the manager so the system can deliver the
/// authorization callback without it being deallocated mid-flight.
///
/// This is also a no-op when `tauri dev` runs the unbundled binary, because
/// without an Info.plist macOS refuses to even consider the request.
#[cfg(target_os = "macos")]
fn request_location_permission() {
    use objc2_core_location::CLLocationManager;
    unsafe {
        let manager = CLLocationManager::new();
        manager.requestWhenInUseAuthorization();
        std::mem::forget(manager);
    }
}

#[tauri::command]
fn scan() -> Result<Vec<String>, String> {
    println!("scan");
    #[cfg(target_os = "macos")]
    request_location_permission();

    let mut ssids: Vec<String> = match wifi_scan::scan() {
        Ok(networks) => {
            println!("wifi_scan returned {} entries", networks.len());
            networks
                .into_iter()
                .filter_map(|w| if w.ssid.is_empty() { None } else { Some(w.ssid) })
                .collect()
        }
        Err(e) => {
            println!("wifi_scan error: {e:?}");
            Vec::new()
        }
    };

    // macOS-specific fallback: CoreWLAN returns empty SSIDs unless the binary
    // has been granted Location Services permission AND its bundle declares
    // NSLocationWhenInUseUsageDescription. In dev mode neither is true, so
    // shell out to `system_profiler SPAirPortDataType` — which works without
    // permission, but on macOS Sonoma 14+ / Sequoia 15+ the OS replaces every
    // SSID with the literal string "<redacted>" for the same privacy reason.
    // We still try it because some setups (older macOS, or systems where the
    // user has already granted location permission) get real SSIDs back.
    #[cfg(target_os = "macos")]
    if ssids.is_empty() {
        println!("wifi_scan returned no SSIDs — falling back to system_profiler");
        match scan_macos_system_profiler() {
            Ok(found) => {
                let total = found.len();
                let real: Vec<String> = found
                    .into_iter()
                    .filter(|s| s != "<redacted>")
                    .collect();
                println!("system_profiler returned {} SSIDs ({} real)", total, real.len());
                ssids = real;
            }
            Err(e) => {
                println!("system_profiler fallback failed: {e}");
            }
        }
    }

    // Dedupe while preserving order
    let mut seen = std::collections::HashSet::new();
    ssids.retain(|s| seen.insert(s.clone()));

    // On macOS, if every path returned nothing, the most likely cause is the
    // missing Location Services permission. Surface a clear error so the user
    // doesn't see an empty list and assume the AP is offline.
    #[cfg(target_os = "macos")]
    if ssids.is_empty() {
        return Err(
            "macOS hides Wi-Fi SSIDs from apps without Location Services \
             permission. As a workaround, connect to the Pico's \"Zephyros\" \
             access point from the macOS menu-bar Wi-Fi menu, then click \
             \"Open WebSocket Connection\" — no in-app scan is needed."
                .to_string(),
        );
    }

    Ok(ssids)
}

#[cfg(target_os = "macos")]
fn scan_macos_system_profiler() -> Result<Vec<String>, String> {
    let output = std::process::Command::new("system_profiler")
        .arg("SPAirPortDataType")
        .output()
        .map_err(|e| format!("Failed to launch system_profiler: {e}"))?;
    if !output.status.success() {
        return Err(format!("system_profiler exited with {}", output.status));
    }
    let text = String::from_utf8_lossy(&output.stdout);

    // Output format (whitespace-significant):
    //         en0:                              <- 8 sp, interface
    //           Current Network Information:    <- 10 sp, section header
    //             SomeSSID:                     <- 12 sp, SSID
    //               PHY Mode: ...               <- 14 sp, property
    //           Other Local Wi-Fi Networks:     <- 10 sp, section header
    //             AnotherSSID:                  <- 12 sp, SSID
    let mut ssids = Vec::new();
    let mut in_networks = false;
    for line in text.lines() {
        let leading = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Section headers at 10-space indent
        if leading == 10 && trimmed.ends_with(':') {
            in_networks = trimmed == "Current Network Information:"
                || trimmed == "Other Local Wi-Fi Networks:";
            continue;
        }
        // Anything indented < 12 ends the current networks section
        if leading < 12 {
            in_networks = false;
            continue;
        }
        // SSID lines at 12-space indent inside a networks section
        if in_networks && leading == 12 && trimmed.ends_with(':') {
            let ssid = trimmed[..trimmed.len() - 1].to_string();
            if !ssid.is_empty() {
                ssids.push(ssid);
            }
        }
    }
    Ok(ssids)
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
    // Trigger the macOS Location Services prompt at startup (no-op on first
    // call after install with the right Info.plist; otherwise silent).
    #[cfg(target_os = "macos")]
    request_location_permission();

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
