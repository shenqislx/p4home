#!/usr/bin/env python3
"""Sanitize Phase 7 upload candidates and fail closed on credentials or HA ids."""

from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib


ALLOWED_RESULT_KEYS = {
    "schema_version",
    "profile",
    "passed",
    "model",
    "real_model_calls",
    "protocol_version",
    "timer_action_completed",
    "ha_projected_action_completed",
    "ha_projection_origin",
    "p4_actions_completed",
    "p4_reconnect_snapshot_verified",
    "p4_state_version",
    "ha_client_ready",
    "ha_policy_aliases",
    "ha_service_calls_dispatched",
    "ha_invalid_outbound_frames",
    "robot_non_admin",
    "robot_non_owner",
    "pause_blocked_model_calls",
    "disable_blocked_model_calls",
    "stability_observation_ms",
    "rss_peak_growth_bytes",
    "rss_growth_limit_bytes",
    "heap_peak_growth_bytes",
    "execution_terminal_records",
    "request_contains_ha_token",
    "request_contains_entity_id",
    "reason",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--monitor", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--result", type=pathlib.Path)
    parser.add_argument("--ha-policy", required=True, type=pathlib.Path)
    parser.add_argument("--secret-file", action="append", default=[], type=pathlib.Path)
    parser.add_argument("--status-file", required=True, type=pathlib.Path)
    return parser.parse_args()


def fail(message: str) -> None:
    raise SystemExit(message)


def encoded_variants(value: bytes) -> set[bytes]:
    base64_value = base64.b64encode(value)
    urlsafe_base64_value = base64.urlsafe_b64encode(value)
    variants = {
        value,
        base64_value,
        base64_value.rstrip(b"="),
        urlsafe_base64_value,
        urlsafe_base64_value.rstrip(b"="),
    }
    try:
        text = value.decode("utf-8")
    except UnicodeDecodeError:
        return variants
    variants.add(json.dumps(text, ensure_ascii=True)[1:-1].encode("ascii"))
    variants.add(json.dumps(text, ensure_ascii=False)[1:-1].encode("utf-8"))
    return {variant for variant in variants if variant}


def private_representations(value: bytes) -> set[bytes]:
    """Enumerate complete and truncation-safe raw/encoded private material."""
    raw_values = {value}
    for width in (16, 17, 18):
        if len(value) < width:
            continue
        raw_values.update(
            value[offset : offset + width]
            for offset in range(0, len(value) - width + 1)
        )
    variants: set[bytes] = set()
    for raw in raw_values:
        variants.update(encoded_variants(raw))
    return variants


def contains_private_fragment(candidates: bytes, value: bytes) -> bool:
    return any(
        variant in candidates for variant in private_representations(value)
    )


def redact_private_value(candidates: bytes, value: bytes) -> tuple[bytes, int]:
    """Redact complete, encoded, and >=16-byte truncated representations."""
    redacted = candidates
    replacements = 0
    for variant in sorted(private_representations(value), key=len, reverse=True):
        count = redacted.count(variant)
        if count == 0:
            continue
        redacted = redacted.replace(variant, b"[REDACTED_HA_ENTITY]")
        replacements += count
    return redacted, replacements


