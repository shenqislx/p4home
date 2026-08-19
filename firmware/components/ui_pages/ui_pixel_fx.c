#include "ui_pixel_fx.h"

#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "ui_pixel_palette.h"

static const char *TAG = "ui_fx";

#define UI_FX_MAX_EFFECTS 48U
#define UI_FX_MAX_CYCLES 16U
#define UI_FX_MAX_ONESHOTS 12U

typedef struct {
    ui_fx_tick_cb_t callback;
    void *user_data;
    uint8_t divider;
    uint8_t phase;
    bool used;
} ui_fx_slot_t;

typedef struct {
    lv_obj_t *target;
    ui_fx_cycle_kind_t kind;
    uint8_t divider;
    uint8_t step;
    uint8_t hold;
    bool used;
    bool enabled;
} ui_fx_cycle_t;

typedef struct {
    lv_obj_t *image;
    const lv_image_dsc_t *const *frames;
    uint8_t frame_count;
    uint8_t frame;
    uint8_t divider;
    uint8_t hold;
    bool used;
    /* Non-zero `steps` turns the burst into a flight: the sprite advances by
     * (step_x, step_y) art pixels per shown frame and the frame list loops
     * instead of terminating the burst. */
    uint8_t steps;
    int8_t step_x;
    int8_t step_y;
    int16_t art_x;
    int16_t art_y;
    ui_fx_arrive_cb_t on_arrive;
    void *arrive_data;
} ui_fx_oneshot_t;

static ui_fx_slot_t s_slots[UI_FX_MAX_EFFECTS];
static ui_fx_cycle_t s_cycles[UI_FX_MAX_CYCLES];
static ui_fx_oneshot_t s_oneshots[UI_FX_MAX_ONESHOTS];
static lv_timer_t *s_timer;
static uint32_t s_tick;
static bool s_active;
static uint32_t s_budget_spent;
static uint32_t s_budget_peak;
static uint32_t s_budget_denied;
static uint32_t s_last_verify_ms;

/* Colour ramps for the palette cyclers. The candle ramp repeats entries
 * unevenly on purpose: a uniform cycle looks electronic, an irregular one reads
 * as a flame. */
static const uint32_t s_candle_ramp[] = {
    UI_PAL_LAMP_LIGHT, UI_PAL_LAMP_HI, UI_PAL_LAMP_LIGHT, UI_PAL_LAMP_BASE,
    UI_PAL_LAMP_LIGHT, UI_PAL_LAMP_HI, UI_PAL_LAMP_HI, UI_PAL_LAMP_BASE,
};
static const uint8_t s_candle_hold[] = {2, 1, 3, 1, 1, 2, 1, 3};

static const uint32_t s_screen_ramp[] = {
    UI_PAL_COOL_DARK, UI_PAL_COOL_BASE, UI_PAL_COOL_LIGHT, UI_PAL_COOL_BASE,
    UI_PAL_COOL_DARK, UI_PAL_COOL_DARK, UI_PAL_COOL_HI, UI_PAL_COOL_DARK,
};
static const uint8_t s_screen_hold[] = {3, 2, 1, 2, 4, 3, 1, 2};

static const uint32_t s_water_ramp[] = {
    UI_PAL_COOL_DARK, UI_PAL_COOL_BASE, UI_PAL_COOL_LIGHT, UI_PAL_COOL_BASE,
};
static const uint8_t s_water_hold[] = {2, 2, 2, 2};

static void ui_pixel_fx_ramp_for(ui_fx_cycle_kind_t kind, const uint32_t **ramp,
                                 const uint8_t **hold, uint8_t *length)
{
    switch (kind) {
    case UI_FX_CYCLE_SCREEN:
        *ramp = s_screen_ramp;
        *hold = s_screen_hold;
        *length = (uint8_t)(sizeof(s_screen_ramp) / sizeof(s_screen_ramp[0]));
        break;
    case UI_FX_CYCLE_WATER:
        *ramp = s_water_ramp;
        *hold = s_water_hold;
        *length = (uint8_t)(sizeof(s_water_ramp) / sizeof(s_water_ramp[0]));
        break;
    case UI_FX_CYCLE_CANDLE:
    default:
        *ramp = s_candle_ramp;
        *hold = s_candle_hold;
        *length = (uint8_t)(sizeof(s_candle_ramp) / sizeof(s_candle_ramp[0]));
        break;
    }
}

