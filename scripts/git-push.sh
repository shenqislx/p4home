#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Current directory is not a git repository."
  exit 1
fi

if [[ "${1:-}" != "--reviewed" ]]; then
  echo "Push blocked: review confirmation required."
  echo "Usage: $0 --reviewed"
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"

if [[ -z "${CURRENT_BRANCH}" ]]; then
  echo "Unable to determine current branch."
  exit 1
fi

P4HOME_REVIEW_CONFIRMED=1 git push -u origin "${CURRENT_BRANCH}"
