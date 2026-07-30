#include "ui_home_rooms.h"

#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "ui_fonts.h"
#include "ui_pixel_art.h"
#include "ui_pixel_fx.h"
#include "ui_pixel_palette.h"

static const char *TAG = "ui_rooms";

#define UI_HOME_WALL_ART_W 2
#define UI_HOME_COOL_WAVE_COUNT 3U

/* Bay origins in art pixels: 2 px of wall, then 56 px of room, repeating. */
static const int32_t s_bay_art_x[3] = {2, 60, 118};

/* All 12 groups from panel_entities.json are covered here. The previous
 * four-room layout dropped 拱门, 客卫, 主卫 and 衣帽间 entirely. */
static const ui_home_room_def_t s_room_defs[UI_HOME_ROOM_COUNT] = {
    {
        .title = "主卧",
        .groups = {"主卧", "主卫", "衣帽间"},
        .bay = 0,
        .level = 0,
        .accent = UI_PAL_ACCENT_VIOLET,
        .art = &room_bedroom,
        .lamp_art_x = 28,
        .lamp_art_y = 7,
        .stand_art_x = 34,
    },
    {
        .title = "书房",
        .groups = {"书房", NULL, NULL},
        .bay = 1,
        .level = 0,
        .accent = UI_PAL_ACCENT_CYAN,
        .art = &room_study,
        .lamp_art_x = 28,
        .lamp_art_y = 7,
        .stand_art_x = 30,
        .glow_art_x = 24,
        .glow_art_y = 19,
        .glow_art_w = 11,
        .glow_art_h = 4,
        .glow_kind = UI_FX_CYCLE_SCREEN,
    },
    {
        .title = "次卧",
        .groups = {"阳台卧", "阳台", "客卫"},
        .bay = 2,
        .level = 0,
        .accent = UI_PAL_COOL_LIGHT,
        .art = &room_guest,
        .lamp_art_x = 12,
        .lamp_art_y = 7,
        .stand_art_x = 26,
        .glow_art_x = 40,
        .glow_art_y = 20,
        .glow_art_w = 6,
        .glow_art_h = 1,
        .glow_kind = UI_FX_CYCLE_WATER,
    },
    {
        .title = "玄关",
        .groups = {"玄关", "拱门", NULL},
        .bay = 0,
        .level = 1,
        .accent = UI_PAL_LAMP_LIGHT,
        .art = &room_entry,
        .lamp_art_x = 30,
        .lamp_art_y = 7,
        .stand_art_x = 24,
    },
    {
        .title = "客厅",
        .groups = {"客厅", NULL, NULL},
        .bay = 1,
        .level = 1,
        .accent = UI_PAL_LAMP_HI,
        .art = &room_living,
        .lamp_art_x = 20,
        .lamp_art_y = 7,
        .stand_art_x = 26,
        .glow_art_x = 39,
        .glow_art_y = 4,
        .glow_art_w = 9,
        .glow_art_h = 6,
        .glow_kind = UI_FX_CYCLE_SCREEN,
    },
    {
        .title = "餐厨",
        .groups = {"餐厅", "厨房", NULL},
        .bay = 2,
        .level = 1,
        .accent = UI_PAL_WOOD_HI,
        .art = &room_kitchen,
        .lamp_art_x = 24,
        .lamp_art_y = 7,
        .stand_art_x = 28,
        .glow_art_x = 7,
        .glow_art_y = 4,
        .glow_art_w = 6,
        .glow_art_h = 2,
        .glow_kind = UI_FX_CYCLE_CANDLE,
    },
};

typedef struct {
    lv_obj_t *container;
    lv_obj_t *art;
    lv_obj_t *light_cone;
    lv_obj_t *lamp;
    lv_obj_t *offline_hatch;
    lv_obj_t *title;
    lv_obj_t *meta;
    lv_obj_t *sparkle;
    lv_obj_t *glow;
    lv_obj_t *cool_waves[UI_HOME_COOL_WAVE_COUNT];
    /* Index into the stepped cone ramp. A linear lv_anim would interpolate
     * between opacities every frame, which at 8 FPS reads as a stutter; three
     * deliberate steps read as a fluorescent tube striking. */
    uint8_t cone_step;
    bool cone_rising;
    bool was_lit;
    bool was_climate_on;
    /* Ticks of accent border left after a rune lands. */
    uint8_t flash_left;
} ui_home_room_view_t;