bool ui_pixel_fx_take_budget(uint32_t device_px)
{
    if (s_budget_spent + device_px > UI_FX_TICK_BUDGET_PX) {
        s_budget_denied++;
        return false;
    }
    s_budget_spent += device_px;
    if (s_budget_spent > s_budget_peak) {
        s_budget_peak = s_budget_spent;
    }
    return true;
}

uint32_t ui_pixel_fx_budget_peak(void)
{
    uint32_t peak = s_budget_peak;
    s_budget_peak = 0;
    return peak;
}

static uint32_t ui_pixel_fx_obj_area(const lv_obj_t *obj)
{
    int32_t w = lv_obj_get_width((lv_obj_t *)obj);
    int32_t h = lv_obj_get_height((lv_obj_t *)obj);
    if (w <= 0 || h <= 0) {
        return 0;
    }
    return (uint32_t)w * (uint32_t)h;
}

static void ui_pixel_fx_run_cycles(void)
{
    for (size_t i = 0; i < UI_FX_MAX_CYCLES; ++i) {
        ui_fx_cycle_t *cycle = &s_cycles[i];
        if (!cycle->used) {
            continue;
        }
        if (cycle->target == NULL) {
            cycle->used = false;
            continue;
        }
        if (!cycle->enabled) {
            continue;
        }
        if (cycle->divider > 1U && (s_tick % cycle->divider) != 0U) {
            continue;
        }

        const uint32_t *ramp = NULL;
        const uint8_t *hold = NULL;
        uint8_t length = 0;
        ui_pixel_fx_ramp_for(cycle->kind, &ramp, &hold, &length);

        if (cycle->hold > 0U) {
            cycle->hold--;
            continue;
        }
        if (!ui_pixel_fx_take_budget(ui_pixel_fx_obj_area(cycle->target))) {
            continue;
        }
        cycle->step = (uint8_t)((cycle->step + 1U) % length);
        cycle->hold = hold[cycle->step];
        lv_obj_set_style_bg_color(cycle->target, lv_color_hex(ramp[cycle->step]),
                                  LV_PART_MAIN);
        lv_obj_set_style_border_color(cycle->target, lv_color_hex(ramp[cycle->step]),
                                      LV_PART_MAIN);
    }
}

static void ui_pixel_fx_run_oneshots(void)
{
    for (size_t i = 0; i < UI_FX_MAX_ONESHOTS; ++i) {
        ui_fx_oneshot_t *shot = &s_oneshots[i];
        if (!shot->used) {
            continue;
        }
        if (shot->image == NULL) {
            shot->used = false;
            continue;
        }
        if (shot->hold > 0U) {
            shot->hold--;
            continue;
        }
        bool flying = shot->steps > 0U;
        if (flying ? (shot->step_x == 0 && shot->step_y == 0)
                   : (shot->frame >= shot->frame_count)) {
            lv_obj_add_flag(shot->image, LV_OBJ_FLAG_HIDDEN);
            shot->used = false;
            continue;
        }
        /* Swapping a frame invalidates both the old and the new extent. */
        if (!ui_pixel_fx_take_budget(2U * ui_pixel_fx_obj_area(shot->image))) {
            continue;
        }
        if (flying) {
            shot->art_x = (int16_t)(shot->art_x + shot->step_x);
            shot->art_y = (int16_t)(shot->art_y + shot->step_y);
            ui_pixel_fx_sprite_move(shot->image, shot->art_x, shot->art_y);
        }
        ui_pixel_fx_sprite_set_src(shot->image,
                                   shot->frames[shot->frame % shot->frame_count]);
        lv_obj_clear_flag(shot->image, LV_OBJ_FLAG_HIDDEN);
        shot->frame++;
        shot->hold = shot->divider > 0U ? (uint8_t)(shot->divider - 1U) : 0U;
        if (flying && --shot->steps == 0U) {
            /* Landed: hide on the next visit so the final frame is actually
             * shown for one tick, and let the caller flash the target. */
            shot->step_x = 0;
            shot->step_y = 0;
            if (shot->on_arrive != NULL) {
                shot->on_arrive(shot->arrive_data);
            }
        }
    }
}

