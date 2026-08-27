#!/usr/bin/env python3
"""Sanitize Phase 7 upload candidates and fail closed on credentials or HA ids."""

from __future__ import annotations

import argparse
import base64
import collections
import json
import os
import pathlib
import re
import urllib.parse


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
    "agent_ha_service_calls_dispatched",
    "agent_ha_invalid_outbound_frames",
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

ENTITY_FIELD_PATTERN = re.compile(
    rb'(?:["\']?(?:[a-z0-9_]*entity(?:_id)?|id|panel)["\']?\s*[:=]\s*["\']?)'
    rb'([a-z0-9_]+\.[a-z0-9_]+)'
)
HA_ENTITY_TOKEN_PATTERN = re.compile(
    rb"\b(?:alarm_control_panel|automation|binary_sensor|button|calendar|camera|"
    rb"climate|cover|device_tracker|event|fan|humidifier|input_boolean|"
    rb"input_button|input_datetime|input_number|input_select|input_text|light|"
    rb"lock|media_player|number|person|remote|scene|script|select|sensor|siren|"
    rb"sun|switch|text|time|timer|update|vacuum|valve|water_heater|weather|zone)"
    rb"\.[a-z0-9_]+\b"
)
GENERIC_ENTITY_TOKEN_PATTERN = re.compile(rb"\b[a-z_]+\.[a-z0-9_]+\b")
BASE64_TOKEN_PATTERN = re.compile(
    rb"(?<![A-Za-z0-9+/_-])([A-Za-z0-9+/_-]{22,}={0,2})(?![A-Za-z0-9+/_=-])"
)
JSON_UNICODE_ESCAPE_PATTERN = re.compile(rb"\\u([0-9a-fA-F]{4})")
ALLOWED_NON_ENTITY_TOKENS = {b"timer.elapsed"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--monitor", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--result", type=pathlib.Path)
    parser.add_argument("--ha-policy", required=True, type=pathlib.Path)
    parser.add_argument(
        "--entity-catalog", required=True, action="append", type=pathlib.Path
    )
    parser.add_argument("--sdkconfig", required=True, type=pathlib.Path)
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
    complete_encoded = {
        base64.b64encode(value),
        base64.b64encode(value).rstrip(b"="),
        base64.urlsafe_b64encode(value),
        base64.urlsafe_b64encode(value).rstrip(b"="),
    }
    for encoded in complete_encoded:
        for width in (22, 23, 24):
            if len(encoded) < width:
                continue
            variants.update(
                encoded[offset : offset + width]
                for offset in range(0, len(encoded) - width + 1)
            )
    return variants


def candidate_views(candidates: bytes) -> set[bytes]:
    views = {candidates}
    pending = collections.deque([candidates])
    total_bytes = len(candidates)
    max_total_bytes = max(1_000_000, len(candidates) * 16)

    def enqueue(view: bytes) -> None:
        nonlocal total_bytes
        if not view or view in views:
            return
        if len(views) >= 256 or total_bytes + len(view) > max_total_bytes:
            fail("encoded upload candidate exceeds the Phase 7 audit limit")
        views.add(view)
        pending.append(view)
        total_bytes += len(view)

    while pending:
        view = pending.popleft()
        enqueue(urllib.parse.unquote_to_bytes(view))
        enqueue(JSON_UNICODE_ESCAPE_PATTERN.sub(
            lambda match: chr(int(match.group(1), 16)).encode("utf-8"),
            view,
        ))
        for decoded_token in decoded_base64_candidates(view):
            # Benign logs contain many SHA-like Base64 tokens. Inspect every
            # decoded candidate locally, but only retain candidates that may
            # need another transform. This prevents normal logs from exhausting
            # the global closure budget while preserving nested-wrapper checks.
            if (
                b"%" in decoded_token
                or b"\\u" in decoded_token
                or BASE64_TOKEN_PATTERN.search(decoded_token) is not None
                or GENERIC_ENTITY_TOKEN_PATTERN.search(decoded_token) is not None
            ):
                enqueue(decoded_token)
    return views


