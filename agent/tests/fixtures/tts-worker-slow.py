#!/usr/bin/env python3
import json
import sys
import time

print(json.dumps({
    "schema_version": 2,
    "status": "ready",
    "provider_version": "0.4.8",
    "model_revision": "a71e4d38b236d968966a2002c4c895dbd12b1c3c",
    "python_version": "3.12.12",
}, separators=(",", ":")), flush=True)
for line in sys.stdin:
    json.loads(line)
    time.sleep(10)
