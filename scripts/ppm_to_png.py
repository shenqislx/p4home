#!/usr/bin/env python3
"""Convert the simulator's PPM frame dumps to PNG.

The C harness writes PPM because that needs no libraries; PNG conversion happens
here so the frames can be reviewed inline. Uses only the standard library.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import png_writer  # noqa: E402


def read_ppm(path: Path) -> tuple[int, int, list[tuple[int, int, int]]]:
    data = path.read_bytes()
    if not data.startswith(b"P6"):
        raise SystemExit(f"{path}: not a P6 PPM")

    # Header is three whitespace-separated tokens after the magic, possibly with
    # comment lines.
    fields: list[int] = []
    offset = 2
    while len(fields) < 3:
        while offset < len(data) and data[offset:offset + 1].isspace():
            offset += 1
        if data[offset:offset + 1] == b"#":
            while offset < len(data) and data[offset] != 0x0A:
                offset += 1
            continue
        start = offset
        while offset < len(data) and not data[offset:offset + 1].isspace():
            offset += 1
        fields.append(int(data[start:offset]))
    offset += 1  # single whitespace byte before the raster

    width, height, _maxval = fields
    raster = data[offset:offset + width * height * 3]
    pixels = [
        (raster[i], raster[i + 1], raster[i + 2])
        for i in range(0, len(raster), 3)
    ]
    return width, height, pixels


def load_frame(source: Path, crop, zoom: int):
    width, height, pixels = read_ppm(source)
    if crop is not None:
        crop_x, crop_y, crop_w, crop_h = crop
        cropped = []
        for y in range(crop_y, min(crop_y + crop_h, height)):
            row = pixels[y * width:(y + 1) * width]
            cropped.extend(row[crop_x:min(crop_x + crop_w, width)])
        pixels = cropped
        width = min(crop_x + crop_w, width) - crop_x
        height = min(crop_y + crop_h, height) - crop_y

    rgba = [(r, g, b, 255) for r, g, b in pixels]
    if zoom > 1:
        rgba, width, height = png_writer.upscale(rgba, width, height, zoom)
    return width, height, rgba


def write_sheet(target: Path, frames, columns: int, gap: int = 4) -> None:
    """Tile frames into one PNG.

    Reviewing an 8 FPS animation one file at a time hides exactly the thing that
    matters - whether consecutive frames read as deliberate steps or as a stutter.
    A contact sheet puts them side by side.
    """
    tile_w = max(f[0] for f in frames)
    tile_h = max(f[1] for f in frames)
    rows = (len(frames) + columns - 1) // columns
    sheet_w = columns * tile_w + (columns - 1) * gap
    sheet_h = rows * tile_h + (rows - 1) * gap
    canvas = [(16, 16, 20, 255)] * (sheet_w * sheet_h)

    for index, (width, height, rgba) in enumerate(frames):
        ox = (index % columns) * (tile_w + gap)
        oy = (index // columns) * (tile_h + gap)
        for y in range(height):
            base = (oy + y) * sheet_w + ox
            canvas[base:base + width] = rgba[y * width:(y + 1) * width]

    png_writer.write_rgba(target, sheet_w, sheet_h, canvas)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--out-dir", type=Path, default=None,
                        help="Defaults to writing next to each input")
    parser.add_argument("--crop", default=None,
                        help="X,Y,W,H region to extract (device pixels)")
    parser.add_argument("--zoom", type=int, default=1)
    parser.add_argument("--sheet", type=Path, default=None,
                        help="Tile every input into one contact sheet PNG")
    parser.add_argument("--sheet-columns", type=int, default=3)
    args = parser.parse_args()

    crop = None
    if args.crop:
        crop = [int(part) for part in args.crop.split(",")]
        if len(crop) != 4:
            raise SystemExit("--crop needs X,Y,W,H")

    if args.sheet is not None:
        frames = [load_frame(source, crop, args.zoom) for source in args.inputs]
        write_sheet(args.sheet, frames, max(args.sheet_columns, 1))
        print(f"{len(frames)} frames -> {args.sheet}")
        return 0

    for source in args.inputs:
        width, height, rgba = load_frame(source, crop, args.zoom)
        out_dir = args.out_dir or source.parent
        target = out_dir / (source.stem + ".png")
        png_writer.write_rgba(target, width, height, rgba)
        print(f"{source.name} -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