def decoded_base64_candidates(candidates: bytes) -> list[bytes]:
    decoded: list[bytes] = []
    for match in BASE64_TOKEN_PATTERN.finditer(candidates):
        token = match.group(1)
        encoded_candidates = [token]
        # Recover a complete payload surrounded by up to three Base64 alphabet
        # characters. The decoded values are scanned locally and only suspicious
        # closure nodes are retained by candidate_views().
        for left_trim in range(0, 4):
            for right_trim in range(0, 4):
                if left_trim == 0 and right_trim == 0:
                    continue
                end = len(token) - right_trim if right_trim else len(token)
                trimmed = token[left_trim:end]
                if len(trimmed) >= 22:
                    encoded_candidates.append(trimmed)
        for width in (22, 23, 24):
            if len(token) < width:
                continue
            for offset in range(0, len(token) - width + 1):
                encoded_candidates.append(token[offset : offset + width])
        seen: set[bytes] = set()
        for encoded in encoded_candidates:
            if encoded in seen:
                continue
            seen.add(encoded)
            padded = encoded + b"=" * ((-len(encoded)) % 4)
            try:
                value = base64.b64decode(padded, altchars=b"-_", validate=True)
            except (ValueError, base64.binascii.Error):
                continue
            if value:
                decoded.append(value)
    return decoded


def contains_unknown_entity_token(candidates: bytes) -> bool:
    views = candidate_views(candidates)
    if any(
        match.group(0) not in ALLOWED_NON_ENTITY_TOKENS
        for view in views
        for match in HA_ENTITY_TOKEN_PATTERN.finditer(view)
    ):
        return True
    return any(
        match.group(0) not in ALLOWED_NON_ENTITY_TOKENS
        for view in views
        for decoded in decoded_base64_candidates(view)
        for match in GENERIC_ENTITY_TOKEN_PATTERN.finditer(decoded)
    )


def contains_private_fragment(candidates: bytes, value: bytes) -> bool:
    representations = private_representations(value)
    views = candidate_views(candidates)
    if any(variant in view for view in views for variant in representations):
        return True
    return any(
        variant in decoded
        for view in views
        for decoded in decoded_base64_candidates(view)
        for variant in representations
    )


def ordered_private_representations(values: list[bytes]) -> tuple[bytes, ...]:
    representations: set[bytes] = set()
    for value in values:
        representations.update(private_representations(value))
    return tuple(sorted(representations, key=lambda value: (-len(value), value)))


