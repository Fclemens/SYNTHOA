#!/bin/sh
# Prepare the /app/data volume on startup:
#  - seed prompt templates from image defaults on first run
#  - symlink the runtime paths the app expects (prompts/, settings_override.json)
#    onto the persistent volume so edits survive container restarts
set -e

DATA_DIR="/app/data"
mkdir -p "$DATA_DIR" "$DATA_DIR/prompts"

# Seed default prompt templates on first run (never overwrites existing files)
if [ -d /app/prompts-default ]; then
    for f in /app/prompts-default/*.txt; do
        [ -e "$f" ] || continue
        name="$(basename "$f")"
        if [ ! -f "$DATA_DIR/prompts/$name" ]; then
            cp "$f" "$DATA_DIR/prompts/$name"
        fi
    done
fi

# Settings override file (empty object if first run)
if [ ! -f "$DATA_DIR/settings_override.json" ]; then
    echo '{}' > "$DATA_DIR/settings_override.json"
fi

# Point the app's runtime paths at the volume
rm -rf /app/prompts
ln -sf "$DATA_DIR/prompts" /app/prompts
ln -sf "$DATA_DIR/settings_override.json" /app/settings_override.json

exec "$@"
