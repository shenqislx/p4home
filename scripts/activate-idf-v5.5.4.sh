#!/bin/sh

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
USER_ACTIVATE_SCRIPT="$HOME/.espressif/tools/activate_idf_v5.5.4.sh"

is_sourced() {
    if [ -n "$ZSH_VERSION" ]; then
        case $ZSH_EVAL_CONTEXT in *:file:*) return 0 ;; esac
    else
        case ${0##*/} in dash|-dash|bash|-bash|ksh|-ksh|sh|-sh) return 0 ;; esac
    fi
    return 1
}

if [ ! -f "$USER_ACTIVATE_SCRIPT" ]; then
    echo "Missing user-level activation script: $USER_ACTIVATE_SCRIPT"
    echo "Install ESP-IDF v5.5.4 first."
    return 1 2>/dev/null || exit 1
fi

is_sourced || {
    echo "This script should be sourced, not executed."
    echo "Use: . $PROJECT_ROOT/scripts/activate-idf-v5.5.4.sh"
    exit 1
}

. "$USER_ACTIVATE_SCRIPT"

IDF_VERSION_OUTPUT=$(idf.py --version 2>/dev/null || true)

case "$IDF_VERSION_OUTPUT" in
    *"ESP-IDF v5.5.4"*)
        ;;
    *)
        echo "Unexpected ESP-IDF version after activation: $IDF_VERSION_OUTPUT"
        return 1
        ;;
esac
