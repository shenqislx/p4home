#include "ui_home_actor.h"

#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "ui_fonts.h"
#include "ui_home_rooms.h"
#include "ui_pixel_art.h"
#include "ui_pixel_fx.h"
#include "ui_pixel_palette.h"

static const char *TAG = "ui_actor";

#define UI_ACTOR_ART_W 8
#define UI_ACTOR_ART_H 13
#define UI_ACTOR_PET_ART_W 10
#define UI_ACTOR_DIALOG_PAGE_MAX 96U
#define UI_ACTOR_DIALOG_TEXT_MAX (WORLD_SERVICE_SAY_TEXT_MAX_BYTES + 1U)
#define UI_ACTOR_DIALOG_PAGE_HOLD_TICKS 24U
#define UI_ACTOR_PET_LAG 2U

/* Floor lines the actor stands on, in house art pixels. */
#define UI_ACTOR_UPPER_FLOOR_Y (UI_HOME_UPPER_ART_Y + UI_HOME_ROOM_ART_H - UI_ACTOR_ART_H - 2)
#define UI_ACTOR_LOWER_FLOOR_Y (UI_HOME_LOWER_ART_Y + UI_HOME_ROOM_ART_H - UI_ACTOR_ART_H - 2)
#define UI_ACTOR_STAIR_X (UI_HOME_STAIR_ART_X + 2)

typedef struct {
    int16_t x;
    int16_t y;
} ui_actor_point_t;

typedef enum {
    UI_ACTOR_RENDER_IDLE = 0,
    UI_ACTOR_RENDER_WALK,
    UI_ACTOR_RENDER_SLEEP,
    UI_ACTOR_RENDER_DOZE,
} ui_actor_render_state_t;

static lv_obj_t *s_actor;
static lv_obj_t *s_actor_shadow;
static lv_obj_t *s_pet;
static lv_obj_t *s_dialog_panel;
static lv_obj_t *s_dialog_label;
static lv_obj_t *s_dialog_cursor;

static ui_actor_render_state_t s_state = UI_ACTOR_RENDER_IDLE;
static world_activity_t s_desired_activity = WORLD_ACTIVITY_IDLE;
static world_speech_tone_t s_desired_tone = WORLD_SPEECH_TONE_DEFAULT;
static size_t s_room = WORLD_ROOM_LIVING_ROOM;
static ui_actor_point_t s_pos;
static ui_actor_point_t s_target;
/* Two-leg route so crossing storeys goes via the stairs instead of through the
 * floor slab. */
static ui_actor_point_t s_waypoint;
static bool s_has_waypoint;

static uint8_t s_walk_frame;
static uint8_t s_idle_frame;
static uint16_t s_blink_countdown = 60U;
static bool s_blinking;

static ui_actor_point_t s_pet_trail[UI_ACTOR_PET_LAG + 1U];
static uint8_t s_pet_trail_head;
static uint8_t s_pet_frame;

static char s_dialog_full[UI_ACTOR_DIALOG_TEXT_MAX];
static size_t s_dialog_length;
static size_t s_dialog_page_start;
static size_t s_dialog_page_end;
static size_t s_dialog_revealed;
static uint16_t s_dialog_page_hold;
static bool s_cursor_visible;
static uint32_t s_speech_revision;

static const lv_image_dsc_t *const s_idle_frames[] = ACTOR_IDLE_FRAMES;
static const lv_image_dsc_t *const s_walk_frames[] = ACTOR_WALK_FRAMES;
static const lv_image_dsc_t *const s_sleep_frames[] = ACTOR_SLEEP_FRAMES;
static const lv_image_dsc_t *const s_pet_frames[] = PET_IDLE_FRAMES;

static void ui_home_actor_set_render_state(ui_actor_render_state_t state);
static void ui_home_actor_say(const char *text, uint32_t accent);

