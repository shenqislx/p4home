#!/usr/bin/env python3
"""Fail closed when Phase 6H upload candidates expose private Memory or credentials."""

from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import sqlite3


ALLOWED_RESULT_KEYS = {
    "schema_version",
    "profile",
    "protocol_version",
    "memory_status",
    "selected_memory_ids",
    "memory_body_in_artifact",
    "memory_database_mode",
    "stale_claim_seen_as_untrusted_data",
    "world_authority",
    "target_object_id",
    "pose",
    "occupied",
    "state_version",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--monitor", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--result", type=pathlib.Path)
    parser.add_argument("--memory-db", required=True, type=pathlib.Path)
    parser.add_argument(
        "--memory-canary-file", action="append", default=[], type=pathlib.Path
    )
    parser.add_argument("--secret-file", action="append", default=[], type=pathlib.Path)
    parser.add_argument("--status-file", required=True, type=pathlib.Path)
    return parser.parse_args()


def fail(message: str) -> None:
    raise SystemExit(message)


def encoded_variants(value: bytes) -> set[bytes]:
    variants = {value, base64.b64encode(value), base64.urlsafe_b64encode(value)}
    try:
        text = value.decode("utf-8")
    except UnicodeDecodeError:
        return variants
    variants.add(json.dumps(text, ensure_ascii=True)[1:-1].encode("ascii"))
    variants.add(json.dumps(text, ensure_ascii=False)[1:-1].encode("utf-8"))
    return {variant for variant in variants if variant}


def contains_private_fragment(candidates: bytes, value: bytes) -> bool:
    """Catch complete, encoded, truncated and line-oriented private material."""
    for variant in encoded_variants(value):
        if len(variant) <= 16:
            if variant in candidates:
                return True
            continue
        if any(
            variant[offset:offset + 16] in candidates
            for offset in range(0, len(variant) - 15)
        ):
            return True
    return False


def write_private_text(path: pathlib.Path, value: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
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


def main() -> None:
    args = parse_args()
    args.output.unlink(missing_ok=True)
    write_private_text(args.status_file, "fail\n")
    monitor = args.monitor.read_bytes()
    result_bytes = (
        args.result.read_bytes()
        if args.result is not None and args.result.is_file()
        else b""
    )
    upload_candidates = monitor + b"\n" + result_bytes
    if result_bytes:
        result = json.loads(result_bytes)
        if not isinstance(result, dict) or set(result) != ALLOWED_RESULT_KEYS:
            fail("Phase 6H result uses an unexpected schema")
        if (
            result.get("schema_version") != 1
            or result.get("profile") != "phase6h_cat_memory"
            or result.get("memory_body_in_artifact") is not False
            or result.get("memory_database_mode") != "600"
        ):
            fail("Phase 6H result privacy metadata is invalid")
    for secret_file in args.secret_file:
        secret = secret_file.read_bytes().strip()
        if not secret:
            fail(f"empty secret file: {secret_file}")
        if contains_private_fragment(upload_candidates, secret):
            fail(f"secret leaked into Phase 6H upload candidate: {secret_file.name}")
    if not args.memory_canary_file:
        fail("Phase 6H requires a private Memory canary")
    for canary_file in args.memory_canary_file:
        canary = canary_file.read_bytes().strip()
        if len(canary) < 16:
            fail(f"Memory canary is too short: {canary_file}")
        if contains_private_fragment(upload_candidates, canary):
            fail("Memory canary leaked into Phase 6H upload candidate")
    rows: list[tuple[object]] = []
    if args.memory_db.is_file():
        with sqlite3.connect(f"file:{args.memory_db}?mode=ro", uri=True) as database:
            rows = database.execute("SELECT content FROM memories").fetchall()
    for (content,) in rows:
        encoded = str(content).encode("utf-8")
        if any(variant in upload_candidates for variant in encoded_variants(encoded)):
            fail("complete or encoded Memory body leaked into Phase 6H upload candidate")
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
            fail(f"crash marker present in Phase 6H monitor: {marker.decode()}")
    if monitor.count(b"rst:0x") > 1:
        fail("reset loop present in Phase 6H monitor")
    marker = b"VERIFY:phase6h:artifact_audit:PASS memory_body=false credentials=false\n"
    publish_monitor(args.output, monitor, marker)
    write_private_text(args.status_file, "pass\n")
    print(marker.decode("ascii"), end="")


if __name__ == "__main__":
    main()
