#!/usr/bin/env python3
import json
import sys

request = json.loads(sys.stdin.readline())
print(json.dumps({
    "schema_version": 1,
    "status": "error",
    "interaction_id": request["interaction_id"],
    "assignment_id": request["assignment_id"],
    "segment_index": request["segment_index"],
    "role_id": request["role_id"],
    "voice": request["voice"],
    "error_code": "MODEL_UNAVAILABLE",
}, separators=(",", ":")))
