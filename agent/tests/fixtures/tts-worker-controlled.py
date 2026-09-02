#!/usr/bin/env python3
import base64
import json
import sys
import time


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


emit({
    "schema_version": 2,
    "status": "ready",
    "provider_version": "0.4.8",
    "model_revision": "a71e4d38b236d968966a2002c4c895dbd12b1c3c",
    "python_version": "3.12.12",
})
for line in sys.stdin:
    request = json.loads(line)
    if request["text"] == "慢请求。":
        time.sleep(10)
    identity = {key: request[key] for key in (
        "interaction_id", "assignment_id", "segment_index", "role_id", "voice"
    )}
    pcm = bytes([3, 0]) * 320
    emit({
        "schema_version": 2,
        "status": "chunk",
        **identity,
        "chunk_index": 0,
        "pcm_base64": base64.b64encode(pcm).decode("ascii"),
        "sample_rate_hz": 16000,
        "channels": 1,
        "sample_bits": 16,
        "samples": 320,
        "duration_ms": 20.0,
        "final": False,
    })
    emit({
        "schema_version": 2,
        "status": "completed",
        **identity,
        "chunk_count": 1,
        "pcm_bytes": 640,
        "sample_rate_hz": 16000,
        "channels": 1,
        "sample_bits": 16,
        "samples": 320,
        "duration_ms": 20.0,
        "python_version": "3.12.12",
    })