static ui_home_room_view_t s_views[UI_HOME_ROOM_COUNT];
static ui_home_room_state_t s_states[UI_HOME_ROOM_COUNT];

/* One shared rune: two rooms lighting on the same tick is rare, and a second
 * projectile in flight would read as noise rather than as a cast. */
static lv_obj_t *s_rune;

static const lv_image_dsc_t *const s_sparkle_frames[] = FX_SPARKLE_FRAMES;
static const lv_image_dsc_t *const s_smoke_frames[] = FX_SMOKE_FRAMES;
static const lv_image_dsc_t *const s_cool_wave_frames[] = FX_COOL_WAVE_FRAMES;
static const lv_image_dsc_t *const s_rune_frames[] = FX_RUNE_FRAMES;

#define UI_HOME_RUNE_STEPS 6U
#define UI_HOME_RUNE_FLASH_TICKS 2U

/* Launch point for the rune, in house art pixels: the right wall, which abuts
 * the HUD, so the rune reads as cast from the side panel into the room. */
#define UI_HOME_RUNE_ART_X (UI_HOME_HOUSE_ART_W - 4)
#define UI_HOME_RUNE_ART_Y 2

/* Three frames up, two down: a lamp reaches full brightness slightly slower than
 * it goes out, which is how real filaments and tubes behave. */
static const lv_opa_t s_cone_ramp_up[] = {LV_OPA_30, LV_OPA_70, LV_OPA_COVER};
static const lv_opa_t s_cone_ramp_down[] = {LV_OPA_50, LV_OPA_TRANSP};

static bool ui_home_rooms_cone_tick(uint32_t tick, void *user_data)
{
    (void)tick;
    (void)user_data;
    for (size_t i = 0; i < UI_HOME_ROOM_COUNT; ++i) {
        ui_home_room_view_t *view = &s_views[i];
        if (view->container != NULL && view->flash_left > 0U && --view->flash_left == 0U) {
            lv_obj_set_style_outline_opa(view->container, LV_OPA_TRANSP, LV_PART_MAIN);
        }
        if (view->light_cone == NULL) {
            continue;
        }
        const lv_opa_t *ramp = view->cone_rising ? s_cone_ramp_up : s_cone_ramp_down;
        size_t length = view->cone_rising ? sizeof(s_cone_ramp_up) / sizeof(s_cone_ramp_up[0])
                                         : sizeof(s_cone_ramp_down) / sizeof(s_cone_ramp_down[0]);
        if (view->cone_step >= length) {
            continue;
        }
        lv_obj_set_style_opa(view->light_cone, ramp[view->cone_step], LV_PART_MAIN);
        view->cone_step++;
    }
    return true;
}

static void ui_home_rooms_rune_landed(void *user_data)
{
    ui_home_room_view_t *view = user_data;
    if (view == NULL || view->container == NULL) {
        return;
    }
    view->flash_left = UI_HOME_RUNE_FLASH_TICKS;
    lv_obj_set_style_outline_opa(view->container, LV_OPA_COVER, LV_PART_MAIN);
}

/* Casts the rune from the HUD side of the house at the room's lamp. Whole art
 * pixel steps only, so the path is divided evenly and any remainder is absorbed
 * by landing a pixel or two short of the lamp - close enough to read as a hit. */
static void ui_home_rooms_cast_rune(size_t index)
{
    if (s_rune == NULL || index >= UI_HOME_ROOM_COUNT) {
        return;
    }
    const ui_home_room_def_t *def = &s_room_defs[index];
    int32_t origin_x = 0;
    int32_t origin_y = 0;
    ui_home_room_origin(index, &origin_x, &origin_y);

    int32_t step_x = (origin_x + def->lamp_art_x - UI_HOME_RUNE_ART_X)
                     / (int32_t)UI_HOME_RUNE_STEPS;
    int32_t step_y = (origin_y + def->lamp_art_y - UI_HOME_RUNE_ART_Y)
                     / (int32_t)UI_HOME_RUNE_STEPS;
    if (step_x == 0 && step_y == 0) {
        return;
    }
    ui_pixel_fx_fly_once(s_rune, s_rune_frames, FX_RUNE_FRAME_COUNT, UI_HOME_RUNE_ART_X,
                         UI_HOME_RUNE_ART_Y, step_x, step_y, UI_HOME_RUNE_STEPS,
                         ui_home_rooms_rune_landed, &s_views[index]);
}

