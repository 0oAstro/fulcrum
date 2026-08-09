#!/usr/bin/env bash
set -euo pipefail

SOURCE_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE_PATH" ]]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE_PATH")" && pwd)"
  SOURCE_PATH="$(readlink "$SOURCE_PATH")"
  if [[ "$SOURCE_PATH" != /* ]]; then
    SOURCE_PATH="$SOURCE_DIR/$SOURCE_PATH"
  fi
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE_PATH")" && pwd)"
export FULCRUM_LAUNCHER_PATH="$SCRIPT_DIR/fulcrum.sh"
if BUILD_ID="$(git -C "$SCRIPT_DIR" describe --tags --always --dirty 2>/dev/null)"; then
  export FULCRUM_BUILD_ID="$BUILD_ID"
fi

# Check for --no-env / --dist flags
NO_ENV=false
USE_DIST=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  elif [[ "$arg" == "--dist" ]]; then
    USE_DIST=true
  else
    ARGS+=("$arg")
  fi
done

if [[ "$NO_ENV" == "true" ]]; then
  # Unset API keys (see packages/ai/src/env-api-keys.ts)
  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_OAUTH_TOKEN
  unset OPENAI_API_KEY
  unset GEMINI_API_KEY
  unset GROQ_API_KEY
  unset CEREBRAS_API_KEY
  unset XAI_API_KEY
  unset OPENROUTER_API_KEY
  unset ZAI_API_KEY
  unset MISTRAL_API_KEY
  unset MINIMAX_API_KEY
  unset MINIMAX_CN_API_KEY
  unset AI_GATEWAY_API_KEY
  unset OPENCODE_API_KEY
  unset COPILOT_GITHUB_TOKEN
  unset GH_TOKEN
  unset GITHUB_TOKEN
  unset HF_TOKEN
  unset GOOGLE_APPLICATION_CREDENTIALS
  unset GOOGLE_CLOUD_PROJECT
  unset GCLOUD_PROJECT
  unset GOOGLE_CLOUD_LOCATION
  unset AWS_PROFILE
  unset AWS_ACCESS_KEY_ID
  unset AWS_SECRET_ACCESS_KEY
  unset AWS_SESSION_TOKEN
  unset AWS_REGION
  unset AWS_DEFAULT_REGION
  unset AWS_BEARER_TOKEN_BEDROCK
  unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  unset AWS_CONTAINER_CREDENTIALS_FULL_URI
  unset AWS_WEB_IDENTITY_TOKEN_FILE
  unset AZURE_OPENAI_API_KEY
  unset AZURE_OPENAI_BASE_URL
  unset AZURE_OPENAI_RESOURCE_NAME
  echo "Running Fulcrum without API keys..."
fi

# --dist runs the bundled build (what users get; ~3x faster startup than tsx).
if [[ "$USE_DIST" == "true" ]]; then
  BUNDLE="$SCRIPT_DIR/packages/coding-agent/dist/bundle/cli.js"
  if [[ ! -f "$BUNDLE" ]]; then
    echo "Bundle not found at $BUNDLE. Run npm run build first." >&2
    exit 1
  fi
  exec node "$BUNDLE" ${ARGS[@]+"${ARGS[@]}"}
fi

TSX_DIR="$SCRIPT_DIR/node_modules/tsx"
TSX_PREFLIGHT="$TSX_DIR/dist/preflight.cjs"
TSX_LOADER="$TSX_DIR/dist/loader.mjs"
if [[ ! -f "$TSX_PREFLIGHT" || ! -f "$TSX_LOADER" ]]; then
  echo "tsx not found at $TSX_DIR. Run npm install from the repo root first." >&2
  exit 1
fi

# Source workspaces resolve through the root aliases; do not inherit an unrelated tsx config.
export TSX_TSCONFIG_PATH="$SCRIPT_DIR/tsconfig.json"

# Avoid the tsx CLI wrapper so cli.ts owns the foreground process and its title.
exec node --require "$TSX_PREFLIGHT" --import "$TSX_LOADER" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
