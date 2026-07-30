#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "lvgl.h"

/* Shared 8 FPS heartbeat for the pixel home page.
 *
 * Pixel-art animation is traditionally 6-12 discrete frames per second, so
 * rather than fighting the panel we lock everything to one 125 ms tick and
 * quantise all motion to the art grid. Every effect declares a divider so the
 * expensive ones do not all land on the same tick and blow the dirty-area
 * budget (the panel renders in 50-line stripes, single-buffered). */

#define UI_FX_TICK_MS 125U

/* Return false to unregister the effect. */
typedef bool (*ui_fx_tick_cb_t)(uint32_t tick, void *user_data);

esp_err_t ui_pixel_fx_init(void);

/* divider: run every Nth tick (1 = every tick). phase: offset within the
 * divider, used to spread effects across ticks. */
esp_err_t ui_pixel_fx_register(ui_fx_tick_cb_t callback, void *user_data,
                               uint8_t divider, uint8_t phase);
void ui_pixel_fx_unregister(ui_fx_tick_cb_t callback, void *user_data);

/* The page shell calls these so the heartbeat stops while Home is hidden. */
void ui_pixel_fx_set_active(bool active);
bool ui_pixel_fx_active(void);

uint32_t ui_pixel_fx_tick(void);

/* --- Dirty-area budget -----------------------------------------------------
 * The panel is single-buffered with a 1024x50 stripe draw buffer, so the cost of
 * a tick is essentially its total invalidated area. Effects that move a lot of
 * pixels ask for their area first and skip this tick if the budget is already
 * spent; because everything is quantised to the 8 FPS grid, a deferred frame is
 * indistinguishable from a slightly slower animation. */

#define UI_FX_TICK_BUDGET_PX (1024U * 50U)

/* Returns true and charges `device_px` against this tick's budget, or false when
 * the tick is already full. Areas are in device pixels, not art pixels. */
bool ui_pixel_fx_take_budget(uint32_t device_px);

/* Peak per-tick charge since the last call, for the VERIFY: logs. */
uint32_t ui_pixel_fx_budget_peak(void);

/* --- Palette cycling -------------------------------------------------------
 * The cheapest possible pixel effect: never move geometry, only swap colours.
 * A candle is a non-uniform ramp because an evenly timed blink reads as an LED
 * rather than a flame. */

typedef enum {
    UI_FX_CYCLE_CANDLE = 0, /* warm, deliberately uneven cadence */
    UI_FX_CYCLE_SCREEN,     /* cool glow with an occasional bright frame */
    UI_FX_CYCLE_WATER,      /* even 4-step shimmer */
} ui_fx_cycle_kind_t;

/* Recolours `target` in place on every tick. Registered cycles start disabled so
 * a lamp only flickers while its room is actually lit. */
esp_err_t ui_pixel_fx_add_cycle(lv_obj_t *target, ui_fx_cycle_kind_t kind,
                                uint8_t divider);

/* Enables or disables the cycle attached to `target`. When disabled the target
 * is painted with `off_colour` once and then left alone. */
void ui_pixel_fx_set_cycle_enabled(lv_obj_t *target, bool enabled, uint32_t off_colour);

/* --- One-shot sprite bursts ------------------------------------------------ */

/* Plays `frames` once at one frame per `divider` ticks, then hides the object.
 * Used for the light-on sparkle and the light-off smoke. */
esp_err_t ui_pixel_fx_play_once(lv_obj_t *image, const lv_image_dsc_t *const *frames,
                                size_t frame_count, uint8_t divider);

/* Called on the tick the flight lands, before the sprite is hidden. */
typedef void (*ui_fx_arrive_cb_t)(void *user_data);

/* Flies `image` from (art_x, art_y) by (step_x, step_y) art pixels per frame for
 * `steps` frames, looping `frames`, then hides it and calls `on_arrive`.
 * Deliberately a stepped path with no interpolation: at 8 FPS a tweened arc
 * would land on sub-pixel positions and read as jitter, while whole art-pixel
 * jumps read as a projectile. Used for the scene rune. */
esp_err_t ui_pixel_fx_fly_once(lv_obj_t *image, const lv_image_dsc_t *const *frames,
                               size_t frame_count, int32_t art_x, int32_t art_y,
                               int32_t step_x, int32_t step_y, uint8_t steps,
                               ui_fx_arrive_cb_t on_arrive, void *user_data);

/* --- Helpers -------------------------------------------------------------- */

/* Creates an lv_image at art-grid coordinates, upscaled with antialiasing off.
 * All pixel home sprites must go through this so the 4x nearest-neighbour path
 * and the grid quantisation are applied consistently. */
lv_obj_t *ui_pixel_fx_sprite(lv_obj_t *parent, const lv_image_dsc_t *src,
                             int32_t art_x, int32_t art_y);

/* Moves a sprite to art-grid coordinates (multiples of one art pixel). */
void ui_pixel_fx_sprite_move(lv_obj_t *sprite, int32_t art_x, int32_t art_y);

/* Swaps a sprite's frame. Always use this rather than lv_image_set_src: an
 * lv_image keeps its object size independent of the source, and with a top-left
 * pivot the scaled draw extent follows the source size. A frame of a different
 * size therefore has to resize the object too, or LVGL invalidates the old
 * (smaller) rectangle and leaves stale pixels behind. */
void ui_pixel_fx_sprite_set_src(lv_obj_t *sprite, const lv_image_dsc_t *src);
