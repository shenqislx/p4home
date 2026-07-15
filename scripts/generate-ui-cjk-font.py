#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess


REPO_ROOT = Path(__file__).resolve().parents[1]
ENTITIES_PATH = REPO_ROOT / "firmware/components/panel_data_store/panel_entities.json"
SOURCE_FONT_PATH = (
    REPO_ROOT
    / "firmware/managed_components/lvgl__lvgl/scripts/built_in_font/SourceHanSansSC-Normal.otf"
)
OUTPUT_PATH = (
    REPO_ROOT
    / "firmware/components/ui_pages/fonts/ui_font_source_han_sans_sc_16.c"
)
STATIC_UI_TEXT = (
    "空调控制当前模式关闭离线当前温度设定温度模式切换"
    "制冷制热除湿送风正在发送控制指令控制失败控制指令已发送在线"
)


def collect_symbols() -> str:
    with ENTITIES_PATH.open(encoding="utf-8") as handle:
        document = json.load(handle)

    symbols = {char for char in STATIC_UI_TEXT if ord(char) > 0x7F}
    for entity in document.get("entities", []):
        for key in ("label", "group"):
            symbols.update(char for char in entity.get(key, "") if ord(char) > 0x7F)
    return "".join(sorted(symbols))


def converter_command(explicit_converter: str | None) -> list[str]:
    converter = explicit_converter or os.environ.get("LV_FONT_CONV") or shutil.which("lv_font_conv")
    if converter:
        return [converter]
    return ["npx", "--yes", "lv_font_conv"]


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the p4home LVGL CJK font subset")
    parser.add_argument("--converter", help="Path to the lv_font_conv executable")
    args = parser.parse_args()

    symbols = collect_symbols()
    if not symbols:
        raise SystemExit("No CJK symbols found in panel_entities.json")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    source_font = SOURCE_FONT_PATH.relative_to(REPO_ROOT)
    output = OUTPUT_PATH.relative_to(REPO_ROOT)
    command = converter_command(args.converter) + [
        "--size",
        "16",
        "--bpp",
        "4",
        "--format",
        "lvgl",
        "--font",
        str(source_font),
        "--symbols",
        symbols,
        "--no-compress",
        "--no-prefilter",
        "--lv-include",
        "lvgl.h",
        "--lv-font-name",
        "ui_font_source_han_sans_sc_16",
        "--lv-fallback",
        "lv_font_montserrat_14",
        "--force-fast-kern-format",
        "-o",
        str(output),
    ]
    subprocess.run(command, check=True, cwd=REPO_ROOT)
    print(f"Generated {output} with {len(symbols)} CJK glyphs")


if __name__ == "__main__":
    main()
