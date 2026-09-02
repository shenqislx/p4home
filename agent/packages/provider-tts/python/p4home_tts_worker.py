#!/usr/bin/env python3
"""Persistent, memory-only MLX Kokoro worker with bounded NDJSON PCM chunks."""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import json
import os
import pathlib
import re
import runpy
import sys

import numpy as np

# Model libraries may print while their lazy generators are being advanced.
# Keep protocol output pinned to the original stdout so redirecting provider
# diagnostics can never swallow PCM chunks into stderr.
PROTOCOL_STDOUT = sys.stdout

BOUNDS_PATH = pathlib.Path(__file__).resolve().with_name("tts_bounds.py")
if not BOUNDS_PATH.is_file() or BOUNDS_PATH.is_symlink():
    raise SystemExit("TTS bounds module is unavailable")
BOUNDS = runpy.run_path(str(BOUNDS_PATH))
MAX_PCM_BYTES = BOUNDS["MAX_PCM_BYTES"]
checked_source_total = BOUNDS["checked_source_total"]

WORKER_SCHEMA_VERSION = 2
MAX_REQUEST_BYTES = 8_192
MAX_TEXT_CHARS = 1_024
PCM_CHUNK_BYTES = 640
MAX_CLAUSE_CHARS = 80
SOFT_CLAUSE_CHARS = 24
MODEL_ID = "mlx-community/Kokoro-82M-bf16"
MODEL_REVISION = "a71e4d38b236d968966a2002c4c895dbd12b1c3c"
PROVIDER_VERSION = "0.4.8"
REQUIRED_FILES = (
    "config.json",
    "kokoro-v1_0.safetensors",
    "voices/zf_xiaobei.safetensors",
    "voices/zm_yunxi.safetensors",
)
ROLE_VOICES = {"human": "zf_xiaobei", "robot": "zm_yunxi"}
CONTRACT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
STRONG_BOUNDARIES = frozenset("。！？!?；;：:\n")
SOFT_BOUNDARIES = frozenset("，,、")


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def model_verified(model: pathlib.Path) -> bool:
    try:
        voices = model / "voices"
        if (
            not model.is_dir()
            or model.is_symlink()
            or {entry.name for entry in model.iterdir()}
            != {"config.json", "kokoro-v1_0.safetensors", "voices", "p4home-model-manifest.json"}
            or not voices.is_dir()
            or voices.is_symlink()
            or {entry.name for entry in voices.iterdir()}
            != {"zf_xiaobei.safetensors", "zm_yunxi.safetensors"}
        ):
            return False
        manifest_path = model / "p4home-model-manifest.json"
        if not manifest_path.is_file() or manifest_path.is_symlink():
            return False
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (
            manifest.get("schema_version") != 1
            or manifest.get("provider") != "mlx-audio"
            or manifest.get("provider_version") != PROVIDER_VERSION
            or manifest.get("model_id") != MODEL_ID
            or manifest.get("revision") != MODEL_REVISION
            or not isinstance(manifest.get("files"), dict)
        ):
            return False
        for name in REQUIRED_FILES:
            path = model / name
            if (
                not path.is_file()
                or path.is_symlink()
                or manifest["files"].get(name) != sha256(path)
            ):
                return False
        return True
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


def emit(value: dict[str, object]) -> None:
    PROTOCOL_STDOUT.write(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
    )
    PROTOCOL_STDOUT.flush()


def identity(request: dict[str, object]) -> dict[str, object]:
    return {
        "interaction_id": request["interaction_id"],
        "assignment_id": request["assignment_id"],
        "segment_index": request["segment_index"],
        "role_id": request["role_id"],
        "voice": request["voice"],
    }


def fail(code: str, request: dict[str, object]) -> None:
    emit({
        "schema_version": WORKER_SCHEMA_VERSION,
        "status": "error",
        **identity(request),
        "error_code": code,
    })


def parse_request(raw: bytes) -> dict[str, object]:
    if len(raw) == 0 or len(raw) > MAX_REQUEST_BYTES or not raw.endswith(b"\n"):
        raise ValueError("invalid request framing")
    request = json.loads(raw)
    expected = {
        "schema_version", "interaction_id", "assignment_id", "segment_index", "role_id",
        "text", "voice", "language", "sample_rate_hz", "channels", "sample_bits",
    }
    if not isinstance(request, dict) or set(request) != expected:
        raise ValueError("invalid request")
    role = request.get("role_id")
    if (
        request.get("schema_version") != WORKER_SCHEMA_VERSION
        or not isinstance(request.get("interaction_id"), str)
        or CONTRACT_ID.fullmatch(request["interaction_id"]) is None
        or not isinstance(request.get("assignment_id"), str)
        or CONTRACT_ID.fullmatch(request["assignment_id"]) is None
        or not isinstance(request.get("segment_index"), int)
        or isinstance(request.get("segment_index"), bool)
        or not 0 <= request["segment_index"] <= 63
        or role not in ROLE_VOICES
        or request.get("voice") != ROLE_VOICES.get(role)
        or request.get("language") != "zh"
        or request.get("sample_rate_hz") != 16_000
        or request.get("channels") != 1
        or request.get("sample_bits") != 16
        or not isinstance(request.get("text"), str)
        or not 1 <= len(request["text"]) <= MAX_TEXT_CHARS
        or request["text"] != request["text"].strip()
        or CONTROL.search(request["text"]) is not None
    ):
        raise ValueError("invalid request")
    return request


