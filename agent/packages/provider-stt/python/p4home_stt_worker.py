#!/usr/bin/env python3
"""One-shot, memory-only MLX Whisper worker for the Phase 5C STT boundary."""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import json
import os
import pathlib
import re
import sys
import time

import numpy as np


MAX_REQUEST_BYTES = 900_000
MAX_PCM_BYTES = 640_000
MODEL_ID = "mlx-community/whisper-small-mlx"
MODEL_REVISION = "45f3915923c7a79a5a5b5a7d909d39aeb0e5630e"
REQUIRED_FILES = ("config.json", "weights.npz")
MODEL_ENTRIES = {*REQUIRED_FILES, "p4home-model-manifest.json"}
SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def model_verified(model: pathlib.Path) -> bool:
    try:
        if {entry.name for entry in model.iterdir()} != MODEL_ENTRIES:
            return False
        manifest_path = model / "p4home-model-manifest.json"
        if not manifest_path.is_file() or manifest_path.is_symlink():
            return False
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (
            manifest.get("schema_version") != 1
            or manifest.get("provider") != "mlx-whisper"
            or manifest.get("provider_version") != "0.4.3"
            or manifest.get("model_id") != MODEL_ID
            or manifest.get("revision") != MODEL_REVISION
        ):
            return False
        hashes = manifest.get("files")
        if not isinstance(hashes, dict):
            return False
        for name in REQUIRED_FILES:
            path = model / name
            if not path.is_file() or path.is_symlink() or hashes.get(name) != sha256(path):
                return False
        return True
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False


def emit(value: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def fail(code: str) -> None:
    emit({"schema_version": 1, "status": "error", "error_code": code})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if (
        os.environ.get("P4HOME_STT_PROVIDER_VERSION") != "0.4.3"
        or os.environ.get("P4HOME_STT_MODEL_REVISION") != MODEL_REVISION
        or not args.model.is_dir()
        or args.model.is_symlink()
        or not model_verified(args.model)
    ):
        fail("MODEL_UNAVAILABLE")
        return 2

    raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
    if len(raw) == 0 or len(raw) > MAX_REQUEST_BYTES or sys.stdin.buffer.read(1):
        fail("INVALID_REQUEST")
        return 2
    try:
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("invalid request")
        pcm = base64.b64decode(request["pcm_base64"], validate=True)
        if (
            request.get("schema_version") != 1
            or not isinstance(request.get("session_id"), str)
            or SESSION_ID.fullmatch(request["session_id"]) is None
            or not isinstance(request.get("stream_id"), int)
            or isinstance(request.get("stream_id"), bool)
            or not 0 <= request["stream_id"] <= 0xFFFFFFFF
            or not isinstance(request.get("epoch"), int)
            or isinstance(request.get("epoch"), bool)
            or not 0 <= request["epoch"] <= 0xFFFFFFFF
            or request.get("sample_rate_hz") != 16_000
            or request.get("channels") != 1
            or request.get("sample_bits") != 16
            or request.get("language") != "zh"
            or len(pcm) == 0
            or len(pcm) > MAX_PCM_BYTES
            or len(pcm) % 2 != 0
        ):
            raise ValueError("invalid request")
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        fail("INVALID_REQUEST")
        return 2

    started = time.monotonic()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import mlx_whisper

            result = mlx_whisper.transcribe(
                audio,
                path_or_hf_repo=str(args.model),
                language="zh",
                verbose=False,
                condition_on_previous_text=False,
            )
        text = result.get("text")
        if not isinstance(text, str) or len(text) > 1024:
            raise ValueError("invalid transcript")
    except Exception as error:
        sys.stderr.write(f"STT provider failed type={type(error).__name__}\n")
        sys.stderr.flush()
        fail("PROVIDER_ERROR")
        return 1

    emit({
        "schema_version": 1,
        "status": "completed",
        "session_id": request["session_id"],
        "stream_id": request["stream_id"],
        "epoch": request["epoch"],
        "text": text,
        "language": "zh",
        "duration_ms": round((time.monotonic() - started) * 1000, 3),
        "python_version": ".".join(str(part) for part in sys.version_info[:3]),
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
