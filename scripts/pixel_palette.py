#!/usr/bin/env python3
"""Single source of truth for the pixel home palette.

The C side reads firmware/components/ui_pages/ui_pixel_palette.h. This module
parses that same header so the two can never drift: adding a colour in the
header immediately makes it usable as a .pxart palette symbol.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PALETTE_HEADER = REPO_ROOT / "firmware/components/ui_pages/ui_pixel_palette.h"

_DEFINE_RE = re.compile(r"^#define\s+UI_PAL_([A-Z0-9_]+)\s+0x([0-9a-fA-F]{6})\s*$")

TRANSPARENT = "transparent"


def load_palette(header: Path | None = None) -> dict[str, tuple[int, int, int]]:
    """Return {SYMBOL: (r, g, b)} for every UI_PAL_* define in the header."""
    path = header or PALETTE_HEADER
    palette: dict[str, tuple[int, int, int]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = _DEFINE_RE.match(line.strip())
        if match is None:
            continue
        name, hex_value = match.group(1), match.group(2)
        value = int(hex_value, 16)
        palette[name] = ((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)
    if not palette:
        raise SystemExit(f"No UI_PAL_* colours found in {path}")
    return palette


def to_rgb565(rgb: tuple[int, int, int]) -> int:
    r, g, b = rgb
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def rgb565_to_rgb888(value: int) -> tuple[int, int, int]:
    """Round-trip a colour through RGB565 so previews show the real banding."""
    r5 = (value >> 11) & 0x1F
    g6 = (value >> 5) & 0x3F
    b5 = value & 0x1F
    r = (r5 << 3) | (r5 >> 2)
    g = (g6 << 2) | (g6 >> 4)
    b = (b5 << 3) | (b5 >> 2)
    return (r, g, b)


def mix(a: tuple[int, int, int], b: tuple[int, int, int], ratio: float) -> tuple[int, int, int]:
    return tuple(round(a[i] + (b[i] - a[i]) * ratio) for i in range(3))  # type: ignore[return-value]


# 4x4 ordered (Bayer) matrix, values 0..15. LVGL v9 has no runtime gradient
# dithering, so shading ramps have to be baked with this at asset build time.
BAYER4 = (
    (0, 8, 2, 10),
    (12, 4, 14, 6),
    (3, 11, 1, 9),
    (15, 7, 13, 5),
)

BAYER2 = (
    (0, 2),
    (3, 1),
)


def bayer_threshold(x: int, y: int, matrix=BAYER4) -> float:
    """Return the 0..1 dither threshold for a pixel position."""
    size = len(matrix)
    levels = size * size
    return (matrix[y % size][x % size] + 0.5) / levels
