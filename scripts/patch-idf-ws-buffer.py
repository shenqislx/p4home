#!/usr/bin/env python3
"""Generate a project-local fix for ESP-IDF 5.5.4 buffered WS readiness."""

import argparse
import hashlib
from pathlib import Path

UPSTREAM_SHA256 = "281a84a82c1e00f0198204a0ea80b981090fc3ec00b480ede3d79c9c5fc5bbfd"


def patch_source(source: str) -> str:
    if hashlib.sha256(source.encode()).hexdigest() != UPSTREAM_SHA256:
        raise ValueError("ESP-IDF transport_ws.c differs from the reviewed 5.5.4 source")
    replacements = [
        (
            "if ((poll_read = esp_transport_poll_read(ws->parent, timeout_ms)) <= 0) {",
            "if (ws->buffer_len == 0 &&\n"
            "        (poll_read = esp_transport_poll_read(ws->parent, timeout_ms)) <= 0) {",
        ),
        (
            "return esp_transport_poll_read(ws->parent, timeout_ms);",
            "/* The HTTP upgrade may already have buffered the first WS frame. */\n"
            "    if (ws->buffer_len > 0) return 1;\n"
            "    return esp_transport_poll_read(ws->parent, timeout_ms);",
        ),
    ]
    for before, after in replacements:
        if source.count(before) != 1:
            raise ValueError("unexpected ESP-IDF WebSocket polling source; review the compatibility fix")
        source = source.replace(before, after)
    return source


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = args.source.read_text()
    patched = patch_source(source)
    content = "/* P4Home generated compatibility fix; upstream SHA-256: " + hashlib.sha256(
        source.encode()
    ).hexdigest() + " */\n" + patched
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if not args.output.exists() or args.output.read_text() != content:
        args.output.write_text(content)


if __name__ == "__main__":
    main()
