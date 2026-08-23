#!/usr/bin/env python3
"""Emit the worker's bounded model-unavailable terminal for process-boundary tests."""

import sys


sys.stdin.buffer.read()
sys.stdout.write(
    '{"schema_version":1,"status":"error","error_code":"MODEL_UNAVAILABLE"}\n'
)
sys.stdout.flush()
raise SystemExit(2)
