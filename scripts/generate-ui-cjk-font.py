#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess


REPO_ROOT = Path(__file__).resolve().parents[1]
ENTITIES_PATH = REPO_ROOT / "firmware/components/panel_data_store/panel_entities.json"
FONT_RELATIVE = "scripts/built_in_font/SourceHanSansSC-Normal.otf"


def find_source_font() -> Path:
    """Locate SourceHanSansSC in the LVGL component.

    Prefers the extracted managed_components copy, but falls back to the
    component manager download cache so the font can be regenerated without a
    prior `idf.py build`.
    """
    managed = REPO_ROOT / "firmware/managed_components/lvgl__lvgl" / FONT_RELATIVE
    if managed.is_file():
        return managed

    cache_roots = [
        Path(os.environ.get("IDF_COMPONENT_MANAGER_CACHE_PATH", ""))
        if os.environ.get("IDF_COMPONENT_MANAGER_CACHE_PATH")
        else None,
        Path.home() / ".cache/Espressif/ComponentManager",
    ]
    for root in cache_roots:
        if root is None or not root.is_dir():
            continue
        candidates = sorted(root.glob(f"*/lvgl__lvgl_9.*/{FONT_RELATIVE}"), reverse=True)
        if candidates:
            return candidates[0]

    raise SystemExit(
        f"SourceHanSansSC not found. Expected {managed} (run idf.py build once) "
        "or an lvgl__lvgl_9.* entry in the component manager cache."
    )
OUTPUT_PATH = (
    REPO_ROOT
    / "firmware/components/ui_pages/fonts/ui_font_source_han_sans_sc_16.c"
)
STATIC_UI_TEXT = (
    "空调控制当前模式关闭离线当前温度设定温度模式切换"
    "制冷制热除湿送风正在发送控制指令控制失败控制指令已发送在线"
    "快捷模式回家离家睡眠舒适迎宾照明风管机全屋灯具熄灯主卧"
    "重点区域正在执行已发送执行失败等待连接不可用可用"
    "像素之家我在等这个家上线家里很安静状态正常今晚的家很明亮"
    "正在为你保持舒适欢迎回来客厅餐厨书房场景准备中已启程未发送"
    "确认场景可用发送至等待家庭响应指令已交给连接或服务调用失败"
    # Pixel home cutaway: the six room plates plus the four groups the previous
    # four-room layout dropped.
    "次卧玄关拱门客卫主卫衣帽间阳台"
    # Actor dialogue. Punctuation included on purpose: a missing ，or …renders as
    # a tofu box just like a missing glyph.
    "灯火通明氛围值拉满在制冷好凉快去看看夜深且全屋熄灯休息了先休息一下！，…"
)

COMMON_CJK_PUNCTUATION = "，。！？；：、（）【】《》“”‘’—…·"


def collect_gb2312_level1() -> set[str]:
    """Return the 3,755 GB2312 level-1 Chinese characters.

    Level 1 covers the common modern Chinese characters while keeping the
    generated bitmap small enough for the 3 MiB firmware partition.
    """
    symbols: set[str] = set()
    for lead in range(0xB0, 0xD8):
        trail_end = 0xFA if lead == 0xD7 else 0xFF
        for trail in range(0xA1, trail_end):
            symbols.add(bytes((lead, trail)).decode("gb2312"))
    if len(symbols) != 3755:
        raise RuntimeError(f"unexpected GB2312 level-1 size: {len(symbols)}")
    return symbols


def collect_symbols() -> str:
    with ENTITIES_PATH.open(encoding="utf-8") as handle:
        document = json.load(handle)

    symbols = collect_gb2312_level1()
    symbols.update(COMMON_CJK_PUNCTUATION)
    symbols.update(char for char in STATIC_UI_TEXT if ord(char) > 0x7F)
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
    source_font = find_source_font()
    output = OUTPUT_PATH.relative_to(REPO_ROOT)
    command = converter_command(args.converter) + [
        "--size",
        "16",
        "--bpp",
        "2",
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
