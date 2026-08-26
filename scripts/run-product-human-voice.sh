#!/bin/zsh
set -euo pipefail

umask 077

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${SCRIPT_DIR:h}"
AGENT_ROOT="$REPO_ROOT/agent"
CONFIG_DIR="${P4HOME_PRODUCT_VOICE_CONFIG_DIR:-$HOME/.config/p4home/product-voice}"
STATE_DIR="${P4HOME_PRODUCT_VOICE_STATE_DIR:-$HOME/Library/Application Support/p4home/product-voice}"

require_private_file() {
  local path="$1"
  test -f "$path"
  test ! -L "$path"
  local mode
  mode="$(/usr/bin/stat -f '%Lp' "$path")"
  [[ "$mode" == "600" || "$mode" == "400" ]]
}

test -d "$CONFIG_DIR"
test "$(/usr/bin/stat -f '%Lp' "$CONFIG_DIR")" = "700"
for private_file in device-id device-token agent-key.pem agent-cert.pem stt-model-path tts-model-path agent-port; do
  require_private_file "$CONFIG_DIR/$private_file"
done

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

P4HOME_NODE_BIN="${P4HOME_NODE_BIN:-$HOME/.nvm/versions/node/v24.19.0/bin/node}"
test -x "$P4HOME_NODE_BIN"
test "$($P4HOME_NODE_BIN --version)" = "v24.19.0"

device_id="$(<"$CONFIG_DIR/device-id")"
stt_model="$(<"$CONFIG_DIR/stt-model-path")"
tts_model="$(<"$CONFIG_DIR/tts-model-path")"
agent_port="$(<"$CONFIG_DIR/agent-port")"
[[ "$device_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]
[[ "$agent_port" == <-> ]]
(( agent_port >= 1 && agent_port <= 65535 ))
test -d "$stt_model"
test -d "$tts_model"

export P4HOME_PRODUCT_ROLE_MODE="human-only"
export P4HOME_AGENT_DEVICE_ID="$device_id"
export P4HOME_AGENT_DEVICE_TOKEN_FILE="$CONFIG_DIR/device-token"
export P4HOME_AGENT_TLS_KEY_FILE="$CONFIG_DIR/agent-key.pem"
export P4HOME_AGENT_TLS_CERT_FILE="$CONFIG_DIR/agent-cert.pem"
export P4HOME_AGENT_HOST="0.0.0.0"
export P4HOME_AGENT_PORT="$agent_port"
export P4HOME_PRODUCT_AUDIT_DB="$STATE_DIR/audit.sqlite"
export P4HOME_STT_PYTHON="$AGENT_ROOT/packages/provider-stt/python/.venv/bin/python"
export P4HOME_STT_WORKER="$AGENT_ROOT/packages/provider-stt/python/p4home_stt_worker.py"
export P4HOME_STT_MODEL="$stt_model"
export P4HOME_TTS_PYTHON="$AGENT_ROOT/packages/provider-tts/python/.venv/bin/python"
export P4HOME_TTS_WORKER="$AGENT_ROOT/packages/provider-tts/python/p4home_tts_worker.py"
export P4HOME_TTS_MODEL="$tts_model"

cd "$AGENT_ROOT"
exec "$P4HOME_NODE_BIN" --import tsx apps/runtime/src/product-voice-main.ts