static void ui_pixel_fx_timer_cb(lv_timer_t *timer)
{
    (void)timer;
    if (!s_active) {
        return;
    }
    s_tick++;
    s_budget_spent = 0;

    for (size_t i = 0; i < UI_FX_MAX_EFFECTS; ++i) {
        ui_fx_slot_t *slot = &s_slots[i];
        if (!slot->used || slot->callback == NULL) {
            continue;
        }
        uint8_t divider = slot->divider > 0U ? slot->divider : 1U;
        if ((s_tick % divider) != (slot->phase % divider)) {
            continue;
        }
        if (!slot->callback(s_tick, slot->user_data)) {
            slot->used = false;
        }
    }

    ui_pixel_fx_run_cycles();
    ui_pixel_fx_run_oneshots();

    /* Once every 8 s while Home is visible, so it is usable as a running health
     * check without flooding the log. `peak` is the worst tick in this window
     * rather than all time, because that is what identifies which effect
     * combination is close to the stripe budget. */
    if ((s_tick % 64U) == 0U) {
        uint32_t now_ms = lv_tick_get();
        uint32_t interval_ms = now_ms - s_last_verify_ms;
        bool cadence_ok = interval_ms >= 7000U && interval_ms <= 10000U;
        ESP_LOGW(TAG, "VERIFY: fx tick=%u dirty=%upx peak=%upx budget=%upx denied=%u",
                 (unsigned)s_tick, (unsigned)s_budget_spent,
                 (unsigned)ui_pixel_fx_budget_peak(), (unsigned)UI_FX_TICK_BUDGET_PX,
                 (unsigned)s_budget_denied);
        ESP_LOGW(TAG, "VERIFY:ui:8fps:%s interval_ms=%u tick=%u denied=%u",
                 cadence_ok ? "PASS" : "FAIL", (unsigned)interval_ms,
                 (unsigned)s_tick, (unsigned)s_budget_denied);
        s_last_verify_ms = now_ms;
    }
}

esp_err_t ui_pixel_fx_init(void)
{
    if (s_timer != NULL) {
        return ESP_OK;
    }
    memset(s_slots, 0, sizeof(s_slots));
    memset(s_cycles, 0, sizeof(s_cycles));
    memset(s_oneshots, 0, sizeof(s_oneshots));
    s_timer = lv_timer_create(ui_pixel_fx_timer_cb, UI_FX_TICK_MS, NULL);
    ESP_RETURN_ON_FALSE(s_timer != NULL, ESP_ERR_NO_MEM, TAG,
                        "fx heartbeat alloc failed");
    s_active = true;
    s_last_verify_ms = lv_tick_get();
    ESP_LOGI(TAG, "pixel fx heartbeat started period=%ums", (unsigned)UI_FX_TICK_MS);
    return ESP_OK;
}

esp_err_t ui_pixel_fx_register(ui_fx_tick_cb_t callback, void *user_data,
                               uint8_t divider, uint8_t phase)
{
    ESP_RETURN_ON_FALSE(callback != NULL, ESP_ERR_INVALID_ARG, TAG, "null fx callback");
    for (size_t i = 0; i < UI_FX_MAX_EFFECTS; ++i) {
        if (s_slots[i].used) {
            continue;
        }
        s_slots[i].callback = callback;
        s_slots[i].user_data = user_data;
        s_slots[i].divider = divider > 0U ? divider : 1U;
        s_slots[i].phase = phase;
        s_slots[i].used = true;
        return ESP_OK;
    }
    ESP_LOGE(TAG, "no free fx slot (max=%u)", (unsigned)UI_FX_MAX_EFFECTS);
    return ESP_ERR_NO_MEM;
}