static bool ui_home_actor_room_index(world_room_id_t room, size_t *room_index)
{
    static const world_room_id_t world_rooms[UI_HOME_ROOM_COUNT] = {
        WORLD_ROOM_PRIMARY_BEDROOM,
        WORLD_ROOM_STUDY,
        WORLD_ROOM_GUEST_ROOM,
        WORLD_ROOM_ENTRY,
        WORLD_ROOM_LIVING_ROOM,
        WORLD_ROOM_KITCHEN,
    };
    for (size_t index = 0U; index < UI_HOME_ROOM_COUNT; ++index) {
        if (world_rooms[index] == room) {
            *room_index = index;
            return true;
        }
    }
    return false;
}

static size_t ui_home_actor_dialog_page_end(size_t start)
{
    if (start >= s_dialog_length) {
        return s_dialog_length;
    }
    size_t end = start + UI_ACTOR_DIALOG_PAGE_MAX - 1U;
    if (end >= s_dialog_length) {
        return s_dialog_length;
    }
    while (end > start && ((unsigned char)s_dialog_full[end] & 0xC0U) == 0x80U) {
        end--;
    }
    return end;
}

static ui_actor_render_state_t ui_home_actor_desired_rest_state(world_speech_tone_t tone)
{
    if (s_desired_activity != WORLD_ACTIVITY_SLEEP) {
        return UI_ACTOR_RENDER_IDLE;
    }
    return tone == WORLD_SPEECH_TONE_MUTED ? UI_ACTOR_RENDER_DOZE
                                           : UI_ACTOR_RENDER_SLEEP;
}

static int16_t ui_home_actor_room_stand_x(size_t room_index)
{
    const ui_home_room_def_t *def = ui_home_room_def(room_index);
    int32_t origin_x = 0;
    ui_home_room_origin(room_index, &origin_x, NULL);
    return (int16_t)(origin_x + (def != NULL ? def->stand_art_x : 24));
}

static int16_t ui_home_actor_room_floor_y(size_t room_index)
{
    const ui_home_room_def_t *def = ui_home_room_def(room_index);
    bool upper = def != NULL && def->level == 0;
    return (int16_t)(upper ? UI_ACTOR_UPPER_FLOOR_Y : UI_ACTOR_LOWER_FLOOR_Y);
}

/* s_pos is the top-left of a standing actor, so the floor line is always
 * s_pos.y + UI_ACTOR_ART_H. The lying-down pose is only 8 art px tall, so
 * placing it at s_pos would leave it floating; anchor every pose to that floor
 * line instead of to the top-left. */
static void ui_home_actor_place(void)
{
    if (s_actor == NULL) {
        return;
    }
    int32_t art_h = lv_obj_get_height(s_actor) / UI_PX_SCALE;
    if (art_h <= 0) {
        art_h = UI_ACTOR_ART_H;
    }
    int16_t draw_y = (int16_t)(s_pos.y + UI_ACTOR_ART_H - art_h);
    ui_pixel_fx_sprite_move(s_actor, s_pos.x, draw_y);
    if (s_actor_shadow != NULL) {
        int32_t art_w = lv_obj_get_width(s_actor) / UI_PX_SCALE;
        lv_obj_set_size(s_actor_shadow, UI_PX(art_w > 0 ? art_w : UI_ACTOR_ART_W), UI_PX(1));
        lv_obj_set_pos(s_actor_shadow, UI_PX(s_pos.x), UI_PX(s_pos.y + UI_ACTOR_ART_H));
    }
}

/* Every pose change has to re-anchor, because the poses differ in height. */
static void ui_home_actor_set_pose(const lv_image_dsc_t *src)
{
    if (s_actor == NULL || src == NULL) {
        return;
    }
    ui_pixel_fx_sprite_set_src(s_actor, src);
    ui_home_actor_place();
}

static void ui_home_actor_advance_pet(void)
{
    if (s_pet == NULL) {
        return;
    }
    /* The companion follows a delayed copy of the actor's path, which is enough
     * to look like it is trailing rather than glued on. */
    s_pet_trail[s_pet_trail_head] = s_pos;
    s_pet_trail_head = (uint8_t)((s_pet_trail_head + 1U) % (UI_ACTOR_PET_LAG + 1U));
    ui_actor_point_t behind = s_pet_trail[s_pet_trail_head];
    int16_t offset = (behind.x <= s_pos.x) ? -(int16_t)(UI_ACTOR_PET_ART_W + 2)
                                          : (int16_t)(UI_ACTOR_ART_W + 2);
    ui_pixel_fx_sprite_move(s_pet, (int16_t)(behind.x + offset),
                            (int16_t)(behind.y + UI_ACTOR_ART_H - 6));
}

