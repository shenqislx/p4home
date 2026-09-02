#!/usr/bin/env python3
import base64
import contextlib
import json
import sys

VERSION = "a71e4d38b236d968966a2002c4c895dbd12b1c3c"
PROTOCOL_STDOUT = sys.stdout


def emit(value):
    print(json.dumps(value, separators=(",", ":")), file=PROTOCOL_STDOUT, flush=True)


emit({
    "schema_version": 2,
    "status": "ready",
    "provider_version": "0.4.8",
    "model_revision": VERSION,
    "python_version": "3.12.12",
})
for line in sys.stdin:
    request = json.loads(line)
    identity = {
        "interaction_id": request["interaction_id"],
        "assignment_id": request["assignment_id"],
        "segment_index": request["segment_index"],
        "role_id": request["role_id"],
        "voice": request["voice"],
    }
    pcm = bytes([request["segment_index"] & 0xFF, 0]) * 320
    # Match the production worker: model generation owns a diagnostic stdout
    # redirect while protocol chunks must continue on the original stdout.
    with contextlib.redirect_stdout(sys.stderr):
        for index, offset in enumerate((0, 320)):
            piece = pcm[offset : offset + 320]
            emit({
                "schema_version": 2,
                "status": "chunk",
                **identity,
                "chunk_index": index,
                "pcm_base64": base64.b64encode(piece).decode("ascii"),
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_bits": 16,
                "samples": 160,
                "duration_ms": 10.0,
                "final": False,
            })
    emit({
        "schema_version": 2,
        "status": "completed",
        **identity,
        "chunk_count": 2,
        "pcm_bytes": 640,
        "sample_rate_hz": 16000,
        "channels": 1,
        "sample_bits": 16,
        "samples": 320,
        "duration_ms": 20.0,
        "python_version": "3.12.12",
    })
