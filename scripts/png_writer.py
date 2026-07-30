#!/usr/bin/env python3
"""Minimal PNG encoder built on the standard library only.

This environment has neither Pillow nor pypng, and the asset pipeline plus the
simulator frame dumper both need to emit images. PNG is just zlib-compressed
scanlines wrapped in CRC32-checked chunks, so writing it directly avoids adding
a third-party dependency to the build.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

RGB = tuple[int, int, int]
RGBA = tuple[int, int, int, int]


def _chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def write_rgba(path: Path, width: int, height: int, pixels: list[RGBA]) -> None:
    """Write an 8-bit RGBA PNG. `pixels` is row-major, length width*height."""
    if len(pixels) != width * height:
        raise ValueError(f"expected {width * height} pixels, got {len(pixels)}")

    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        row = pixels[y * width:(y + 1) * width]
        for r, g, b, a in row:
            raw += bytes((r & 0xFF, g & 0xFF, b & 0xFF, a & 0xFF))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    data = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def write_rgb(path: Path, width: int, height: int, pixels: list[RGB]) -> None:
    """Write an 8-bit RGB PNG (no alpha channel)."""
    write_rgba(path, width, height, [(r, g, b, 255) for r, g, b in pixels])


def upscale(pixels: list[RGBA], width: int, height: int, factor: int) -> tuple[list[RGBA], int, int]:
    """Nearest-neighbour upscale, matching what lv_image_set_antialias(false) does."""
    if factor <= 1:
        return pixels, width, height
    out: list[RGBA] = []
    for y in range(height * factor):
        row = pixels[(y // factor) * width:(y // factor + 1) * width]
        for x in range(width * factor):
            out.append(row[x // factor])
    return out, width * factor, height * factor
