# Control software for a wind tunnel for P&O 2 #
Code for control software for a windtunnel. (Made for P&O 2 at KU Leuven)

## macOS install guide:
1. Download the correct installer from the releases (Apple Silicon or Intel)
2. Drag the app into the Applications folder
3. Run this in the terminal: `sudo xattr -dr com.apple.quarantine '/Applications/Zephyros Control App.app'`
4. Enjoy

## Building instructions:
Run `npm run tauri build`

## How to run (for dev mode):
1. Install dependencies (Rust, Node)
2. Run `npm install`
3. Run `npm run tauri dev`
