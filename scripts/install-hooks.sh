#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Current directory is not a git repository."
  echo "Initialize git first, then rerun this script."
  exit 1
fi

git config core.hooksPath "${ROOT_DIR}/.githooks"
echo "Configured core.hooksPath=${ROOT_DIR}/.githooks"

