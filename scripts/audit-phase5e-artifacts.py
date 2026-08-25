#!/usr/bin/env python3
"""Fail closed if Phase 5E upload candidates contain credentials or raw audio."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sqlite3

BASE64_CANDIDATE = re.compile(rb"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{256,}={0,2}(?![A-Za-z0-9+/=])")
RAW_FIELD = re.compile(
    rb'''(?ix)["']?(?:raw[_-]?audio|pcm[_-]?(?:base64|data|blob|path)|audio[_-]?(?:base64|data|blob|path))["']?\s*[:=]'''
)
VOICE_RESULT_KEYS = {
    "schema_version", "profile", "passed", "interactions", "stt_provider_version",
    "stt_model_revision", "stt_calls", "stt_transcript_mismatches", "stt_total_ms",
    "tts_provider_version", "tts_model_revision", "tts_calls", "tts_total_ms",
    "audit_events", "restored", "read_passed", "write_passed", "barge_in_passed",
    "followup_passed", "composition_audits_persisted", "playback_segments",
    "playback_bytes", "raw_audio_retained",
}
INTERACTION_KEYS = {
    "kind", "role_id", "role_status", "voice_outcome", "playback_statuses", "pcm_bytes",
}
UI_RESULT_KEYS = {
    "schema_version", "profile", "passed", "interaction_kinds", "role_ids",
    "role_statuses", "voice_outcomes", "ui_delivery_statuses",
    "audio_delivery_statuses", "stt_provider_version", "stt_model_revision",
    "stt_calls", "stt_transcript_mismatches", "stt_total_ms", "real_model_calls",
    "audit_events", "restored", "read_passed", "write_passed", "chat_passed",
    "ui_deliveries_completed", "audio_delivery_deferred",
    "composition_audits_persisted", "raw_audio_retained",
}


def read_secret(path: pathlib.Path) -> bytes:
    return path.read_bytes().strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", action="append", required=True, type=pathlib.Path)
    parser.add_argument("--secret-file", action="append", required=True, type=pathlib.Path)
    parser.add_argument("--audit-db", type=pathlib.Path)
    parser.add_argument("--result", type=pathlib.Path)
    parser.add_argument("--status-file", required=True, type=pathlib.Path)
    args = parser.parse_args()
    reasons: set[str] = set()
    secrets = [secret for path in args.secret_file if (secret := read_secret(path))]
    for artifact in args.artifact:
        data = artifact.read_bytes()
        if any(secret in data for secret in secrets):
            reasons.add("secret_leak")
        try:
            data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            reasons.add("non_utf8_artifact")
        if b"\x00" in data or any(byte < 32 and byte not in (9, 10, 13, 27) for byte in data):
            reasons.add("binary_artifact")
        if RAW_FIELD.search(data):
            reasons.add("raw_audio_field")
        if BASE64_CANDIDATE.search(data):
            reasons.add("long_base64")
    if args.result is not None and args.result.is_file():
        try:
            result = json.loads(args.result.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            result = None
            reasons.add("result_schema")
        profile = result.get("profile") if isinstance(result, dict) else None
        expected_keys = UI_RESULT_KEYS if profile == "phase5e_ui" else VOICE_RESULT_KEYS
        if not isinstance(result, dict) or set(result) != expected_keys:
            reasons.add("result_schema")
        if profile == "phase5e_ui" and isinstance(result, dict):
            bounded_lists = (
                "interaction_kinds", "role_ids", "role_statuses", "voice_outcomes",
                "ui_delivery_statuses", "audio_delivery_statuses",
            )
            if any(not isinstance(result.get(key), list)
                   or len(result[key]) > 3
                   or any(not isinstance(value, str) for value in result[key])
                   for key in bounded_lists):
                reasons.add("interaction_schema")
        elif profile != "phase5e_ui":
            interactions = result.get("interactions") if isinstance(result, dict) else None
            if (not isinstance(interactions, list) or len(interactions) > 4
                    or any(not isinstance(item, dict) or set(item) != INTERACTION_KEYS
                            for item in interactions)):
                reasons.add("interaction_schema")
        if not isinstance(result, dict) or result.get("raw_audio_retained") is not False:
            reasons.add("retention_claim")
    if args.audit_db is not None and args.audit_db.is_file():
        audit_sqlite(args.audit_db, reasons)
    passed = not reasons
    args.status_file.write_text("pass\n" if passed else "fail\n", encoding="ascii")
    print(
        "VERIFY:phase5e:artifact_audit:PASS secrets=absent raw_audio=absent"
        if passed else f"VERIFY:phase5e:artifact_audit:FAIL reasons={','.join(sorted(reasons))}"
    )
    return 0 if passed else 1


def audit_sqlite(path: pathlib.Path, reasons: set[str]) -> None:
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        reasons.add("sqlite_shape")
        return
    try:
        with connection:
            tables = [row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )]
            for table in tables:
                if not isinstance(table, str) or not table.replace("_", "").isalnum():
                    reasons.add("sqlite_shape")
                    continue
                columns = list(connection.execute(f'PRAGMA table_info("{table}")'))
                names = [str(row[1]).lower() for row in columns]
                normalized_names = [re.sub(r"[^a-z0-9]", "", name) for name in names]
                if any("audio" in name or "pcm" in name for name in normalized_names):
                    reasons.add("raw_audio_column")
                for column in (str(row[1]) for row in columns):
                    if not column.replace("_", "").isalnum():
                        reasons.add("sqlite_shape")
                        continue
                    blob_count = connection.execute(
                        f'''SELECT COUNT(*) FROM "{table}"
                            WHERE typeof("{column}") = 'blob' '''
                    ).fetchone()[0]
                    if blob_count:
                        reasons.add("sqlite_blob")
                    for (value,) in connection.execute(
                        f'''SELECT "{column}" FROM "{table}"
                            WHERE typeof("{column}") = 'text' '''
                    ):
                        encoded = str(value).encode("utf-8")
                        if RAW_FIELD.search(encoded) or BASE64_CANDIDATE.search(encoded):
                            reasons.add("sqlite_raw_audio_value")
    except sqlite3.Error:
        reasons.add("sqlite_shape")
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