def redact_private_values(
    candidates: bytes, representations: tuple[bytes, ...]
) -> tuple[bytes, int]:
    """Redact the longest representation across all values before shared fragments."""
    redacted = candidates
    replacements = 0
    for variant in representations:
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
        write_all(descriptor, value.encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_all(descriptor: int, value: bytes) -> None:
    remaining = memoryview(value)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            fail("short write while publishing Phase 7 audit output")
        remaining = remaining[written:]


def publish_monitor(path: pathlib.Path, monitor: bytes, marker: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
        try:
            write_all(descriptor, monitor)
            if monitor and not monitor.endswith(b"\n"):
                write_all(descriptor, b"\n")
            write_all(descriptor, marker)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def json_entity_ids(path: pathlib.Path, source: str) -> list[bytes]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("entities"), list):
        fail(f"Phase 7 {source} has an invalid schema")
    entity_ids: list[bytes] = []
    for entity in value["entities"]:
        if not isinstance(entity, dict) or not isinstance(entity.get("entity_id"), str):
            fail(f"Phase 7 {source} entity is invalid")
        entity_id = entity["entity_id"].encode("utf-8")
        if not entity_id:
            fail(f"Phase 7 {source} entity id is empty")
        entity_ids.append(entity_id)
    if not entity_ids:
        fail(f"Phase 7 {source} has no entities")
    return entity_ids


def sdkconfig_entity_ids(path: pathlib.Path) -> list[bytes]:
    pattern = re.compile(r'^CONFIG_[A-Z0-9_]*ENTITY_ID="((?:[^"\\]|\\.)*)"$')
    entity_ids: list[bytes] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.fullmatch(line)
        if match is None:
            continue
        try:
            entity_id = json.loads(f'"{match.group(1)}"').encode("utf-8")
        except (json.JSONDecodeError, UnicodeEncodeError):
            fail("Phase 7 sdkconfig entity id is invalid")
        if not entity_id:
            fail("Phase 7 sdkconfig entity id is empty")
        entity_ids.append(entity_id)
    if not entity_ids:
        fail("Phase 7 sdkconfig has no entity ids")
    return entity_ids


def all_entity_ids(args: argparse.Namespace) -> list[bytes]:
    entity_ids = json_entity_ids(args.ha_policy, "HA policy")
    for catalog in args.entity_catalog:
        entity_ids.extend(json_entity_ids(catalog, "entity catalog"))
    entity_ids.extend(sdkconfig_entity_ids(args.sdkconfig))
    return sorted(set(entity_ids))


def validate_result(result: object) -> dict[str, object]:
    if not isinstance(result, dict) or set(result) != ALLOWED_RESULT_KEYS:
        fail("Phase 7 result uses an unexpected schema")
    boolean_keys = {
        "passed",
        "timer_action_completed",
        "ha_projected_action_completed",
        "p4_reconnect_snapshot_verified",
        "ha_client_ready",
        "robot_non_admin",
        "robot_non_owner",
        "pause_blocked_model_calls",
        "disable_blocked_model_calls",
        "request_contains_ha_token",
        "request_contains_entity_id",
    }
    integer_keys = {
        "schema_version",
        "real_model_calls",
        "protocol_version",
        "p4_actions_completed",
        "p4_state_version",
        "ha_policy_aliases",
        "agent_ha_service_calls_dispatched",
        "agent_ha_invalid_outbound_frames",
        "stability_observation_ms",
        "rss_peak_growth_bytes",
        "rss_growth_limit_bytes",
        "heap_peak_growth_bytes",
        "execution_terminal_records",
    }
    if any(type(result.get(key)) is not bool for key in boolean_keys):
        fail("Phase 7 result has an invalid boolean field")
    if any(
        type(result.get(key)) is not int or result[key] < 0
        for key in integer_keys
    ):
        fail("Phase 7 result has an invalid integer field")
    if not isinstance(result.get("reason"), str):
        fail("Phase 7 result reason is invalid")
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
    return result


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


def assert_p4_ha_read_only(monitor: bytes) -> int:
    pattern = re.compile(
        rb"ha_summary state=([A-Z]+)[^\r\n]* service_calls=([0-9]+)(?: |\r?$)",
        re.MULTILINE,
    )
    samples = list(pattern.finditer(monitor))
    if not samples:
        fail("Phase 7 monitor has no P4 HA service-call metric")
    terminal_marker = b"$ serial-capture stop-file-observed post_stop_seconds=35"
    if monitor.count(terminal_marker) != 1:
        fail("Phase 7 monitor must contain exactly one harness-terminal capture marker")
    terminal_offset = monitor.rfind(terminal_marker)
    ready_samples = [
        int(match.group(2))
        for match in samples
        if match.group(1) == b"READY" and match.start() > terminal_offset
    ]
    if not ready_samples:
        fail("Phase 7 monitor has no post-terminal READY P4 HA service-call metric")
    if any(int(match.group(2)) != 0 for match in samples):
        fail("P4 HA client dispatched a service call during Phase 7")
    return len(ready_samples)


def sanitize_monitor_entities(
    monitor: bytes, entity_ids: list[bytes]
) -> tuple[bytes, int]:
    sanitized_lines: list[bytes] = []
    replacements = 0
    representations = ordered_private_representations(entity_ids)
    for line in monitor.splitlines(keepends=True):
        if urllib.parse.unquote_to_bytes(line) != line and any(
            contains_private_fragment(line, entity_id) for entity_id in entity_ids
        ):
            fail("percent-encoded HA entity id cannot be safely sanitized")
        if b"VERIFY:" in line:
            if any(contains_private_fragment(line, entity_id) for entity_id in entity_ids):
                fail("HA entity id collides with protected Phase 7 verification evidence")
            if any(ENTITY_FIELD_PATTERN.search(view) for view in candidate_views(line)):
                fail("unknown HA entity id collides with protected Phase 7 verification evidence")
            if contains_unknown_entity_token(line):
                fail("HA entity-shaped token collides with protected Phase 7 verification evidence")
            sanitized_lines.append(line)
            continue
        sanitized, count = redact_private_values(line, representations)
        replacements += count
        sanitized_lines.append(sanitized)
    sanitized_monitor = b"".join(sanitized_lines)
    for entity_id in entity_ids:
        if contains_private_fragment(sanitized_monitor, entity_id):
            fail("HA entity id remained after Phase 7 monitor sanitization")
    if any(
        ENTITY_FIELD_PATTERN.search(view)
        for view in candidate_views(sanitized_monitor)
    ):
        fail("unknown HA entity id remained after Phase 7 monitor sanitization")
    if contains_unknown_entity_token(sanitized_monitor):
        fail("HA entity-shaped token remained after Phase 7 monitor sanitization")
    return sanitized_monitor, replacements


def main() -> None:
    args = parse_args()
    args.output.unlink(missing_ok=True)
    write_private_text(args.status_file, "fail\n")
    monitor = args.monitor.read_bytes()
    assert_monitor_health(monitor)
    p4_ready_samples = assert_p4_ha_read_only(monitor)
    result_bytes = (
        args.result.read_bytes()
        if args.result is not None and args.result.is_file()
        else b""
    )
    if result_bytes:
        result = validate_result(json.loads(result_bytes))
        normalized_result_bytes = json.dumps(
            result, ensure_ascii=False, sort_keys=True
        ).encode("utf-8")
        if args.result.stat().st_mode & 0o077:
            fail("Phase 7 result permissions are too broad")
        if contains_unknown_entity_token(result_bytes + b"\n" + normalized_result_bytes):
            fail("HA entity-shaped token leaked into Phase 7 result")
    else:
        normalized_result_bytes = b""
    upload_candidates = monitor + b"\n" + result_bytes + b"\n" + normalized_result_bytes
    for secret_file in args.secret_file:
        secret = secret_file.read_bytes().strip()
        if not secret:
            fail(f"empty secret file: {secret_file}")
        if contains_private_fragment(upload_candidates, secret):
            fail(f"secret leaked into Phase 7 upload candidate: {secret_file.name}")
    entity_ids = all_entity_ids(args)
    for entity_id in entity_ids:
        if contains_private_fragment(
            result_bytes + b"\n" + normalized_result_bytes, entity_id
        ):
            fail("HA entity id leaked into Phase 7 result")
    sanitized_monitor, entity_redactions = sanitize_monitor_entities(
        monitor, entity_ids
    )
    assert_monitor_health(sanitized_monitor)
    marker = (
        b"VERIFY:phase7:p4_ha_read_only:PASS service_calls=0 "
        + f"ready_samples={p4_ready_samples}\n".encode("ascii")
        + b"VERIFY:phase7:artifact_audit:PASS "
        b"credentials=false entity_ids=false "
        + f"entity_values={len(entity_ids)} entity_redactions={entity_redactions}\n".encode(
            "ascii"
        )
    )
    publish_monitor(args.output, sanitized_monitor, marker)
    write_private_text(args.status_file, "pass\n")
    print(marker.decode("ascii"), end="")


if __name__ == "__main__":
    main()
