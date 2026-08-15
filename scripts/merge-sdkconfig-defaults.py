#!/usr/bin/env python3
"""Merge tracked ESP-IDF defaults into a private sdkconfig.

The private file supplies credentials and machine-specific settings. Tracked
project defaults win for every symbol they declare so an old full sdkconfig
cannot silently undo a reviewed repository baseline.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
from typing import Dict, List, Optional, Set


SETTING_RE = re.compile(r"^(CONFIG_[A-Za-z0-9_]+)=.*$")
UNSET_RE = re.compile(r"^# (CONFIG_[A-Za-z0-9_]+) is not set$")


def setting_key(line: str) -> Optional[str]:
    for pattern in (SETTING_RE, UNSET_RE):
        match = pattern.match(line)
        if match:
            return match.group(1)
    return None


def load_defaults(path: pathlib.Path) -> Dict[str, str]:
    defaults: Dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        key = setting_key(line)
        if key:
            if key in defaults:
                raise ValueError(f"duplicate default symbol: {key}")
            defaults[key] = line
    if not defaults:
        raise ValueError(f"no CONFIG symbols found in {path}")
    return defaults


def merge(base: pathlib.Path, defaults_path: pathlib.Path, output: pathlib.Path) -> None:
    defaults = load_defaults(defaults_path)
    merged: List[str] = []
    written: Set[str] = set()

    for line in base.read_text(encoding="utf-8").splitlines():
        key = setting_key(line)
        if key not in defaults:
            merged.append(line)
            continue
        if key not in written:
            merged.append(defaults[key])
            written.add(key)

    missing = [line for key, line in defaults.items() if key not in written]
    if missing:
        merged.extend(("", "# Project defaults override private sdkconfig values."))
        merged.extend(missing)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(merged) + "\n", encoding="utf-8")
    os.chmod(output, 0o600)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True, type=pathlib.Path)
    parser.add_argument("--defaults", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    merge(args.base, args.defaults, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
