#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <plan-path> <doc-name> [--delete-plan]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN_PATH="$1"
DOC_NAME="$2"
DELETE_PLAN="${3:-}"
DOC_PATH="${ROOT_DIR}/docs/${DOC_NAME}.md"

if [[ ! -f "${PLAN_PATH}" ]]; then
  echo "Plan not found: ${PLAN_PATH}"
  exit 1
fi

if [[ -f "${DOC_PATH}" ]]; then
  echo "Tech doc already exists: ${DOC_PATH}"
  exit 1
fi

{
  echo "# ${DOC_NAME}"
  echo
  echo "## 1. 来源"
  echo
  echo "- Derived from plan: \`${PLAN_PATH}\`"
  echo
  echo "## 2. 实现与测试记录"
  echo
  cat "${PLAN_PATH}"
} > "${DOC_PATH}"

if [[ "${DELETE_PLAN}" == "--delete-plan" ]]; then
  rm -f "${PLAN_PATH}"
  echo "Deleted original plan: ${PLAN_PATH}"
fi

echo "Created tech doc: ${DOC_PATH}"
