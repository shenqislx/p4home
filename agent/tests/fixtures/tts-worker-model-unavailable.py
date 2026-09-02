#!/usr/bin/env python3
import json

print(json.dumps({
    "schema_version": 2,
    "status": "startup_error",
    "error_code": "MODEL_UNAVAILABLE",
}, separators=(",", ":")), flush=True)
