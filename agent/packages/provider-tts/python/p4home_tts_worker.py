#!/usr/bin/env python3
"""Persistent, memory-only MLX TTS worker with bounded NDJSON PCM chunks."""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
import pathlib
import re
import runpy
import sys

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

# The provider launches Python with -I, so sibling imports are deliberately
# unavailable. Load only the fixed repository file, just like the bounds module.
QWEN3_REVISION = "1c6c0ff58c43afa8df571facde2efa077efd85e2"
IS_QWEN3 = os.environ.get("P4HOME_TTS_MODEL_REVISION") == QWEN3_REVISION
MODEL_PATH = pathlib.Path(__file__).resolve().with_name(
    "prepare_qwen3_model.py" if IS_QWEN3 else "prepare_model.py"
)
if not MODEL_PATH.is_file() or MODEL_PATH.is_symlink():
    raise SystemExit("TTS model verifier is unavailable")
MODEL = runpy.run_path(str(MODEL_PATH))
MODEL_ID = MODEL["MODEL_ID"]
MODEL_REVISION = MODEL["MODEL_REVISION"]
PROVIDER_VERSION = MODEL["PROVIDER_VERSION"]
verified_manifest = MODEL["verified_manifest"]

WORKER_SCHEMA_VERSION = 2
MAX_REQUEST_BYTES = 8_192
MAX_TEXT_CHARS = 1_024
PCM_CHUNK_BYTES = 640
MAX_CLAUSE_CHARS = 80
SOFT_CLAUSE_CHARS = 24
ROLE_VOICES = ({"human": "Serena", "robot": "Vivian"} if IS_QWEN3
               else {"human": "zf_xiaoxiao", "robot": "zf_xiaobei"})
CONTRACT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
STRONG_BOUNDARIES = frozenset("。！？!?；;：:\n")
SOFT_BOUNDARIES = frozenset("，,、")


def model_verified(model: pathlib.Path) -> bool:
    # Startup and installation must trust the same pinned hashes, not merely a
    # self-consistent manifest supplied alongside potentially corrupt weights.
    return verified_manifest(model) is not None


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
    import numpy as np

    if audio.ndim != 1 or audio.size < 2 or not np.isfinite(audio).all():
        raise ValueError("invalid provider audio")
    from scipy.signal import resample_poly

    resampled = resample_poly(audio, 2, 3)
    if resampled.size < 1 or not np.isfinite(resampled).all():
        raise ValueError("provider audio is too short")
    return resampled.astype(np.float32)


def resampled_audio(model, model_path, request):
    import numpy as np
    source_samples = 0
    if not IS_QWEN3:
        generated = model.generate(
            split_text_for_streaming(str(request["text"])),
            voice=str(model_path / "voices" / f"{request['voice']}.safetensors"),
            speed=1.0, lang_code="z", split_pattern=None,
        )
        resampler = None
    else:
        path = pathlib.Path(__file__).resolve().with_name("tts_resampler.py")
        if not path.is_file() or path.is_symlink():
            raise ValueError("resampler unavailable")
        resampler = runpy.run_path(str(path))["StreamingResampler24To16"]()
        generated = model.generate_custom_voice(
            text=request["text"], speaker=request["voice"], language="Chinese",
            instruct="用自然、平稳的普通话交流，语速适中，停顿自然。",
            temperature=0.6, max_tokens=750, verbose=False,
            stream=True, streaming_interval=0.48,
        )
    token_count = 0
    for result in generated:
        if result.sample_rate != 24_000:
            raise ValueError("unexpected sample rate")
        if IS_QWEN3:
            token_count += result.token_count
            if token_count >= 750:
                raise ValueError("speech generation reached its token limit")
        source = np.asarray(result.audio, dtype=np.float32).reshape(-1).copy()
        try:
            source_samples = checked_source_total(source_samples, int(source.size))
            if not np.isfinite(source).all():
                raise ValueError("invalid provider audio")
            converted = (resampler.push(source) if resampler is not None
                         else downsample_24k_to_16k(source))
            if converted.size:
                yield converted
        finally:
            source.fill(0)
    if resampler is not None:
        tail = resampler.push(np.empty(0, dtype=np.float32), final=True)
        if tail.size:
            yield tail


def synthesize(model: object, model_path: pathlib.Path, request: dict[str, object]) -> None:
    import numpy as np

    output_bytes = 0
    output_samples = 0
    chunk_index = 0
    with contextlib.redirect_stdout(sys.stderr):
        for resampled in resampled_audio(model, model_path, request):
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
            if IS_QWEN3 and (model.tokenizer is None or model.speech_tokenizer is None):
                raise ValueError("Qwen3 tokenizers unavailable")
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