def write_private_text(path: pathlib.Path, value: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        os.write(descriptor, value.encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_monitor(path: pathlib.Path, monitor: bytes, marker: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
        try:
            os.write(descriptor, monitor)
            if monitor and not monitor.endswith(b"\n"):
                os.write(descriptor, b"\n")
            os.write(descriptor, marker)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def policy_entity_ids(path: pathlib.Path) -> list[bytes]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("entities"), list):
        fail("Phase 7 HA policy has an invalid schema")
    entity_ids: list[bytes] = []
    for entity in value["entities"]:
        if not isinstance(entity, dict) or not isinstance(entity.get("entity_id"), str):
            fail("Phase 7 HA policy entity is invalid")
        entity_id = entity["entity_id"].encode("utf-8")
        if not entity_id:
            fail("Phase 7 HA policy entity id is empty")
        entity_ids.append(entity_id)
    if not entity_ids:
        fail("Phase 7 HA policy has no entities")
    return entity_ids


def assert_monitor_health(monitor: bytes) -> None:
    lowered = monitor.lower()
    for marker in (
        b"guru meditation",
        b"panic'ed",
        b"task watchdog",
        b"brownout",
        b"assert failed",
        b"backtrace:",
    ):
        if marker in lowered:
            fail(f"crash marker present in Phase 7 monitor: {marker.decode()}")
    if monitor.count(b"rst:0x") > 1:
        fail("reset loop present in Phase 7 monitor")


def sanitize_monitor_entities(
    monitor: bytes, entity_ids: list[bytes]
) -> tuple[bytes, int]:
    sanitized_lines: list[bytes] = []
    replacements = 0
    for line in monitor.splitlines(keepends=True):
        if b"VERIFY:" in line:
            if any(contains_private_fragment(line, entity_id) for entity_id in entity_ids):
                fail("HA entity id collides with protected Phase 7 verification evidence")
            sanitized_lines.append(line)
            continue
        sanitized = line
        for entity_id in entity_ids:
            sanitized, count = redact_private_value(sanitized, entity_id)
            replacements += count
        sanitized_lines.append(sanitized)
    sanitized_monitor = b"".join(sanitized_lines)
    for entity_id in entity_ids:
        if contains_private_fragment(sanitized_monitor, entity_id):
            fail("HA entity id remained after Phase 7 monitor sanitization")
    return sanitized_monitor, replacements


def main() -> None:
    args = parse_args()
    args.output.unlink(missing_ok=True)
    write_private_text(args.status_file, "fail\n")
    monitor = args.monitor.read_bytes()
    assert_monitor_health(monitor)
    result_bytes = (
        args.result.read_bytes()
        if args.result is not None and args.result.is_file()
        else b""
    )
    if result_bytes:
        result = json.loads(result_bytes)
        if not isinstance(result, dict) or set(result) != ALLOWED_RESULT_KEYS:
            fail("Phase 7 result uses an unexpected schema")
        if (
            result.get("schema_version") != 1
            or result.get("profile") != "phase7_autonomy"
            or result.get("model") != "qwen3.6:35b-mlx"
            or result.get("protocol_version") != 2
            or result.get("ha_projection_origin")
            != "isolated_transition_from_real_allowlist_snapshot"
            or result.get("request_contains_ha_token") is not False
            or result.get("request_contains_entity_id") is not False
        ):
            fail("Phase 7 result privacy metadata is invalid")
        if args.result.stat().st_mode & 0o077:
            fail("Phase 7 result permissions are too broad")
    upload_candidates = monitor + b"\n" + result_bytes
    for secret_file in args.secret_file:
        secret = secret_file.read_bytes().strip()
        if not secret:
            fail(f"empty secret file: {secret_file}")
        if contains_private_fragment(upload_candidates, secret):
            fail(f"secret leaked into Phase 7 upload candidate: {secret_file.name}")
    entity_ids = policy_entity_ids(args.ha_policy)
    for entity_id in entity_ids:
        if contains_private_fragment(result_bytes, entity_id):
            fail("HA entity id leaked into Phase 7 result")
    sanitized_monitor, entity_redactions = sanitize_monitor_entities(
        monitor, entity_ids
    )
    assert_monitor_health(sanitized_monitor)
    marker = (
        b"VERIFY:phase7:artifact_audit:PASS "
        b"credentials=false entity_ids=false "
        + f"entity_redactions={entity_redactions}\n".encode("ascii")
    )
    publish_monitor(args.output, sanitized_monitor, marker)
    write_private_text(args.status_file, "pass\n")
    print(marker.decode("ascii"), end="")


if __name__ == "__main__":
    main()