static bool ui_home_actor_tick(uint32_t tick, void *user_data)
{
    (void)user_data;
    if (s_actor == NULL) {
        return true;
    }

    switch (s_state) {
    case UI_ACTOR_RENDER_WALK: {
        ui_actor_point_t goal = s_has_waypoint ? s_waypoint : s_target;
        /* One art pixel per tick, so the walk cycle and the travel distance stay
         * in lockstep and never look like sliding. */
        if (s_pos.x != goal.x) {
            s_pos.x = (int16_t)(s_pos.x + (goal.x > s_pos.x ? 1 : -1));
        } else if (s_pos.y != goal.y) {
            s_pos.y = (int16_t)(s_pos.y + (goal.y > s_pos.y ? 1 : -1));
        } else if (s_has_waypoint) {
            s_has_waypoint = false;
        } else {
            ui_home_actor_set_render_state(
                ui_home_actor_desired_rest_state(s_desired_tone));
            s_walk_frame = 0;
            break;
        }
        s_walk_frame = (uint8_t)((s_walk_frame + 1U) % ACTOR_WALK_FRAME_COUNT);
        ui_home_actor_set_pose(s_walk_frames[s_walk_frame]);
        ui_home_actor_place();
        break;
    }
    case UI_ACTOR_RENDER_SLEEP:
    case UI_ACTOR_RENDER_DOZE:
        if ((tick % 8U) == 0U) {
            s_idle_frame = (uint8_t)((s_idle_frame + 1U) % ACTOR_SLEEP_FRAME_COUNT);
            ui_home_actor_set_pose(s_sleep_frames[s_idle_frame]);
        }
        break;
    case UI_ACTOR_RENDER_IDLE:
    default:
        if (s_blinking) {
            s_blinking = false;
            ui_home_actor_set_pose(s_idle_frames[s_idle_frame]);
        } else if (s_blink_countdown > 0U) {
            s_blink_countdown--;
        } else {
            /* Irregular blink interval; a fixed one reads as a machine. */
            s_blink_countdown = (uint16_t)(40U + (tick * 37U) % 60U);
            s_blinking = true;
            ui_home_actor_set_pose(&actor_blink);
        }
        if (!s_blinking && (tick % 8U) == 0U) {
            s_idle_frame = (uint8_t)((s_idle_frame + 1U) % ACTOR_IDLE_FRAME_COUNT);
            ui_home_actor_set_pose(s_idle_frames[s_idle_frame]);
        }
        break;
    }

    if ((tick % 2U) == 0U) {
        ui_home_actor_advance_pet();
    }
    if ((tick % 4U) == 0U && s_pet != NULL) {
        s_pet_frame = (uint8_t)((s_pet_frame + 1U) % PET_IDLE_FRAME_COUNT);
        ui_pixel_fx_sprite_set_src(s_pet, s_pet_frames[s_pet_frame]);
    }

    /* Typewriter reveal: two characters per tick. Long v1 say payloads are
     * paged through the fixed-size HUD without truncating UTF-8 code points. */
    if (s_dialog_label != NULL && s_dialog_revealed < s_dialog_page_end) {
        for (int step = 0; step < 2 && s_dialog_revealed < s_dialog_page_end; ++step) {
            s_dialog_revealed++;
            while (s_dialog_revealed < s_dialog_page_end &&
                   ((unsigned char)s_dialog_full[s_dialog_revealed] & 0xC0U) == 0x80U) {
                s_dialog_revealed++;
            }
        }
        char partial[UI_ACTOR_DIALOG_PAGE_MAX];
        size_t copy = s_dialog_revealed - s_dialog_page_start;
        memcpy(partial, &s_dialog_full[s_dialog_page_start], copy);
        partial[copy] = '\0';
        lv_label_set_text(s_dialog_label, partial);
    } else if (s_dialog_label != NULL && s_dialog_page_end < s_dialog_length) {
        if (++s_dialog_page_hold >= UI_ACTOR_DIALOG_PAGE_HOLD_TICKS) {
            s_dialog_page_start = s_dialog_page_end;
            s_dialog_page_end = ui_home_actor_dialog_page_end(s_dialog_page_start);
            s_dialog_revealed = s_dialog_page_start;
            s_dialog_page_hold = 0U;
            s_cursor_visible = false;
            if (s_dialog_cursor != NULL) {
                lv_obj_set_style_opa(s_dialog_cursor, LV_OPA_TRANSP, LV_PART_MAIN);
            }
            lv_label_set_text(s_dialog_label, "");
        }
    } else if (s_dialog_cursor != NULL && (tick % 4U) == 0U) {
        s_cursor_visible = !s_cursor_visible;
        lv_obj_set_style_opa(s_dialog_cursor,
                             s_cursor_visible ? LV_OPA_COVER : LV_OPA_TRANSP,
                             LV_PART_MAIN);
    }
    return true;
}

