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
  test -f "$path" || return 1
  test ! -L "$path" || return 1
  local mode
  mode="$(/usr/bin/stat -f '%Lp' "$path")" || return 1
  [[ "$mode" == "600" || "$mode" == "400" ]]
}

test -d "$CONFIG_DIR"
test "$(/usr/bin/stat -f '%Lp' "$CONFIG_DIR")" = "700"
for private_file in device-id device-token agent-key.pem agent-cert.pem stt-model-path tts-model-path agent-port; do
  require_private_file "$CONFIG_DIR/$private_file"
done
if [[ -e "$CONFIG_DIR/device-port" || -L "$CONFIG_DIR/device-port" ]]; then
  require_private_file "$CONFIG_DIR/device-port"
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

P4HOME_NODE_BIN="${P4HOME_NODE_BIN:-$HOME/.nvm/versions/node/v24.19.0/bin/node}"
test -x "$P4HOME_NODE_BIN"
test "$($P4HOME_NODE_BIN --version)" = "v24.19.0"

device_id="$(<"$CONFIG_DIR/device-id")"
stt_model="$(<"$CONFIG_DIR/stt-model-path")"
tts_model="$(<"$CONFIG_DIR/tts-model-path")"
agent_port="$(<"$CONFIG_DIR/agent-port")"
device_port="18444"
if [[ -f "$CONFIG_DIR/device-port" ]]; then
  device_port="$(<"$CONFIG_DIR/device-port")"
fi
[[ "$device_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]
[[ "$agent_port" == <-> ]]
[[ "$device_port" == <-> ]]
(( agent_port >= 1 && agent_port <= 65535 ))
(( device_port >= 1 && device_port <= 65535 && device_port != agent_port ))
test -d "$stt_model"
test -d "$tts_model"

export P4HOME_PRODUCT_ROLE_MODE="human-only"
# A private persisted setting, rather than an inherited environment variable,
# explicitly opts an installed product into the existing Robot allowlist.
if [[ -e "$CONFIG_DIR/role-mode" || -L "$CONFIG_DIR/role-mode" ]]; then
  require_private_file "$CONFIG_DIR/role-mode"
  role_mode="$(<"$CONFIG_DIR/role-mode")"
  [[ "$role_mode" == "human-only" || "$role_mode" == "human-robot" ]]
  export P4HOME_PRODUCT_ROLE_MODE="$role_mode"
fi
unset P4HOME_HA_URL P4HOME_HA_TOKEN_FILE P4HOME_HA_POLICY_FILE P4HOME_HA_ALLOW_INSECURE
if [[ "$P4HOME_PRODUCT_ROLE_MODE" == "human-robot" ]]; then
  # The existing private HA configuration stays outside the repository.
  ha_config_dir="${P4HOME_PRODUCT_HA_CONFIG_DIR:-$HOME/.config/p4home}"
  for ha_file in robot-ha.url robot-ha.token robot-ha-policy.json; do
    require_private_file "$ha_config_dir/$ha_file"
  done
  export P4HOME_HA_URL="$(<"$ha_config_dir/robot-ha.url")"
  export P4HOME_HA_TOKEN_FILE="$ha_config_dir/robot-ha.token"
  export P4HOME_HA_POLICY_FILE="$ha_config_dir/robot-ha-policy.json"
  export P4HOME_HA_ALLOW_INSECURE="0"
  if [[ -e "$CONFIG_DIR/ha-allow-insecure" || -L "$CONFIG_DIR/ha-allow-insecure" ]]; then
    require_private_file "$CONFIG_DIR/ha-allow-insecure"
    ha_allow_insecure="$(<"$CONFIG_DIR/ha-allow-insecure")"
    [[ "$ha_allow_insecure" == "0" || "$ha_allow_insecure" == "1" ]]
    export P4HOME_HA_ALLOW_INSECURE="$ha_allow_insecure"
  fi
fi
export P4HOME_AGENT_DEVICE_ID="$device_id"
export P4HOME_AGENT_DEVICE_TOKEN_FILE="$CONFIG_DIR/device-token"
export P4HOME_AGENT_TLS_KEY_FILE="$CONFIG_DIR/agent-key.pem"
export P4HOME_AGENT_TLS_CERT_FILE="$CONFIG_DIR/agent-cert.pem"
export P4HOME_AGENT_HOST="0.0.0.0"
export P4HOME_AGENT_PORT="$agent_port"
export P4HOME_DEVICE_PORT="$device_port"
export P4HOME_DEVICE_PROTOCOL_VERSION="3"
if [[ -e "$CONFIG_DIR/device-protocol-version" || -L "$CONFIG_DIR/device-protocol-version" ]]; then
  require_private_file "$CONFIG_DIR/device-protocol-version"
  device_protocol_version="$(<"$CONFIG_DIR/device-protocol-version")"
  [[ "$device_protocol_version" == "3" || "$device_protocol_version" == "4" ]]
  export P4HOME_DEVICE_PROTOCOL_VERSION="$device_protocol_version"
fi
export P4HOME_CAT_AUTONOMY_ENABLED="0"
unset P4HOME_CAT_AUTONOMY_CONFIG_FILE P4HOME_CAT_AUTONOMY_CONTROL_TOKEN_FILE
if [[ -e "$CONFIG_DIR/cat-enabled" || -L "$CONFIG_DIR/cat-enabled" ]]; then
  if require_private_file "$CONFIG_DIR/cat-enabled" && [[ "$(<"$CONFIG_DIR/cat-enabled")" == "1" ]]; then
    export P4HOME_CAT_AUTONOMY_ENABLED="1"
    export P4HOME_CAT_AUTONOMY_CONFIG_FILE="$CONFIG_DIR/cat-autonomy.json"
    export P4HOME_CAT_AUTONOMY_CONTROL_TOKEN_FILE="$CONFIG_DIR/cat-control-token"
    export P4HOME_CAT_AUTONOMY_CONTROL_PORT="9477"
  fi
fi
export P4HOME_PRODUCT_AUDIT_DB="$STATE_DIR/audit.sqlite"
export P4HOME_STT_PYTHON="$AGENT_ROOT/packages/provider-stt/python/.venv/bin/python"
export P4HOME_STT_WORKER="$AGENT_ROOT/packages/provider-stt/python/p4home_stt_worker.py"
export P4HOME_STT_MODEL="$stt_model"
export P4HOME_TTS_PYTHON="$AGENT_ROOT/packages/provider-tts/python/.venv/bin/python"
export P4HOME_TTS_WORKER="$AGENT_ROOT/packages/provider-tts/python/p4home_tts_worker.py"
export P4HOME_TTS_MODEL="$tts_model"
export P4HOME_TTS_ENGINE="kokoro"
if [[ -e "$CONFIG_DIR/tts-engine" || -L "$CONFIG_DIR/tts-engine" ]]; then
  require_private_file "$CONFIG_DIR/tts-engine"
  tts_engine="$(<"$CONFIG_DIR/tts-engine")"
  [[ "$tts_engine" == "kokoro" || "$tts_engine" == "qwen3" ]]
  export P4HOME_TTS_ENGINE="$tts_engine"
fi

cd "$AGENT_ROOT"
exec "$P4HOME_NODE_BIN" --import tsx apps/runtime/src/product-voice-main.ts
