#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path


ENTITY_PATTERN = re.compile(r"(light|switch)\.([a-z0-9_]+)")
SERIAL_ENTITY_PATTERN = re.compile(
    rb"(?<![a-z0-9_])(?:alarm_control_panel|binary_sensor|button|calendar|camera|"
    rb"climate|cover|device_tracker|event|fan|humidifier|input_boolean|input_button|"
    rb"input_datetime|input_number|input_select|input_text|light|lock|media_player|"
    rb"number|person|remote|scene|script|select|sensor|siren|sun|switch|text|timer|"
    rb"update|vacuum|valve|water_heater|weather|zone)\.[a-z0-9_]{1,255}"
)


def sanitize_monitor(
    log_path: Path,
    output_path: Path,
    entity_path: Path,
    status_path: Path,
) -> None:
    output_path.unlink(missing_ok=True)
    status_path.unlink(missing_ok=True)
    entity_id = entity_path.read_text(encoding="utf-8").strip()
    if ENTITY_PATTERN.fullmatch(entity_id) is None:
        raise ValueError("Phase 4C entity id is invalid")
    original = log_path.read_bytes()
    def redact(match: re.Match[bytes]) -> bytes:
        return b"[entity-redacted]".ljust(len(match.group(0)), b"_")[: len(match.group(0))]

    sanitized = SERIAL_ENTITY_PATTERN.sub(redact, original)
    if SERIAL_ENTITY_PATTERN.search(sanitized) is not None or len(sanitized) != len(original):
        raise ValueError("Phase 4C serial sanitization failed")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(f"{output_path.name}.phase4c-sanitized")
    temporary.write_bytes(sanitized)
    temporary.replace(output_path)
    status_path.write_text("1\n", encoding="utf-8")
    status_path.chmod(0o600)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--entity-file", required=True, type=Path)
    parser.add_argument("--status-file", required=True, type=Path)
    args = parser.parse_args()
    sanitize_monitor(args.log, args.output, args.entity_file, args.status_file)


if __name__ == "__main__":
    main()
