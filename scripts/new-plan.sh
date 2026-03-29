#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <feature-name>"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN_DIR="${ROOT_DIR}/docs/plans"
TEMPLATE="${ROOT_DIR}/docs/templates/feature-plan-template.md"

mkdir -p "${PLAN_DIR}"

DATE_STR="$(date +%F)"
FEATURE_NAME="$1"
PLAN_PATH="${PLAN_DIR}/${DATE_STR}-${FEATURE_NAME}-plan.md"

if [[ -f "${PLAN_PATH}" ]]; then
  echo "Plan already exists: ${PLAN_PATH}"
  exit 1
fi

cp "${TEMPLATE}" "${PLAN_PATH}"
sed -i.bak "s/<Feature Name> Plan/${FEATURE_NAME} Plan/g" "${PLAN_PATH}"
rm -f "${PLAN_PATH}.bak"

echo "Created: ${PLAN_PATH}"

