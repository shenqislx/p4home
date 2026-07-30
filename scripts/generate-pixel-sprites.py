#!/usr/bin/env python3
"""Compile ASCII pixel art (.pxart) into LVGL RGB565A8 C arrays.

Why ASCII instead of PNG + LVGL's own scripts/LVGLImage.py:
  * LVGLImage.py needs PNG input and the `pypng` package, neither of which is
    available offline here.
  * Indexed (I1..I8) output is useless to us: the LVGL v9 software renderer
    cannot draw indexed images natively, it converts them to ARGB8888, and the
    scale path then needs the whole image resident in the (128 KB) LVGL heap.
    RGB565A8 const arrays scale straight out of flash with zero heap.
  * LVGL v9 removed gradient dithering, so shading ramps have to be baked. The
    generators below do that with an ordered Bayer matrix.

Art is authored at 1x and upscaled at runtime with
lv_image_set_scale(img, UI_PX_IMAGE_SCALE) + lv_image_set_antialias(img, false),
which keeps flash cost 16x lower than baking the 4x upscale in.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pixel_palette import (  # noqa: E402
    REPO_ROOT,
    bayer_threshold,
    load_palette,
    mix,
    rgb565_to_rgb888,
    to_rgb565,
)
import png_writer  # noqa: E402

ART_DIR = REPO_ROOT / "assets/pixel"
OUT_DIR = REPO_ROOT / "firmware/components/ui_pixel_art/sprites"
HEADER_OUT = REPO_ROOT / "firmware/components/ui_pixel_art/include/ui_pixel_art.h"
PREVIEW_DIR = REPO_ROOT / "build-preview/sprites"

TRANSPARENT_CHARS = ".", " "

Pixel = tuple[int, int, int, int]  # r, g, b, a


@dataclass
class SpriteSpec:
    name: str
    source: Path
    directives: dict[str, str]
    frames: list[list[str]] = field(default_factory=list)

    @property
    def bake_scale(self) -> int:
        return int(self.directives.get("bake_scale", "1"))


def parse_pxart(path: Path) -> SpriteSpec:
    directives: dict[str, str] = {}
    frames: list[list[str]] = []
    current: list[str] | None = None

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.rstrip("\n")
        stripped = line.strip()
        if stripped.startswith("--frame"):
            current = []
            frames.append(current)
            continue
        if stripped.startswith("#"):
            body = stripped.lstrip("#").strip()
            if not body or ":" not in body:
                continue
            key, _, value = body.partition(":")
            directives[key.strip().lower()] = value.strip()
            continue
        if current is not None:
            # Trailing whitespace is significant (transparent pixels), leading
            # is too, so only strip the newline.
            current.append(line)

    name = directives.get("name") or path.stem
    return SpriteSpec(name=name, source=path, directives=directives, frames=frames)


def parse_palette_map(spec: SpriteSpec, palette: dict) -> dict[str, tuple]:
    """Parse the `palette:` directive into {char: (colour_a, colour_b, alpha)}.

    Accepted forms per entry, separated by whitespace:
        c=NAME              opaque palette colour
        c=NAME/128          colour with a constant alpha 0..255
        c=NAME1+NAME2       ordered-dither blend of two colours
        c=NAME1+NAME2/128   both
    """
    text = spec.directives.get("palette", "")
    mapping: dict[str, tuple] = {}
    for entry in text.split():
        if "=" not in entry:
            raise SystemExit(f"{spec.source}: bad palette entry {entry!r}")
        char, _, body = entry.partition("=")
        if len(char) != 1:
            raise SystemExit(f"{spec.source}: palette key {char!r} must be one character")
        alpha = 255
        if "/" in body:
            body, _, alpha_text = body.partition("/")
            alpha = int(alpha_text)
        names = body.split("+")
        colours = []
        for name in names:
            key = name.strip().upper()
            if key not in palette:
                raise SystemExit(
                    f"{spec.source}: unknown palette colour UI_PAL_{key} for char {char!r}"
                )
            colours.append(palette[key])
        if len(colours) == 1:
            colours.append(colours[0])
        mapping[char] = (colours[0], colours[1], alpha)
    return mapping


def render_ascii_frame(rows: list[str], palette_map: dict, width: int, height: int) -> list[Pixel]:
    pixels: list[Pixel] = []
    for y in range(height):
        row = rows[y] if y < len(rows) else ""
        for x in range(width):
            char = row[x] if x < len(row) else "."
            if char in TRANSPARENT_CHARS:
                pixels.append((0, 0, 0, 0))
                continue
            if char not in palette_map:
                raise SystemExit(f"undeclared palette char {char!r} at ({x},{y})")
            colour_a, colour_b, alpha = palette_map[char]
            if colour_a == colour_b:
                pixels.append((*colour_a, alpha))
            else:
                # Ordered dither between the pair so a single char can express a
                # believable mid tone without a third palette entry.
                pick = colour_b if bayer_threshold(x, y) < 0.5 else colour_a
                pixels.append((*pick, alpha))
    return pixels


def gen_vgrad(spec: SpriteSpec, palette: dict, width: int, height: int) -> list[Pixel]:
    top = palette[spec.directives["from"].upper()]
    bottom = palette[spec.directives["to"].upper()]
    pixels: list[Pixel] = []
    for y in range(height):
        ratio = y / max(height - 1, 1)
        for x in range(width):
            # Nudge the blend ratio by the dither threshold, then snap to one of
            # the two endpoints. That is what produces visible ordered dithering
            # rather than a smooth (and in RGB565, banded) ramp.
            threshold = bayer_threshold(x, y)
            shade = mix(top, bottom, 1.0 if ratio > threshold else 0.0)
            blended = mix(top, bottom, ratio)
            pick = shade if abs(ratio - threshold) < 0.18 else blended
            pixels.append((*pick, 255))
    return pixels


def gen_cone(spec: SpriteSpec, palette: dict, width: int, height: int) -> list[Pixel]:
    """A downward light cone: widens with depth, fades out, ordered dithered."""
    colour = palette[spec.directives.get("from", "LAMP_LIGHT").upper()]
    top_width = int(spec.directives.get("top_width", "2"))
    max_alpha = int(spec.directives.get("max_alpha", "150"))
    # falloff > 1 thins the cone out quickly with depth. The dither pattern only
    # reads as light if most of the cone's area stays transparent; a cone that is
    # dense all the way down reads as a solid dotted wedge and hides the
    # furniture it is supposed to be lighting.
    falloff = float(spec.directives.get("falloff", "1.0"))
    pixels: list[Pixel] = []
    centre = (width - 1) / 2.0
    for y in range(height):
        depth = y / max(height - 1, 1)
        half = (top_width / 2.0) + depth * (width / 2.0 - top_width / 2.0)
        for x in range(width):
            distance = abs(x - centre)
            if distance > half:
                pixels.append((0, 0, 0, 0))
                continue
            # Fade both with depth and towards the cone edges.
            edge = 1.0 - (distance / max(half, 0.001))
            strength = ((1.0 - depth) ** falloff) * (0.30 + 0.70 * edge)
            if strength < bayer_threshold(x, y):
                pixels.append((0, 0, 0, 0))
                continue
            pixels.append((*colour, max_alpha))
    return pixels


def gen_scanline(spec: SpriteSpec, palette: dict, width: int, height: int) -> list[Pixel]:
    """CRT overlay tile: darkened rows, fully static, tiled by LVGL."""
    colour = palette[spec.directives.get("from", "SHADOW").upper()]
    alpha = int(spec.directives.get("max_alpha", "40"))
    period = int(spec.directives.get("period", "2"))
    pixels: list[Pixel] = []
    for y in range(height):
        dark = (y % period) == (period - 1)
        for x in range(width):
            pixels.append((*colour, alpha) if dark else (0, 0, 0, 0))
    return pixels


GENERATORS = {
    "vgrad": gen_vgrad,
    "cone": gen_cone,
    "scanline": gen_scanline,
}


def build_frames(spec: SpriteSpec, palette: dict) -> tuple[int, int, list[list[Pixel]]]:
    size = spec.directives.get("size")
    if size:
        match = re.fullmatch(r"(\d+)\s*x\s*(\d+)", size)
        if match is None:
            raise SystemExit(f"{spec.source}: bad size {size!r}, expected WxH")
        width, height = int(match.group(1)), int(match.group(2))
    else:
        if not spec.frames:
            raise SystemExit(f"{spec.source}: needs either a size: or ASCII frames")
        width = max(len(row) for row in spec.frames[0])
        height = len(spec.frames[0])

    generator = spec.directives.get("gen")
    if generator:
        if generator not in GENERATORS:
            raise SystemExit(f"{spec.source}: unknown generator {generator!r}")
        frames = [GENERATORS[generator](spec, palette, width, height)]
    else:
        palette_map = parse_palette_map(spec, palette)
        if not spec.frames:
            raise SystemExit(f"{spec.source}: no --frame blocks found")
        frames = [render_ascii_frame(rows, palette_map, width, height) for rows in spec.frames]

    scale = spec.bake_scale
    if scale > 1:
        frames = [png_writer.upscale(frame, width, height, scale)[0] for frame in frames]
        width, height = width * scale, height * scale

    return width, height, frames


def encode_rgb565a8(width: int, height: int, pixels: list[Pixel]) -> bytes:
    """RGB565 plane (stride w*2, little endian) followed by the A8 plane.

    Layout verified against lv_draw_buf.c:668 which sizes RGB565A8 as
    stride*h + (stride/2)*h.
    """
    colour_plane = bytearray()
    alpha_plane = bytearray()
    for r, g, b, a in pixels:
        value = to_rgb565((r, g, b))
        colour_plane += bytes((value & 0xFF, (value >> 8) & 0xFF))
        alpha_plane.append(a)
    assert len(colour_plane) == width * height * 2
    assert len(alpha_plane) == width * height
    return bytes(colour_plane + alpha_plane)


def format_c_array(data: bytes, indent: str = "    ") -> str:
    lines = []
    for offset in range(0, len(data), 12):
        chunk = data[offset:offset + 12]
        lines.append(indent + ", ".join(f"0x{byte:02x}" for byte in chunk) + ",")
    return "\n".join(lines)


def emit_sprite_c(spec: SpriteSpec, width: int, height: int, frames: list[list[Pixel]]) -> str:
    stride = width * 2
    parts = [
        "/* Generated by scripts/generate-pixel-sprites.py. Do not edit by hand.",
        f" * Source: assets/pixel/{spec.source.name} */",
        "",
        '#include "lvgl.h"',
        "",
    ]
    for index, frame in enumerate(frames):
        symbol = spec.name if len(frames) == 1 else f"{spec.name}_{index}"
        data = encode_rgb565a8(width, height, frame)
        parts.append(
            f"static const uint8_t {symbol}_map[] = {{\n{format_c_array(data)}\n}};\n"
        )
        parts.append(
            f"const lv_image_dsc_t {symbol} = {{\n"
            "    .header.magic = LV_IMAGE_HEADER_MAGIC,\n"
            "    .header.cf = LV_COLOR_FORMAT_RGB565A8,\n"
            "    .header.flags = 0,\n"
            f"    .header.w = {width},\n"
            f"    .header.h = {height},\n"
            f"    .header.stride = {stride},\n"
            "    .header.reserved_2 = 0,\n"
            f"    .data_size = sizeof({symbol}_map),\n"
            f"    .data = {symbol}_map,\n"
            "};\n"
        )
    return "\n".join(parts)


def emit_header(specs: list[tuple[SpriteSpec, int]]) -> str:
    lines = [
        "/* Generated by scripts/generate-pixel-sprites.py. Do not edit by hand. */",
        "",
        "#pragma once",
        "",
        '#include "lvgl.h"',
        "",
    ]
    for spec, frame_count in specs:
        if frame_count == 1:
            lines.append(f"LV_IMAGE_DECLARE({spec.name});")
        else:
            for index in range(frame_count):
                lines.append(f"LV_IMAGE_DECLARE({spec.name}_{index});")
            lines.append(
                f"#define {spec.name.upper()}_FRAME_COUNT {frame_count}"
            )
            refs = ", ".join(f"&{spec.name}_{i}" for i in range(frame_count))
            lines.append(
                f"/* Frame list for lv_animimg_set_src(); must stay static. */"
            )
            lines.append(
                f"#define {spec.name.upper()}_FRAMES {{ {refs} }}"
            )
        lines.append("")
    return "\n".join(lines)


def write_preview(spec: SpriteSpec, width: int, height: int, frames: list[list[Pixel]], zoom: int) -> None:
    for index, frame in enumerate(frames):
        # Round-trip through RGB565 so the preview shows the real banding.
        quantised = [
            (*rgb565_to_rgb888(to_rgb565((r, g, b))), a) for r, g, b, a in frame
        ]
        pixels, out_w, out_h = png_writer.upscale(quantised, width, height, zoom)
        suffix = "" if len(frames) == 1 else f"_{index}"
        png_writer.write_rgba(PREVIEW_DIR / f"{spec.name}{suffix}.png", out_w, out_h, pixels)


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile .pxart files into LVGL C arrays")
    parser.add_argument("--art-dir", type=Path, default=ART_DIR)
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR)
    parser.add_argument("--preview", action="store_true", help="Also write PNG previews")
    parser.add_argument("--preview-zoom", type=int, default=4)
    parser.add_argument("--check", action="store_true",
                        help="Fail instead of writing if output would change")
    args = parser.parse_args()

    palette = load_palette()
    sources = sorted(args.art_dir.glob("*.pxart"))
    if not sources:
        raise SystemExit(f"No .pxart files under {args.art_dir}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    emitted: list[tuple[SpriteSpec, int]] = []
    total_bytes = 0
    stale = False

    for source in sources:
        spec = parse_pxart(source)
        width, height, frames = build_frames(spec, palette)
        text = emit_sprite_c(spec, width, height, frames)
        target = args.out_dir / f"{spec.name}.c"
        if args.check:
            if not target.exists() or target.read_text(encoding="utf-8") != text:
                print(f"stale: {target.relative_to(REPO_ROOT)}")
                stale = True
        else:
            target.write_text(text, encoding="utf-8")
        if args.preview:
            write_preview(spec, width, height, frames, args.preview_zoom)
        frame_bytes = (width * height * 3) * len(frames)
        total_bytes += frame_bytes
        emitted.append((spec, len(frames)))
        print(f"{spec.name}: {width}x{height} x{len(frames)}f -> {frame_bytes} B")

    header_text = emit_header(emitted)
    if args.check:
        if not HEADER_OUT.exists() or HEADER_OUT.read_text(encoding="utf-8") != header_text:
            print(f"stale: {HEADER_OUT.relative_to(REPO_ROOT)}")
            stale = True
        return 1 if stale else 0

    HEADER_OUT.parent.mkdir(parents=True, exist_ok=True)
    HEADER_OUT.write_text(header_text, encoding="utf-8")
    print(f"total sprite flash: {total_bytes} B ({total_bytes / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
