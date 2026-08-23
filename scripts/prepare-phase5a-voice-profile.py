#!/usr/bin/env python3
"""Apply the non-secret Phase 5A audio/SR validation overrides atomically."""

from __future__ import annotations

import argparse
import os
import pathlib
import tempfile


REQUIRED = {
    "CONFIG_P4HOME_SR_ENABLE": "y",
    "CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST": "y",
    "CONFIG_P4HOME_PHASE5A_VALIDATION": "y",
}
DISABLED = {"CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED"}


def update(lines: list[str]) -> list[str]:
    found: set[str] = set()
    output: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0] if line.startswith("CONFIG_") and "=" in line else None
        disabled_key = None
        if line.startswith("# CONFIG_") and line.endswith(" is not set"):
            disabled_key = line[2:].removesuffix(" is not set")
        candidate = key or disabled_key
        if candidate in REQUIRED:
            output.append(f"{candidate}={REQUIRED[candidate]}")
            found.add(candidate)
        elif candidate in DISABLED:
            output.append(f"# {candidate} is not set")
            found.add(candidate)
        else:
            output.append(line)
    missing = (set(REQUIRED) | DISABLED) - found
    for key in sorted(missing):
        if key in REQUIRED:
            output.append(f"{key}={REQUIRED[key]}")
        else:
            output.append(f"# {key} is not set")
    return output


def prepare(path: pathlib.Path) -> None:
    if not path.is_file() or path.is_symlink():
        raise ValueError("Phase 5A sdkconfig must be a non-symlink regular file")
    original_mode = path.stat().st_mode & 0o777
    lines = path.read_text(encoding="utf-8").splitlines()
    updated = update(lines)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as handle:
        handle.write("\n".join(updated) + "\n")
        temporary = pathlib.Path(handle.name)
    try:
        temporary.chmod(original_mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sdkconfig", required=True, type=pathlib.Path)
    args = parser.parse_args()
    prepare(args.sdkconfig)


if __name__ == "__main__":
    main()
