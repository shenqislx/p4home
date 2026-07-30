#pragma once

#include <stdint.h>

/* Fixed palette for the pixel home page.
 *
 * Every ramp is ordered dark -> base -> light -> highlight so that baked Bayer
 * dithering has a believable mid tone to step through. LVGL v9 removed gradient
 * dithering, so all shading has to come from these discrete steps. */

/* One art pixel is UI_PX(1) device pixels. Every coordinate, size and offset on
 * the pixel home page must be a multiple of this, otherwise sub-pixel motion at
 * 8 FPS reads as stutter instead of a deliberate stepped animation. */
#define UI_PX_SCALE 4
#define UI_PX(n) ((int32_t)(n) * UI_PX_SCALE)

/* Runtime zoom passed to lv_image_set_scale(); LV_SCALE_NONE is 256. */
#define UI_PX_IMAGE_SCALE (256 * UI_PX_SCALE)

/* Sky ramps, indexed by time of day. */
#define UI_PAL_SKY_DAWN_DARK 0x2b2140
#define UI_PAL_SKY_DAWN_BASE 0x5c3f5e
#define UI_PAL_SKY_DAWN_LIGHT 0xa9647a
#define UI_PAL_SKY_DAWN_HI 0xe9a178

#define UI_PAL_SKY_DAY_DARK 0x1f5f80
#define UI_PAL_SKY_DAY_BASE 0x2f83a8
#define UI_PAL_SKY_DAY_LIGHT 0x63b4cd
#define UI_PAL_SKY_DAY_HI 0xa9dbe8

#define UI_PAL_SKY_DUSK_DARK 0x2a1c33
#define UI_PAL_SKY_DUSK_BASE 0x5e3350
#define UI_PAL_SKY_DUSK_LIGHT 0xb35c53
#define UI_PAL_SKY_DUSK_HI 0xe58f52

#define UI_PAL_SKY_NIGHT_DARK 0x080b1c
#define UI_PAL_SKY_NIGHT_BASE 0x11162e
#define UI_PAL_SKY_NIGHT_LIGHT 0x232a4d
#define UI_PAL_SKY_NIGHT_HI 0x3c4570

/* Warm lamp ramp: lamp body, light cone, highlight, afterglow. */
#define UI_PAL_LAMP_DARK 0x7a5320
#define UI_PAL_LAMP_BASE 0xd39a3c
#define UI_PAL_LAMP_LIGHT 0xf3c64e
#define UI_PAL_LAMP_HI 0xfff0b4

/* Cool air-conditioning ramp. */
#define UI_PAL_COOL_DARK 0x1b4a6b
#define UI_PAL_COOL_BASE 0x2f7fae
#define UI_PAL_COOL_LIGHT 0x45a6ff
#define UI_PAL_COOL_HI 0xbfe4ff

/* Materials. */
#define UI_PAL_WOOD_DARK 0x4a3324
#define UI_PAL_WOOD_BASE 0x7a5334
#define UI_PAL_WOOD_LIGHT 0xa8794a
#define UI_PAL_WOOD_HI 0xd4ab70

#define UI_PAL_FABRIC_DARK 0x5c2f38
#define UI_PAL_FABRIC_BASE 0x9b4a52
#define UI_PAL_FABRIC_LIGHT 0xe56b6f
#define UI_PAL_FABRIC_HI 0xf6a9a0

#define UI_PAL_METAL_DARK 0x2a343a
#define UI_PAL_METAL_BASE 0x5b6b74
#define UI_PAL_METAL_LIGHT 0x9aabb3

/* Foliage, used by the parallax trees and the potted plants. */
#define UI_PAL_LEAF_DARK 0x1f4433
#define UI_PAL_LEAF_BASE 0x2f6b46
#define UI_PAL_LEAF_LIGHT 0x51a66f

/* Structure and interface. */
#define UI_PAL_SHELL_DARK 0x1a1410
#define UI_PAL_SHELL_BASE 0x8b6544
#define UI_PAL_SHELL_LIGHT 0xc59a62

#define UI_PAL_INK 0xe8f0f2
#define UI_PAL_MUTED 0x8fa3ad
#define UI_PAL_SHADOW 0x020405
#define UI_PAL_GRID 0x29404b
#define UI_PAL_PANEL 0x101820
#define UI_PAL_PANEL_ALT 0x151f29
#define UI_PAL_SCREEN 0x080c10

#define UI_PAL_ACCENT_CYAN 0x35d0ba
#define UI_PAL_ACCENT_VIOLET 0xc084fc
