#!/usr/bin/env python3
import base64
import json
import sys

request = json.loads(sys.stdin.readline())
pcm = bytes([request["segment_index"] & 0xFF, 0]) * 320
print(json.dumps({
    "schema_version": 1,
    "status": "completed",
    "interaction_id": request["interaction_id"],
    "assignment_id": request["assignment_id"],
    "segment_index": request["segment_index"],
    "role_id": request["role_id"],
    "voice": request["voice"],
    "pcm_base64": base64.b64encode(pcm).decode("ascii"),
    "sample_rate_hz": 16000,
    "channels": 1,
    "sample_bits": 16,
    "samples": 320,
    "duration_ms": 20.0,
    "python_version": "3.12.12",
}, separators=(",", ":")))
