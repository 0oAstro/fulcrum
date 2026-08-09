#!/usr/bin/env bash
#
# Migrate sessions from ~/.fulcrum/*.jsonl to the flat session directory.
# This fixes sessions saved to ~/.fulcrum/ instead of ~/.fulcrum/sessions/.
#
# Usage: ./migrate-sessions.sh [--dry-run]
#

set -e

AGENT_DIR="${FULCRUM_AGENT_DIR:-$HOME/.fulcrum}"
DRY_RUN=false

if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "Dry run mode - no files will be moved"
    echo
fi

# Find all .jsonl files directly in agent dir (not in subdirectories)
shopt -s nullglob
files=("$AGENT_DIR"/*.jsonl)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
    echo "No session files found in $AGENT_DIR"
    exit 0
fi

echo "Found ${#files[@]} session file(s) to migrate"
echo

migrated=0
failed=0

for file in "${files[@]}"; do
    filename=$(basename "$file")
    
    # Read the first line and verify that it is a session header.
    if ! first_line=$(head -1 "$file" 2>/dev/null); then
        echo "SKIP: $filename - cannot read file"
        ((failed++))
        continue
    fi
    
    if ! session_id=$(jq -r 'if .type == "session" then .id // empty else empty end' <<<"$first_line" 2>/dev/null); then
        echo "SKIP: $filename - invalid JSON"
        ((failed++))
        continue
    fi

    if [[ -z "$session_id" ]]; then
        echo "SKIP: $filename - invalid session header"
        ((failed++))
        continue
    fi

    target_dir="$AGENT_DIR/sessions"
    target_file="$target_dir/$filename"
    
    if [[ -e "$target_file" ]]; then
        echo "SKIP: $filename - target already exists"
        ((failed++))
        continue
    fi
    
    echo "MIGRATE: $filename"
    echo "    id:  $session_id"
    echo "    to:  $target_dir/"
    
    if [[ "$DRY_RUN" == false ]]; then
        mkdir -p "$target_dir"
        mv "$file" "$target_file"
    fi
    
    ((migrated++))
    echo
done

echo "---"
echo "Migrated: $migrated"
echo "Skipped:  $failed"

if [[ "$DRY_RUN" == true && $migrated -gt 0 ]]; then
    echo
    echo "Run without --dry-run to perform the migration"
fi