esp_err_t ui_home_actor_create(lv_obj_t *house)
{
    ESP_RETURN_ON_FALSE(house != NULL, ESP_ERR_INVALID_ARG, TAG, "null house");

    world_service_snapshot_t snapshot = {0};
    world_service_get_snapshot(&snapshot);
    size_t snapshot_room = 0U;
    if (ui_home_actor_room_index(snapshot.room, &snapshot_room)) {
        s_room = snapshot_room;
        s_desired_activity = snapshot.activity;
        s_desired_tone = snapshot.speech_tone;
    }

    s_pos.x = ui_home_actor_room_stand_x(s_room);
    s_pos.y = ui_home_actor_room_floor_y(s_room);
    s_target = s_pos;
    for (size_t i = 0; i <= UI_ACTOR_PET_LAG; ++i) {
        s_pet_trail[i] = s_pos;
    }

    /* A hard-edged shadow, not a soft one: soft shadows fight the pixel grid. */
    s_actor_shadow = lv_obj_create(house);
    ESP_RETURN_ON_FALSE(s_actor_shadow != NULL, ESP_ERR_NO_MEM, TAG, "shadow alloc failed");
    lv_obj_set_size(s_actor_shadow, UI_PX(UI_ACTOR_ART_W), UI_PX(1));
    lv_obj_set_style_bg_color(s_actor_shadow, lv_color_hex(UI_PAL_SHADOW), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_actor_shadow, LV_OPA_50, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_actor_shadow, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(s_actor_shadow, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_actor_shadow, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    /* Created after the rooms and the shell so it draws over the furniture. */
    s_actor = ui_pixel_fx_sprite(house, &actor_idle_0, s_pos.x, s_pos.y);
    ESP_RETURN_ON_FALSE(s_actor != NULL, ESP_ERR_NO_MEM, TAG, "actor alloc failed");

    s_pet = ui_pixel_fx_sprite(house, &pet_idle_0, s_pos.x - UI_ACTOR_PET_ART_W - 2,
                               s_pos.y + UI_ACTOR_ART_H - 6);
    ESP_RETURN_ON_FALSE(s_pet != NULL, ESP_ERR_NO_MEM, TAG, "pet alloc failed");

    ui_home_actor_place();
    ui_home_actor_set_render_state(
        ui_home_actor_desired_rest_state(snapshot.speech_tone));
    ESP_RETURN_ON_ERROR(ui_pixel_fx_register(ui_home_actor_tick, NULL, 1, 0), TAG,
                        "actor tick registration failed");
    return ESP_OK;
}

static void ui_home_actor_go_to_room(size_t room_index)
{
    const ui_home_room_def_t *def = ui_home_room_def(room_index);
    if (def == NULL || s_actor == NULL) {
        return;
    }
    if (room_index == s_room) {
        return;
    }

    s_room = room_index;
    s_target.x = ui_home_actor_room_stand_x(room_index);
    s_target.y = ui_home_actor_room_floor_y(room_index);

    /* Crossing storeys routes through the stair run so the actor never walks
     * through the floor slab. */
    if (s_target.y != s_pos.y) {
        s_waypoint.x = UI_ACTOR_STAIR_X;
        s_waypoint.y = s_target.y;
        s_has_waypoint = true;
    } else {
        s_has_waypoint = false;
    }
    s_state = UI_ACTOR_RENDER_WALK;
    ui_home_actor_set_pose(s_walk_frames[0]);
    ESP_LOGI(TAG, "actor heading to %s", def->title);
}

static void ui_home_actor_set_render_state(ui_actor_render_state_t state)
{
    if (s_actor == NULL || s_state == state) {
        return;
    }
    s_state = state;
    s_idle_frame = 0;
    switch (state) {
    case UI_ACTOR_RENDER_SLEEP:
    case UI_ACTOR_RENDER_DOZE:
        ui_home_actor_set_pose(s_sleep_frames[0]);
        break;
    case UI_ACTOR_RENDER_WALK:
        ui_home_actor_set_pose(s_walk_frames[0]);
        break;
    case UI_ACTOR_RENDER_IDLE:
    default:
        ui_home_actor_set_pose(s_idle_frames[0]);
        break;
    }
}

void ui_home_actor_apply_snapshot(const world_service_snapshot_t *snapshot)
{
    size_t room_index = 0U;
    if (snapshot == NULL || s_actor == NULL ||
        !ui_home_actor_room_index(snapshot->room, &room_index)) {
        return;
    }
    s_desired_activity = snapshot->activity;
    s_desired_tone = snapshot->speech_tone;
    if (room_index != s_room) {
        ui_home_actor_go_to_room(room_index);
    } else if (s_state != UI_ACTOR_RENDER_WALK) {
        ui_home_actor_set_render_state(
            ui_home_actor_desired_rest_state(snapshot->speech_tone));
    }
    if (snapshot->speech_revision != 0U && snapshot->speech_revision != s_speech_revision) {
        uint32_t accent = UI_PAL_ACCENT_CYAN;
        switch (snapshot->speech_tone) {
        case WORLD_SPEECH_TONE_MUTED:
            accent = UI_PAL_MUTED;
            break;
        case WORLD_SPEECH_TONE_SLEEP:
            accent = UI_PAL_ACCENT_VIOLET;
            break;
        case WORLD_SPEECH_TONE_COOL:
            accent = UI_PAL_COOL_LIGHT;
            break;
        case WORLD_SPEECH_TONE_BRIGHT:
            accent = UI_PAL_LAMP_HI;
            break;
        case WORLD_SPEECH_TONE_DEFAULT:
        default:
            break;
        }
        ui_home_actor_say(snapshot->speech_text, accent);
        s_speech_revision = snapshot->speech_revision;
    }
}

esp_err_t ui_home_actor_create_dialog(lv_obj_t *parent, int32_t art_w, int32_t art_h)
{
    ESP_RETURN_ON_FALSE(parent != NULL, ESP_ERR_INVALID_ARG, TAG, "null dialog parent");

    s_dialog_panel = lv_obj_create(parent);
    ESP_RETURN_ON_FALSE(s_dialog_panel != NULL, ESP_ERR_NO_MEM, TAG, "dialog alloc failed");
    lv_obj_set_size(s_dialog_panel, UI_PX(art_w), UI_PX(art_h));
    lv_obj_set_style_bg_color(s_dialog_panel, lv_color_hex(UI_PAL_PANEL), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_dialog_panel, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_dialog_panel, UI_PX(1), LV_PART_MAIN);
    lv_obj_set_style_border_color(s_dialog_panel, lv_color_hex(UI_PAL_ACCENT_CYAN),
                                  LV_PART_MAIN);
    lv_obj_set_style_radius(s_dialog_panel, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_dialog_panel, UI_PX(2), LV_PART_MAIN);
    lv_obj_clear_flag(s_dialog_panel, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    s_dialog_label = lv_label_create(s_dialog_panel);
    ESP_RETURN_ON_FALSE(s_dialog_label != NULL, ESP_ERR_NO_MEM, TAG,
                        "dialog label alloc failed");
    lv_label_set_long_mode(s_dialog_label, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_width(s_dialog_label, UI_PX(art_w) - UI_PX(6));
    lv_obj_set_style_text_font(s_dialog_label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_dialog_label, lv_color_hex(UI_PAL_INK), LV_PART_MAIN);
    lv_label_set_text(s_dialog_label, "");
    lv_obj_set_pos(s_dialog_label, 0, 0);

    /* The blinking JRPG "continue" caret. Built from two blocks rather than
     * LV_SYMBOL_DOWN: the symbols live in the Montserrat fallback, not in the
     * pixel font, so a glyph here renders as a tofu box - and a hand-placed
     * two-step wedge is the correct shape on a 4 px grid anyway. */
    s_dialog_cursor = lv_obj_create(s_dialog_panel);
    ESP_RETURN_ON_FALSE(s_dialog_cursor != NULL, ESP_ERR_NO_MEM, TAG,
                        "dialog cursor alloc failed");
    lv_obj_set_size(s_dialog_cursor, UI_PX(4), UI_PX(2));
    lv_obj_set_style_bg_opa(s_dialog_cursor, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_dialog_cursor, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_dialog_cursor, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_dialog_cursor, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_align(s_dialog_cursor, LV_ALIGN_BOTTOM_RIGHT, 0, 0);

    static const struct {
        int32_t x;
        int32_t w;
        int32_t y;
    } caret_rows[] = {{0, 4, 0}, {1, 2, 1}};
    for (size_t i = 0; i < sizeof(caret_rows) / sizeof(caret_rows[0]); ++i) {
        lv_obj_t *row = lv_obj_create(s_dialog_cursor);
        ESP_RETURN_ON_FALSE(row != NULL, ESP_ERR_NO_MEM, TAG, "caret row alloc failed");
        lv_obj_set_size(row, UI_PX(caret_rows[i].w), UI_PX(1));
        lv_obj_set_pos(row, UI_PX(caret_rows[i].x), UI_PX(caret_rows[i].y));
        lv_obj_set_style_bg_color(row, lv_color_hex(UI_PAL_ACCENT_CYAN), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(row, LV_OPA_COVER, LV_PART_MAIN);
        lv_obj_set_style_border_width(row, 0, LV_PART_MAIN);
        lv_obj_set_style_radius(row, 0, LV_PART_MAIN);
        lv_obj_set_style_pad_all(row, 0, LV_PART_MAIN);
        lv_obj_clear_flag(row, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    }
    return ESP_OK;
}

static void ui_home_actor_say(const char *text, uint32_t accent)
{
    if (text == NULL || s_dialog_label == NULL) {
        return;
    }
    size_t length = strlen(text);
    size_t copy = length < sizeof(s_dialog_full) ? length : sizeof(s_dialog_full) - 1U;
    if (copy < length) {
        while (copy > 0U && ((unsigned char)text[copy] & 0xC0U) == 0x80U) {
            copy--;
        }
    }
    memcpy(s_dialog_full, text, copy);
    s_dialog_full[copy] = '\0';
    s_dialog_length = copy;
    s_dialog_page_start = 0U;
    s_dialog_page_end = ui_home_actor_dialog_page_end(0U);
    s_dialog_revealed = 0U;
    s_dialog_page_hold = 0U;
    s_cursor_visible = false;
    lv_label_set_text(s_dialog_label, "");
    if (s_dialog_panel != NULL) {
        lv_obj_set_style_border_color(s_dialog_panel, lv_color_hex(accent), LV_PART_MAIN);
    }
    if (s_dialog_cursor != NULL) {
        lv_obj_set_style_opa(s_dialog_cursor, LV_OPA_TRANSP, LV_PART_MAIN);
        uint32_t count = lv_obj_get_child_count(s_dialog_cursor);
        for (uint32_t i = 0; i < count; ++i) {
            lv_obj_set_style_bg_color(lv_obj_get_child(s_dialog_cursor, i),
                                      lv_color_hex(accent), LV_PART_MAIN);
        }
    }
    ESP_LOGI(TAG, "say: %s", s_dialog_full);
}
