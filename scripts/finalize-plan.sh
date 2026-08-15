#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <plan-path> <doc-name> [--archive-plan]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN_PATH="$1"
DOC_NAME="$2"
ARCHIVE_PLAN="${3:-}"
RECORD_DIR="${ROOT_DIR}/docs/records"
ARCHIVE_DIR="${ROOT_DIR}/docs/archive/plans/agent"
DOC_PATH="${RECORD_DIR}/${DOC_NAME}.md"
ARCHIVE_FILE="$(basename "${PLAN_PATH}")"
ARCHIVE_PATH="${ARCHIVE_DIR}/${ARCHIVE_FILE}"
ARCHIVE_RELATIVE_PATH="docs/archive/plans/agent/${ARCHIVE_FILE}"
SOURCE_PLAN="${PLAN_PATH}"

if [[ ! -f "${PLAN_PATH}" ]]; then
  echo "Plan not found: ${PLAN_PATH}"
  exit 1
fi

if [[ -f "${DOC_PATH}" ]]; then
  echo "Tech doc already exists: ${DOC_PATH}"
  exit 1
fi

if [[ "${ARCHIVE_PLAN}" == "--archive-plan" || "${ARCHIVE_PLAN}" == "--delete-plan" ]]; then
  if [[ -e "${ARCHIVE_PATH}" ]]; then
    echo "Archived plan already exists: ${ARCHIVE_PATH}"
    exit 1
  fi
  SOURCE_PLAN="${ARCHIVE_RELATIVE_PATH}"
fi

mkdir -p "${RECORD_DIR}" "${ARCHIVE_DIR}"

{
  echo "# ${DOC_NAME}"
  echo
  echo "## 1. 来源"
  echo
  echo "- Derived from plan: \`${SOURCE_PLAN}\`"
  echo
  echo "## 2. 实现与测试记录"
  echo
  cat "${PLAN_PATH}"
} > "${DOC_PATH}"

if [[ "${ARCHIVE_PLAN}" == "--archive-plan" || "${ARCHIVE_PLAN}" == "--delete-plan" ]]; then
  mv "${PLAN_PATH}" "${ARCHIVE_PATH}"
  echo "Archived original plan: ${ARCHIVE_PATH}"
fi

echo "Created tech doc: ${DOC_PATH}"
