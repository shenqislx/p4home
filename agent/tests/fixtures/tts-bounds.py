#!/usr/bin/env python3
import importlib.util
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location("p4home_tts_bounds", source)
if spec is None or spec.loader is None:
    raise SystemExit("cannot load bounds module")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

total = 0
for chunk in (480_000, 480_000, 480_000):
    total = module.checked_source_total(total, chunk)
if total != module.MAX_SOURCE_SAMPLES_24K:
    raise SystemExit("exact source bound mismatch")
try:
    module.checked_source_total(total, 1)
except ValueError:
    print("source-bound:PASS")
else:
    raise SystemExit("multi-chunk overflow was accepted")