def split_text_for_streaming(text: str) -> list[str]:
    """Keep all characters while bounding the first and subsequent Kokoro clauses."""
    clauses: list[str] = []
    current: list[str] = []
    for character in text:
        current.append(character)
        length = len(current)
        if (
            character in STRONG_BOUNDARIES
            or (character in SOFT_BOUNDARIES and length >= SOFT_CLAUSE_CHARS)
            or length >= MAX_CLAUSE_CHARS
        ):
            clauses.append("".join(current))
            current = []
    if current:
        clauses.append("".join(current))
    if not clauses or "".join(clauses) != text or any(len(clause) > MAX_CLAUSE_CHARS for clause in clauses):
        raise ValueError("invalid streaming clauses")
    return clauses


def downsample_24k_to_16k(audio: np.ndarray) -> np.ndarray:
    """Apply deterministic polyphase anti-alias filtering at the exact 2/3 ratio."""
    if audio.ndim != 1 or audio.size < 2 or not np.isfinite(audio).all():
        raise ValueError("invalid provider audio")
    from scipy.signal import resample_poly

    resampled = resample_poly(audio, 2, 3)
    if resampled.size < 1 or not np.isfinite(resampled).all():
        raise ValueError("provider audio is too short")
    return resampled.astype(np.float32)


def synthesize(model: object, model_path: pathlib.Path, request: dict[str, object]) -> None:
    source_samples = 0
    output_bytes = 0
    output_samples = 0
    chunk_index = 0
    clauses = split_text_for_streaming(str(request["text"]))
    voice_path = model_path / "voices" / f"{request['voice']}.safetensors"
    with contextlib.redirect_stdout(sys.stderr):
        generated = model.generate(
            clauses,
            voice=str(voice_path),
            speed=1.0,
            lang_code="z",
            split_pattern=None,
        )
        for result in generated:
            if result.sample_rate != 24_000:
                raise ValueError("unexpected sample rate")
            source = np.asarray(result.audio, dtype=np.float32).reshape(-1).copy()
            if source.size == 0 or not np.isfinite(source).all():
                source.fill(0)
                raise ValueError("invalid provider audio")
            source_samples = checked_source_total(source_samples, int(source.size))
            resampled = downsample_24k_to_16k(source)
            source.fill(0)
            pcm_array = np.rint(np.clip(resampled, -1.0, 1.0) * 32767.0).astype("<i2")
            resampled.fill(0)
            pcm = bytearray(pcm_array.tobytes())
            pcm_array.fill(0)
            try:
                if len(pcm) == 0 or len(pcm) % 2 != 0 or output_bytes + len(pcm) > MAX_PCM_BYTES:
                    raise ValueError("PCM outside bounds")
                for offset in range(0, len(pcm), PCM_CHUNK_BYTES):
                    piece = bytearray(pcm[offset : offset + PCM_CHUNK_BYTES])
                    try:
                        samples = len(piece) // 2
                        encoded = base64.b64encode(piece).decode("ascii")
                        emit({
                            "schema_version": WORKER_SCHEMA_VERSION,
                            "status": "chunk",
                            **identity(request),
                            "chunk_index": chunk_index,
                            "pcm_base64": encoded,
                            "sample_rate_hz": 16_000,
                            "channels": 1,
                            "sample_bits": 16,
                            "samples": samples,
                            "duration_ms": samples / 16_000 * 1000,
                            "final": False,
                        })
                        del encoded
                        chunk_index += 1
                        output_bytes += len(piece)
                        output_samples += samples
                    finally:
                        piece[:] = b"\x00" * len(piece)
            finally:
                pcm[:] = b"\x00" * len(pcm)
    if chunk_index < 1 or output_bytes < 2 or output_samples != output_bytes // 2:
        raise ValueError("provider returned no audio")
    emit({
        "schema_version": WORKER_SCHEMA_VERSION,
        "status": "completed",
        **identity(request),
        "chunk_count": chunk_index,
        "pcm_bytes": output_bytes,
        "sample_rate_hz": 16_000,
        "channels": 1,
        "sample_bits": 16,
        "samples": output_samples,
        "duration_ms": output_samples / 16_000 * 1000,
        "python_version": ".".join(str(part) for part in sys.version_info[:3]),
    })


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if (
        os.environ.get("P4HOME_TTS_PROVIDER_VERSION") != PROVIDER_VERSION
        or os.environ.get("P4HOME_TTS_MODEL_REVISION") != MODEL_REVISION
        or not model_verified(args.model)
    ):
        emit({
            "schema_version": WORKER_SCHEMA_VERSION,
            "status": "startup_error",
            "error_code": "MODEL_UNAVAILABLE",
        })
        return 2
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from mlx_audio.tts.utils import load_model

            model = load_model(args.model)
    except Exception as error:
        sys.stderr.write(f"TTS startup failed type={type(error).__name__}\n")
        sys.stderr.flush()
        emit({
            "schema_version": WORKER_SCHEMA_VERSION,
            "status": "startup_error",
            "error_code": "PROCESS_ERROR",
        })
        return 1
    emit({
        "schema_version": WORKER_SCHEMA_VERSION,
        "status": "ready",
        "provider_version": PROVIDER_VERSION,
        "model_revision": MODEL_REVISION,
        "python_version": ".".join(str(part) for part in sys.version_info[:3]),
    })
    while True:
        raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        if len(raw) == 0:
            return 0
        try:
            request = parse_request(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            # An unbound protocol violation makes the persistent channel unsafe.
            return 2
        raw = b""
        try:
            synthesize(model, args.model, request)
        except Exception as error:
            sys.stderr.write(f"TTS provider failed type={type(error).__name__}\n")
            sys.stderr.flush()
            fail("PROCESS_ERROR", request)
            request["text"] = ""
            return 1
        request["text"] = ""


if __name__ == "__main__":
    raise SystemExit(main())