void ui_pixel_fx_unregister(ui_fx_tick_cb_t callback, void *user_data)
{
    for (size_t i = 0; i < UI_FX_MAX_EFFECTS; ++i) {
        if (s_slots[i].used && s_slots[i].callback == callback &&
            s_slots[i].user_data == user_data) {
            s_slots[i].used = false;
        }
    }
}

void ui_pixel_fx_set_active(bool active)
{
    s_active = active;
    if (s_timer == NULL) {
        return;
    }
    if (active) {
        lv_timer_resume(s_timer);
    } else {
        lv_timer_pause(s_timer);
    }
}

bool ui_pixel_fx_active(void)
{
    return s_active;
}

uint32_t ui_pixel_fx_tick(void)
{
    return s_tick;
}

esp_err_t ui_pixel_fx_add_cycle(lv_obj_t *target, ui_fx_cycle_kind_t kind,
                                uint8_t divider)
{
    ESP_RETURN_ON_FALSE(target != NULL, ESP_ERR_INVALID_ARG, TAG, "null cycle target");
    for (size_t i = 0; i < UI_FX_MAX_CYCLES; ++i) {
        if (s_cycles[i].used) {
            continue;
        }
        s_cycles[i].target = target;
        s_cycles[i].kind = kind;
        s_cycles[i].divider = divider > 0U ? divider : 1U;
        s_cycles[i].step = 0;
        s_cycles[i].hold = 0;
        s_cycles[i].used = true;
        s_cycles[i].enabled = false;
        return ESP_OK;
    }
    return ESP_ERR_NO_MEM;
}

void ui_pixel_fx_set_cycle_enabled(lv_obj_t *target, bool enabled, uint32_t off_colour)
{
    for (size_t i = 0; i < UI_FX_MAX_CYCLES; ++i) {
        ui_fx_cycle_t *cycle = &s_cycles[i];
        if (!cycle->used || cycle->target != target) {
            continue;
        }
        if (cycle->enabled == enabled) {
            return;
        }
        cycle->enabled = enabled;
        if (!enabled) {
            lv_obj_set_style_bg_color(target, lv_color_hex(off_colour), LV_PART_MAIN);
            lv_obj_set_style_border_color(target, lv_color_hex(off_colour), LV_PART_MAIN);
        } else {
            /* Restart the ramp so two lamps switched on together do not end up
             * flickering in perfect sync. */
            cycle->step = (uint8_t)(i * 3U);
            cycle->hold = (uint8_t)(i % 3U);
        }
        return;
    }
}

/* Returns the slot already owned by `image`, restarting it rather than stacking a
 * second burst on the same object, or a free slot. */
static ui_fx_oneshot_t *ui_pixel_fx_claim_oneshot(lv_obj_t *image)
{
    ui_fx_oneshot_t *free_slot = NULL;
    for (size_t i = 0; i < UI_FX_MAX_ONESHOTS; ++i) {
        if (s_oneshots[i].used) {
            if (s_oneshots[i].image == image) {
                return &s_oneshots[i];
            }
        } else if (free_slot == NULL) {
            free_slot = &s_oneshots[i];
        }
    }
    return free_slot;
}

esp_err_t ui_pixel_fx_play_once(lv_obj_t *image, const lv_image_dsc_t *const *frames,
                                size_t frame_count, uint8_t divider)
{
    ESP_RETURN_ON_FALSE(image != NULL && frames != NULL && frame_count > 0U,
                        ESP_ERR_INVALID_ARG, TAG, "bad one-shot args");

    ui_fx_oneshot_t *shot = ui_pixel_fx_claim_oneshot(image);
    ESP_RETURN_ON_FALSE(shot != NULL, ESP_ERR_NO_MEM, TAG, "one-shot slots full");

    *shot = (ui_fx_oneshot_t){
        .image = image,
        .frames = frames,
        .frame_count = (uint8_t)frame_count,
        .divider = divider > 0U ? divider : 1U,
        .used = true,
    };
    return ESP_OK;
}

