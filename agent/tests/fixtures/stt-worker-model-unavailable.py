#!/usr/bin/env python3
"""Emit the persistent worker's bounded startup failure."""

import sys


sys.stdout.write(
    '{"schema_version":2,"status":"startup_error","error_code":"MODEL_UNAVAILABLE"}\n'
)
sys.stdout.flush()
raise SystemExit(2)