const ui_home_room_def_t *ui_home_room_def(size_t index)
{
    return index < UI_HOME_ROOM_COUNT ? &s_room_defs[index] : NULL;
}

void ui_home_room_origin(size_t index, int32_t *out_art_x, int32_t *out_art_y)
{
    if (index >= UI_HOME_ROOM_COUNT) {
        return;
    }
    const ui_home_room_def_t *def = &s_room_defs[index];
    if (out_art_x != NULL) {
        *out_art_x = s_bay_art_x[def->bay];
    }
    if (out_art_y != NULL) {
        *out_art_y = def->level == 0 ? UI_HOME_UPPER_ART_Y : UI_HOME_LOWER_ART_Y;
    }
}

static lv_obj_t *ui_home_rooms_block(lv_obj_t *parent, int32_t art_x, int32_t art_y,
                                     int32_t art_w, int32_t art_h, uint32_t colour)
{
    lv_obj_t *block = lv_obj_create(parent);
    if (block == NULL) {
        return NULL;
    }
    lv_obj_set_size(block, UI_PX(art_w), UI_PX(art_h));
    lv_obj_set_pos(block, UI_PX(art_x), UI_PX(art_y));
    lv_obj_set_style_bg_color(block, lv_color_hex(colour), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(block, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(block, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(block, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(block, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(block, 0, LV_PART_MAIN);
    lv_obj_clear_flag(block, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    return block;
}

/* Colour a cycled patch reverts to when the room goes dark. Each one is the
 * "off" reading of the thing underneath: a dead screen, cold water, a cold hob. */
static uint32_t ui_home_rooms_glow_off_colour(uint8_t kind)
{
    switch ((ui_fx_cycle_kind_t)kind) {
    case UI_FX_CYCLE_SCREEN:
        return UI_PAL_COOL_DARK;
    case UI_FX_CYCLE_WATER:
        return UI_PAL_COOL_DARK;
    case UI_FX_CYCLE_CANDLE:
    default:
        return UI_PAL_METAL_DARK;
    }
}

/* Exterior blocks are recorded with their daylight colour so the day/night tint
 * can be re-derived from the base rather than compounding on the previous
 * tint. */
#define UI_HOME_SHELL_MAX 24U
static struct {
    lv_obj_t *obj;
    uint32_t base;
} s_shell[UI_HOME_SHELL_MAX];
static size_t s_shell_count;

static lv_obj_t *ui_home_rooms_shell_block(lv_obj_t *parent, int32_t art_x, int32_t art_y,
                                           int32_t art_w, int32_t art_h, uint32_t colour)
{
    lv_obj_t *block = ui_home_rooms_block(parent, art_x, art_y, art_w, art_h, colour);
    if (block != NULL && s_shell_count < UI_HOME_SHELL_MAX) {
        s_shell[s_shell_count].obj = block;
        s_shell[s_shell_count].base = colour;
        s_shell_count++;
    }
    return block;
}

void ui_home_rooms_set_shell_tint(uint32_t colour, lv_opa_t opa)
{
    static uint32_t s_last_colour = 0xFFFFFFFFU;
    static lv_opa_t s_last_opa = 0xFFU;
    if (colour == s_last_colour && opa == s_last_opa) {
        return;
    }
    s_last_colour = colour;
    s_last_opa = opa;
    for (size_t i = 0; i < s_shell_count; ++i) {
        lv_color_t mixed = lv_color_mix(lv_color_hex(colour),
                                        lv_color_hex(s_shell[i].base), opa);
        lv_obj_set_style_bg_color(s_shell[i].obj, mixed, LV_PART_MAIN);
    }
}

static esp_err_t ui_home_rooms_create_shell(lv_obj_t *house)
{
    s_shell_count = 0;

    /* Roof: a stepped silhouette rather than a diagonal, because a 4 px grid
     * cannot express a smooth slope and a stepped one is the honest pixel-art
     * answer. */
    static const struct {
        int32_t x;
        int32_t w;
        int32_t y;
        int32_t h;
    } roof_steps[] = {
        {0, 176, 12, 2},
        {8, 160, 9, 3},
        {24, 128, 6, 3},
        {44, 88, 3, 3},
        {68, 40, 0, 3},
    };
    for (size_t i = 0; i < sizeof(roof_steps) / sizeof(roof_steps[0]); ++i) {
        uint32_t colour = (i % 2U == 0U) ? UI_PAL_SHELL_BASE : UI_PAL_SHELL_LIGHT;
        ESP_RETURN_ON_FALSE(ui_home_rooms_shell_block(house, roof_steps[i].x, roof_steps[i].y,
                                                roof_steps[i].w, roof_steps[i].h,
                                                colour) != NULL,
                            ESP_ERR_NO_MEM, TAG, "roof step alloc failed");
    }

    /* Interior walls and the floor slab between the storeys. */
    static const int32_t wall_x[] = {0, 58, 116, 174};
    for (size_t i = 0; i < sizeof(wall_x) / sizeof(wall_x[0]); ++i) {
        ESP_RETURN_ON_FALSE(ui_home_rooms_shell_block(house, wall_x[i], UI_HOME_ROOF_ART_H,
                                                UI_HOME_WALL_ART_W,
                                                UI_HOME_FOUNDATION_ART_Y - UI_HOME_ROOF_ART_H,
                                                UI_PAL_SHELL_DARK) != NULL,
                            ESP_ERR_NO_MEM, TAG, "wall alloc failed");
    }
    ESP_RETURN_ON_FALSE(ui_home_rooms_block(house, 0, UI_HOME_SLAB_ART_Y, 176, 4,
                                            UI_PAL_WOOD_DARK) != NULL,
                        ESP_ERR_NO_MEM, TAG, "floor slab alloc failed");
    ESP_RETURN_ON_FALSE(ui_home_rooms_shell_block(house, 0, UI_HOME_FOUNDATION_ART_Y, 176, 4,
                                            UI_PAL_SHELL_DARK) != NULL,
                        ESP_ERR_NO_MEM, TAG, "foundation alloc failed");

    /* Stairs against the right wall of the centre bay: the actor's route between
     * storeys, and the only reason a two-level cutaway reads as one house.
     * Interior, so no outdoor tint. */
    for (int32_t step = 0; step < 7; ++step) {
        ESP_RETURN_ON_FALSE(ui_home_rooms_block(house, UI_HOME_STAIR_ART_X + step * 2,
                                                UI_HOME_SLAB_ART_Y - 2 - step * 2,
                                                2, 2 + step * 2,
                                                (step % 2 == 0) ? UI_PAL_WOOD_BASE
                                                                : UI_PAL_WOOD_LIGHT) != NULL,
                            ESP_ERR_NO_MEM, TAG, "stair alloc failed");
    }
    return ESP_OK;
}

static esp_err_t ui_home_rooms_create_one(lv_obj_t *house, size_t index,
                                          lv_event_cb_t room_click_cb)
{
    const ui_home_room_def_t *def = &s_room_defs[index];
    ui_home_room_view_t *view = &s_views[index];
    int32_t origin_x = 0;
    int32_t origin_y = 0;
    ui_home_room_origin(index, &origin_x, &origin_y);

    view->container = lv_obj_create(house);
    ESP_RETURN_ON_FALSE(view->container != NULL, ESP_ERR_NO_MEM, TAG,
                        "room container alloc failed");
    lv_obj_set_size(view->container, UI_PX(UI_HOME_ROOM_ART_W), UI_PX(UI_HOME_ROOM_ART_H));
    lv_obj_set_pos(view->container, UI_PX(origin_x), UI_PX(origin_y));
    /* Press feedback quantised to the art grid: exactly one art pixel down, no
     * tween. A smooth scale would be sub-pixel at this size and read as mush;
     * a single-frame "clunk" reads as pixel art. */
    lv_obj_set_style_translate_y(view->container, UI_PX(1),
                                 LV_PART_MAIN | LV_STATE_PRESSED);
    lv_obj_set_style_bg_color(view->container, lv_color_hex(UI_PAL_PANEL), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(view->container, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(view->container, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(view->container, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(view->container, 0, LV_PART_MAIN);
    /* Rune-landing flash frame, kept transparent until it fires. This uses the
     * outline rather than the border because a border width shrinks the content
     * area, which would shift every child in the room by one art pixel. */
    lv_obj_set_style_outline_width(view->container, UI_PX(1), LV_PART_MAIN);
    lv_obj_set_style_outline_pad(view->container, 0, LV_PART_MAIN);
    lv_obj_set_style_outline_color(view->container, lv_color_hex(UI_PAL_LAMP_HI),
                                   LV_PART_MAIN);
    lv_obj_set_style_outline_opa(view->container, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(view->container, 0, LV_PART_MAIN);
    lv_obj_set_style_clip_corner(view->container, false, LV_PART_MAIN);
    lv_obj_clear_flag(view->container, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(view->container, LV_OBJ_FLAG_CLICKABLE);
    if (room_click_cb != NULL) {
        lv_obj_add_event_cb(view->container, room_click_cb, LV_EVENT_CLICKED,
                            (void *)(uintptr_t)index);
    }

    /* Floor band, so an unlit room still reads as a room. */
    ui_home_rooms_block(view->container, 0, UI_HOME_ROOM_ART_H - 2,
                        UI_HOME_ROOM_ART_W, 2, UI_PAL_WOOD_DARK);

    view->art = ui_pixel_fx_sprite(view->container, def->art, 0, 0);
    ESP_RETURN_ON_FALSE(view->art != NULL, ESP_ERR_NO_MEM, TAG, "room art alloc failed");

    /* The light cone sits above the furniture but below the labels. Its own
     * alpha ramp is baked, so switching it on is a single opacity write. */
    view->light_cone = ui_pixel_fx_sprite(view->container, &fx_light_cone,
                                          def->lamp_art_x - (fx_light_cone.header.w / 2),
                                          def->lamp_art_y + 2);
    ESP_RETURN_ON_FALSE(view->light_cone != NULL, ESP_ERR_NO_MEM, TAG,
                        "light cone alloc failed");
    lv_obj_set_style_opa(view->light_cone, LV_OPA_TRANSP, LV_PART_MAIN);
    /* Past the end of both ramps: the cone is already settled at "off", so the
     * ramp must not run until a real light transition starts it. */
    view->cone_step = UINT8_MAX;

    /* Pendant cord from the ceiling. Hangs the lamp low enough to clear the name
     * plate, which otherwise covers the whole top-left corner. */
    ESP_RETURN_ON_FALSE(ui_home_rooms_block(view->container, def->lamp_art_x, 0, 1,
                                            def->lamp_art_y, UI_PAL_METAL_DARK) != NULL,
                        ESP_ERR_NO_MEM, TAG, "lamp cord alloc failed");

    view->lamp = ui_home_rooms_block(view->container, def->lamp_art_x - 1,
                                     def->lamp_art_y, 3, 2, UI_PAL_METAL_DARK);
    ESP_RETURN_ON_FALSE(view->lamp != NULL, ESP_ERR_NO_MEM, TAG, "lamp alloc failed");
    /* The lamp head itself gets the uneven candle ramp, so a lit room reads as a
     * flame rather than as a blinking LED. */
    ESP_RETURN_ON_ERROR(ui_pixel_fx_add_cycle(view->lamp, UI_FX_CYCLE_CANDLE, 1), TAG,
                        "lamp cycle failed");

    if (def->glow_art_w > 0 && def->glow_art_h > 0) {
        view->glow = ui_home_rooms_block(view->container, def->glow_art_x, def->glow_art_y,
                                         def->glow_art_w, def->glow_art_h,
                                         ui_home_rooms_glow_off_colour(def->glow_kind));
        ESP_RETURN_ON_FALSE(view->glow != NULL, ESP_ERR_NO_MEM, TAG, "glow alloc failed");
        /* Half rate: a screen or a water surface that changes every 125 ms reads
         * as noise, every 250 ms reads as alive. */
        ESP_RETURN_ON_ERROR(ui_pixel_fx_add_cycle(view->glow,
                                                  (ui_fx_cycle_kind_t)def->glow_kind, 2),
                            TAG, "glow cycle failed");
    }

    view->sparkle = ui_pixel_fx_sprite(view->container, &fx_sparkle_0,
                                       def->lamp_art_x - 3, def->lamp_art_y - 2);
    ESP_RETURN_ON_FALSE(view->sparkle != NULL, ESP_ERR_NO_MEM, TAG, "sparkle alloc failed");
    lv_obj_add_flag(view->sparkle, LV_OBJ_FLAG_HIDDEN);

    for (size_t i = 0; i < UI_HOME_COOL_WAVE_COUNT; ++i) {
        view->cool_waves[i] = ui_pixel_fx_sprite(view->container, &fx_cool_wave_0,
                                                 (int32_t)(4 + i * 12),
                                                 UI_HOME_ROOM_ART_H - 5);
        if (view->cool_waves[i] != NULL) {
            lv_obj_add_flag(view->cool_waves[i], LV_OBJ_FLAG_HIDDEN);
        }
    }

    /* Offline hatch: a 25% dither grid rather than a flat scrim, so "no data"
     * still looks like part of the same picture. */
    view->offline_hatch = lv_obj_create(view->container);
    ESP_RETURN_ON_FALSE(view->offline_hatch != NULL, ESP_ERR_NO_MEM, TAG,
                        "offline hatch alloc failed");
    lv_obj_set_size(view->offline_hatch, UI_PX(UI_HOME_ROOM_ART_W),
                    UI_PX(UI_HOME_ROOM_ART_H));
    lv_obj_set_pos(view->offline_hatch, 0, 0);
    lv_obj_set_style_bg_opa(view->offline_hatch, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(view->offline_hatch, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(view->offline_hatch, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(view->offline_hatch, 0, LV_PART_MAIN);
    lv_obj_set_style_bg_image_src(view->offline_hatch, &fx_scanline, LV_PART_MAIN);
    lv_obj_set_style_bg_image_tiled(view->offline_hatch, true, LV_PART_MAIN);
    lv_obj_set_style_bg_image_recolor(view->offline_hatch, lv_color_hex(UI_PAL_MUTED),
                                      LV_PART_MAIN);
    lv_obj_set_style_bg_image_recolor_opa(view->offline_hatch, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_bg_image_opa(view->offline_hatch, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_clear_flag(view->offline_hatch, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    /* Name plate in the top-left corner, on an opaque strip so it stays legible
     * over furniture and over the light cone. */
    lv_obj_t *plate = ui_home_rooms_block(view->container, 0, 0, 26, 6, UI_PAL_SHADOW);
    ESP_RETURN_ON_FALSE(plate != NULL, ESP_ERR_NO_MEM, TAG, "name plate alloc failed");
    lv_obj_set_style_bg_opa(plate, LV_OPA_70, LV_PART_MAIN);

    view->title = lv_label_create(plate);
    ESP_RETURN_ON_FALSE(view->title != NULL, ESP_ERR_NO_MEM, TAG, "room title alloc failed");
    lv_label_set_text(view->title, def->title);
    lv_obj_set_style_text_font(view->title, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(view->title, lv_color_hex(UI_PAL_INK), LV_PART_MAIN);
    lv_obj_align(view->title, LV_ALIGN_LEFT_MID, UI_PX(1), 0);

    /* Counts go top-right, clear of the floor where the actor and the cold-air
     * waves live. */
    view->meta = lv_label_create(view->container);
    ESP_RETURN_ON_FALSE(view->meta != NULL, ESP_ERR_NO_MEM, TAG, "room meta alloc failed");
    lv_label_set_text(view->meta, "--");
    lv_obj_set_style_text_font(view->meta, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(view->meta, lv_color_hex(UI_PAL_MUTED), LV_PART_MAIN);
    lv_obj_align(view->meta, LV_ALIGN_TOP_RIGHT, -UI_PX(1), UI_PX(1));

    return ESP_OK;
}

esp_err_t ui_home_rooms_create(lv_obj_t *house, lv_event_cb_t room_click_cb)
{
    ESP_RETURN_ON_FALSE(house != NULL, ESP_ERR_INVALID_ARG, TAG, "null house");
    memset(s_views, 0, sizeof(s_views));
    memset(s_states, 0, sizeof(s_states));

    for (size_t i = 0; i < UI_HOME_ROOM_COUNT; ++i) {
        ESP_RETURN_ON_ERROR(ui_home_rooms_create_one(house, i, room_click_cb), TAG,
                            "room %u create failed", (unsigned)i);
    }
    /* Shell last so walls and the slab draw over the room edges. */
    ESP_RETURN_ON_ERROR(ui_home_rooms_create_shell(house), TAG, "house shell failed");

    /* Created after the shell so the rune flies over the walls it crosses. */
    s_rune = ui_pixel_fx_sprite(house, &fx_rune_0, UI_HOME_RUNE_ART_X, UI_HOME_RUNE_ART_Y);
    ESP_RETURN_ON_FALSE(s_rune != NULL, ESP_ERR_NO_MEM, TAG, "rune alloc failed");
    lv_obj_add_flag(s_rune, LV_OBJ_FLAG_HIDDEN);

    ESP_RETURN_ON_ERROR(ui_pixel_fx_register(ui_home_rooms_cone_tick, NULL, 1, 0), TAG,
                        "cone ramp registration failed");
    return ESP_OK;
}

void ui_home_rooms_reset_aggregates(void)
{
    memset(s_states, 0, sizeof(s_states));
}

static bool ui_home_room_matches(size_t index, const char *group)
{
    if (group == NULL || group[0] == '\0') {
        return false;
    }
    const ui_home_room_def_t *def = &s_room_defs[index];
    for (size_t i = 0; i < UI_HOME_ROOM_MAX_GROUPS; ++i) {
        if (def->groups[i] != NULL && strcmp(def->groups[i], group) == 0) {
            return true;
        }
    }
    return false;
}

static bool ui_home_sensor_is_on(const panel_sensor_t *sensor)
{
    return sensor->available && (strcmp(sensor->value_text, "on") == 0 ||
                                 strcmp(sensor->value_text, "ON") == 0);
}

static bool ui_home_climate_is_on(const panel_sensor_t *sensor)
{
    return sensor->available && strcmp(sensor->value_text, "off") != 0;
}

void ui_home_rooms_collect(const panel_sensor_t *sensor, ui_home_summary_t *summary)
{
    if (sensor == NULL) {
        return;
    }
    if (summary != NULL) {
        summary->entities++;
        summary->online += sensor->available ? 1U : 0U;
        if (sensor->kind == PANEL_SENSOR_KIND_BINARY) {
            summary->lights_total++;
            if (ui_home_sensor_is_on(sensor)) {
                summary->lights_on++;
            }
        }
        if (sensor->kind == PANEL_SENSOR_KIND_CLIMATE && ui_home_climate_is_on(sensor)) {
            summary->climates_on++;
        }
    }

    for (size_t i = 0; i < UI_HOME_ROOM_COUNT; ++i) {
        if (!ui_home_room_matches(i, sensor->group)) {
            continue;
        }
        ui_home_room_state_t *state = &s_states[i];
        if (!sensor->available) {
            state->offline_count++;
        }
        if (sensor->kind == PANEL_SENSOR_KIND_BINARY) {
            state->light_total++;
            state->light_online += sensor->available ? 1U : 0U;
            state->light_on += ui_home_sensor_is_on(sensor) ? 1U : 0U;
        } else if (sensor->kind == PANEL_SENSOR_KIND_CLIMATE) {
            state->climate_total++;
            if (ui_home_climate_is_on(sensor)) {
                state->climate_on++;
            }
            if (sensor->available && sensor->has_current_temperature) {
                double temperature = sensor->current_temperature;
                if (strcmp(sensor->unit, "F") == 0) {
                    temperature = (temperature - 32.0) * (5.0 / 9.0);
                }
                state->temperature_sum += temperature;
                state->temperature_count++;
            }
        }
    }
}

const ui_home_room_state_t *ui_home_room_state(size_t index)
{
    return index < UI_HOME_ROOM_COUNT ? &s_states[index] : NULL;
}

bool ui_home_room_is_lit(size_t index)
{
    return index < UI_HOME_ROOM_COUNT && s_states[index].light_on > 0U;
}

bool ui_home_room_has_climate_on(size_t index)
{
    return index < UI_HOME_ROOM_COUNT && s_states[index].climate_on > 0U;
}

bool ui_home_room_has_data(size_t index)
{
    if (index >= UI_HOME_ROOM_COUNT) {
        return false;
    }
    return s_states[index].light_online > 0U || s_states[index].temperature_count > 0U;
}

lv_obj_t *ui_home_room_container(size_t index)
{
    return index < UI_HOME_ROOM_COUNT ? s_views[index].container : NULL;
}

lv_obj_t *ui_home_room_light_cone(size_t index)
{
    return index < UI_HOME_ROOM_COUNT ? s_views[index].light_cone : NULL;
}

static ui_home_ambient_t s_ambient = {
    .unlit_art_opa = LV_OPA_40,
    .unlit_wall_colour = UI_PAL_PANEL,
};

void ui_home_rooms_set_ambient(const ui_home_ambient_t *ambient)
{
    if (ambient != NULL) {
        s_ambient = *ambient;
    }
}

void ui_home_rooms_apply(size_t index)
{
    if (index >= UI_HOME_ROOM_COUNT || s_views[index].container == NULL) {
        return;
    }
    const ui_home_room_def_t *def = &s_room_defs[index];
    ui_home_room_view_t *view = &s_views[index];
    const ui_home_room_state_t *state = &s_states[index];
    bool lit = state->light_on > 0U;
    bool climate = state->climate_on > 0U;
    bool has_data = ui_home_room_has_data(index);

    lv_obj_set_style_opa(view->art, lit ? LV_OPA_COVER : s_ambient.unlit_art_opa,
                         LV_PART_MAIN);
    /* A lit room's walls pick up the lamp's colour temperature. Without this the
     * only difference between lit and unlit is the furniture opacity, and the
     * room still reads as cold. */
    lv_obj_set_style_bg_color(view->container,
                              lit ? lv_color_mix(lv_color_hex(UI_PAL_LAMP_DARK),
                                                 lv_color_hex(UI_PAL_PANEL_ALT), LV_OPA_30)
                                  : lv_color_hex(s_ambient.unlit_wall_colour),
                              LV_PART_MAIN);

    ui_pixel_fx_set_cycle_enabled(view->lamp, lit, UI_PAL_METAL_DARK);
    if (view->glow != NULL) {
        ui_pixel_fx_set_cycle_enabled(view->glow, lit,
                                      ui_home_rooms_glow_off_colour(def->glow_kind));
    }

    /* One-shot juice on the transition only, never on every refresh. */
    if (lit != view->was_lit) {
        view->cone_rising = lit;
        view->cone_step = 0;
        ui_pixel_fx_sprite_move(view->sparkle, def->lamp_art_x - 3, def->lamp_art_y - 2);
        if (lit) {
            ui_pixel_fx_play_once(view->sparkle, s_sparkle_frames,
                                  FX_SPARKLE_FRAME_COUNT, 1);
            ui_home_rooms_cast_rune(index);
        } else {
            ui_pixel_fx_play_once(view->sparkle, s_smoke_frames,
                                  FX_SMOKE_FRAME_COUNT, 2);
        }
        view->was_lit = lit;
    }

    if (climate != view->was_climate_on) {
        for (size_t i = 0; i < UI_HOME_COOL_WAVE_COUNT; ++i) {
            if (view->cool_waves[i] == NULL) {
                continue;
            }
            if (climate) {
                /* Stagger the waves so they crawl across the floor rather than
                 * pulsing together. */
                ui_pixel_fx_play_once(view->cool_waves[i], s_cool_wave_frames,
                                      FX_COOL_WAVE_FRAME_COUNT, (uint8_t)(2 + i));
            } else {
                lv_obj_add_flag(view->cool_waves[i], LV_OBJ_FLAG_HIDDEN);
            }
        }
        view->was_climate_on = climate;
    }

    lv_obj_set_style_bg_image_opa(view->offline_hatch,
                                  (!has_data || state->offline_count > 0U) ? LV_OPA_60
                                                                          : LV_OPA_TRANSP,
                                  LV_PART_MAIN);

    lv_obj_set_style_text_color(view->title,
                                lv_color_hex(lit || climate ? def->accent : UI_PAL_MUTED),
                                LV_PART_MAIN);

    char meta[48];
    if (!has_data) {
        snprintf(meta, sizeof(meta), "?");
    } else if (state->temperature_count > 0U) {
        snprintf(meta, sizeof(meta), "%u/%u %.0fC",
                 (unsigned)state->light_on, (unsigned)state->light_total,
                 state->temperature_sum / (double)state->temperature_count);
    } else {
        snprintf(meta, sizeof(meta), "%u/%u",
                 (unsigned)state->light_on, (unsigned)state->light_total);
    }
    lv_label_set_text(view->meta, meta);
    lv_obj_set_style_text_color(view->meta,
                                lv_color_hex(lit ? UI_PAL_LAMP_HI : UI_PAL_MUTED),
                                LV_PART_MAIN);
}