esp_err_t ui_pixel_fx_fly_once(lv_obj_t *image, const lv_image_dsc_t *const *frames,
                               size_t frame_count, int32_t art_x, int32_t art_y,
                               int32_t step_x, int32_t step_y, uint8_t steps,
                               ui_fx_arrive_cb_t on_arrive, void *user_data)
{
    ESP_RETURN_ON_FALSE(image != NULL && frames != NULL && frame_count > 0U && steps > 0U,
                        ESP_ERR_INVALID_ARG, TAG, "bad flight args");
    /* A zero delta would never terminate the flight. */
    ESP_RETURN_ON_FALSE(step_x != 0 || step_y != 0, ESP_ERR_INVALID_ARG, TAG,
                        "flight has no direction");

    ui_fx_oneshot_t *shot = ui_pixel_fx_claim_oneshot(image);
    ESP_RETURN_ON_FALSE(shot != NULL, ESP_ERR_NO_MEM, TAG, "one-shot slots full");

    *shot = (ui_fx_oneshot_t){
        .image = image,
        .frames = frames,
        .frame_count = (uint8_t)frame_count,
        .divider = 1U,
        .used = true,
        .steps = steps,
        .step_x = (int8_t)step_x,
        .step_y = (int8_t)step_y,
        .art_x = (int16_t)art_x,
        .art_y = (int16_t)art_y,
        .on_arrive = on_arrive,
        .arrive_data = user_data,
    };
    ui_pixel_fx_sprite_move(image, art_x, art_y);
    return ESP_OK;
}

lv_obj_t *ui_pixel_fx_sprite(lv_obj_t *parent, const lv_image_dsc_t *src,
                             int32_t art_x, int32_t art_y)
{
    lv_obj_t *image = lv_image_create(parent);
    if (image == NULL) {
        return NULL;
    }
    if (src != NULL) {
        lv_image_set_src(image, src);
    }
    /* Nearest-neighbour upscale. lv_image_set_antialias(false) is what makes
     * lv_draw_sw_transform sample without interpolation, which is the whole
     * reason the art can be authored at 1x and stay in flash.
     *
     * lv_image draws its source-sized image_area anchored at the object origin
     * and then expands it around the pivot (lv_image.c:882). With the default
     * centre pivot a 4x sprite would overflow symmetrically and stop lining up
     * with the art grid, so anchor the pivot at the top-left and size the object
     * to the scaled extent instead. */
    lv_image_set_antialias(image, false);
    lv_image_set_pivot(image, 0, 0);
    lv_image_set_inner_align(image, LV_IMAGE_ALIGN_TOP_LEFT);
    lv_image_set_scale(image, UI_PX_IMAGE_SCALE);
    if (src != NULL) {
        lv_obj_set_size(image, UI_PX(src->header.w), UI_PX(src->header.h));
    }
    lv_obj_set_style_pad_all(image, 0, LV_PART_MAIN);
    lv_obj_clear_flag(image, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    ui_pixel_fx_sprite_move(image, art_x, art_y);
    return image;
}

void ui_pixel_fx_sprite_move(lv_obj_t *sprite, int32_t art_x, int32_t art_y)
{
    if (sprite == NULL) {
        return;
    }
    lv_obj_set_pos(sprite, UI_PX(art_x), UI_PX(art_y));
}

void ui_pixel_fx_sprite_set_src(lv_obj_t *sprite, const lv_image_dsc_t *src)
{
    if (sprite == NULL || src == NULL) {
        return;
    }
    int32_t width = UI_PX(src->header.w);
    int32_t height = UI_PX(src->header.h);
    if (lv_obj_get_width(sprite) != width || lv_obj_get_height(sprite) != height) {
        /* Invalidate the old extent before shrinking, otherwise the uncovered
         * pixels are never repainted. */
        lv_obj_invalidate(sprite);
        lv_obj_set_size(sprite, width, height);
    }
    lv_image_set_src(sprite, src);
}
