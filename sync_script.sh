#!/bin/bash

# --- CONFIGURATION ---
FILE_LOCAL="/Users/gilles/Documents/Github/zephyros/python/code.py"
FILE_REMOTE="/Volumes/CIRCUITPY/code.py"

# --- SYNC LOGIC ---
sync_files() {
    echo "[$(date +%H:%M:%S)] Change detected. Syncing..."
    # -u ensures we only overwrite if the source is newer than the destination
    rsync -u "$FILE_LOCAL" "$FILE_REMOTE"
    rsync -u "$FILE_REMOTE" "$FILE_LOCAL"
    echo "Done."
}

# Initial sync on startup
sync_files

# Watch both files for changes
# -o: provides the file path in the output
# -0: uses a null character separator (safer for paths with spaces)
fswatch -o "$FILE_LOCAL" "$FILE_REMOTE" | while read -r line; do
    sync_files
done