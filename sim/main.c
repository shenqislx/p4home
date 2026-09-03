#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "lvgl.h"

#include "fake_backend.h"
#include "ui_home_actor.h"
#include "ui_home_actor_test.h"
#include "ui_home_rooms.h"
#include "ui_pages.h"
#include "ui_pixel_art.h"
#include "ui_pixel_fx.h"
#include "ui_time_source.h"
#include "world_service.h"

#if LV_USE_SDL
#include "src/drivers/sdl/lv_sdl_mouse.h"
#include "src/drivers/sdl/lv_sdl_window.h"
#endif

/* Host harness for the pixel home page.
 *
 * Two modes:
 *   window  - open an SDL window and run in real time for interactive review
 *   dump    - headless, write one PNG per simulator tick for frame-by-frame
 *             review of the 8 FPS effects
 *
 * Both drive LVGL's clock themselves via lv_tick_set_cb, which is what lets the
 * virtual wall clock replay a full day in seconds. */

#define SIM_HRES 1024
#define SIM_VRES 600

/* Matches BSP_LCD_DRAW_BUFF_SIZE (BSP_LCD_H_RES * 50), single buffered, so the
 * simulator exercises the same 50-line partial-render stripes as the panel. */
#define SIM_DRAW_BUFF_LINES 50

typedef enum {
    SIM_MODE_WINDOW = 0,
    SIM_MODE_DUMP,
} sim_mode_t;

static uint32_t s_virtual_ms;
static uint64_t s_clock_epoch_ms;
static uint32_t s_clock_speed = 1;

static uint32_t sim_tick_get(void)
{
    return s_virtual_ms;
}

static bool sim_time_now(void *user_data, struct tm *out_local)
{
    (void)user_data;
    time_t seconds = (time_t)(fake_clock_epoch() / 1000U);
    return gmtime_r(&seconds, out_local) != NULL;
}

static void sim_headless_flush_cb(lv_display_t *display, const lv_area_t *area,
                                  uint8_t *pixels)
{
    (void)area;
    (void)pixels;
    /* Nothing to present: frames are captured with lv_snapshot. The ready call
     * is still mandatory, otherwise lv_refr blocks forever waiting for the
     * previous stripe to be consumed. */
    lv_display_flush_ready(display);
}

static lv_display_t *sim_create_headless_display(void)
{
    static uint16_t buffer[SIM_HRES * SIM_DRAW_BUFF_LINES];
    lv_display_t *display = lv_display_create(SIM_HRES, SIM_VRES);
    if (display == NULL) {
        return NULL;
    }
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(display, buffer, NULL, sizeof(buffer),
                           LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(display, sim_headless_flush_cb);
    return display;
}

/* Snapshot target owned by the harness rather than lv_malloc: a 1024x600 RGB565
 * frame is 1.2 MB, which would not fit in the device-matched LV_MEM_SIZE. Keeping
 * LVGL's heap at the device budget means widget allocation pressure in the
 * simulator still mirrors the panel. */
static uint8_t s_snapshot_data[SIM_HRES * SIM_VRES * 2];
static lv_draw_buf_t s_snapshot_buf;
static bool s_snapshot_ready;

static void sim_write_snapshot(const char *dir, uint32_t index)
{
    if (!s_snapshot_ready) {
        if (lv_draw_buf_init(&s_snapshot_buf, SIM_HRES, SIM_VRES, LV_COLOR_FORMAT_RGB565,
                             SIM_HRES * 2, s_snapshot_data,
                             sizeof(s_snapshot_data)) != LV_RESULT_OK) {
            fprintf(stderr, "snapshot buffer init failed\n");
            return;
        }
        s_snapshot_ready = true;
    }

    lv_draw_buf_t *snapshot = &s_snapshot_buf;
    if (lv_snapshot_take_to_draw_buf(lv_screen_active(), LV_COLOR_FORMAT_RGB565,
                                     snapshot) != LV_RESULT_OK) {
        fprintf(stderr, "snapshot failed at frame %u\n", (unsigned)index);
        return;
    }

    char path[512];
    snprintf(path, sizeof(path), "%s/frame_%04u.ppm", dir, (unsigned)index);
    FILE *file = fopen(path, "wb");
    if (file == NULL) {
        return;
    }

    int32_t width = snapshot->header.w;
    int32_t height = snapshot->header.h;
    uint32_t stride = snapshot->header.stride;

    /* PPM keeps the C side dependency-free; scripts/ppm_to_png.py converts to
     * PNG with the standard library only. */
    fprintf(file, "P6\n%d %d\n255\n", (int)width, (int)height);
    for (int32_t y = 0; y < height; ++y) {
        const uint8_t *row = snapshot->data + (size_t)y * stride;
        for (int32_t x = 0; x < width; ++x) {
            uint16_t value = (uint16_t)(row[x * 2] | (row[x * 2 + 1] << 8));
            uint8_t r5 = (value >> 11) & 0x1F;
            uint8_t g6 = (value >> 5) & 0x3F;
            uint8_t b5 = value & 0x1F;
            uint8_t rgb[3] = {
                (uint8_t)((r5 << 3) | (r5 >> 2)),
                (uint8_t)((g6 << 2) | (g6 >> 4)),
                (uint8_t)((b5 << 3) | (b5 >> 2)),
            };
            fwrite(rgb, 1, sizeof(rgb), file);
        }
    }
    fclose(file);
}

static void sim_advance(uint32_t ms)
{
    s_virtual_ms += ms;
    fake_clock_advance((uint64_t)ms * s_clock_speed);
    lv_timer_handler();
}

static world_action_request_t sim_object_request(const char *action_id,
                                                 world_action_tool_t tool,
                                                 const char *target_id)
{
    world_action_request_t request = {
        .action_id = action_id,
        .tool = tool,
        .timeout_ms = 5000U,
    };
    request.arguments.target_id = target_id;
    return request;
}

static bool sim_begin_object_action(world_action_request_t *request,
                                    world_object_animation_t animation)
{
    world_action_event_t event = {0};
    if (world_service_submit(request, &event) != ESP_OK ||
        event.status != WORLD_ACTION_STATUS_ACCEPTED ||
        world_service_start_next(&event) != ESP_OK ||
        event.status != WORLD_ACTION_STATUS_STARTED) {
        return false;
    }
    sim_advance(UI_FX_TICK_MS);
    ui_home_actor_render_snapshot_t render = {0};
    ui_home_actor_get_render_snapshot(&render);
    if (render.animation != animation) {
        return false;
    }
    if (animation == WORLD_OBJECT_ANIMATION_CAT_WALK) {
        sim_advance(UI_FX_TICK_MS);
        ui_home_actor_get_render_snapshot(&render);
        return render.animation == WORLD_OBJECT_ANIMATION_CAT_WALK && render.moving;
    }
    return true;
}

static bool sim_complete_object_action(void)
{
    world_action_event_t event = {0};
    if (world_service_complete_active(&event) != ESP_OK ||
        event.status != WORLD_ACTION_STATUS_COMPLETED) {
        return false;
    }
    sim_advance(UI_FX_TICK_MS);
    return true;
}

static bool sim_seed_non_living_human_before_ui(void)
{
    if (world_service_init(NULL) != ESP_OK ||
        world_service_set_agent_connected(true) != ESP_OK) {
        return false;
    }
    world_action_request_t request = {
        .action_id = "sim-human-initial-study",
        .tool = WORLD_ACTION_CHARACTER_GO_TO_ROOM,
        .timeout_ms = 5000U,
    };
    request.arguments.room = WORLD_ROOM_STUDY;
    world_action_event_t event = {0};
    return world_service_submit(&request, &event) == ESP_OK &&
           event.status == WORLD_ACTION_STATUS_ACCEPTED &&
           world_service_start_next(&event) == ESP_OK &&
           event.status == WORLD_ACTION_STATUS_STARTED &&
           world_service_complete_active(&event) == ESP_OK &&
           event.status == WORLD_ACTION_STATUS_COMPLETED;
}

static bool sim_wait_for_actor(uint32_t max_ticks)
{
    for (uint32_t tick = 0U; tick < max_ticks; ++tick) {
        ui_home_actor_render_snapshot_t render = {0};
        ui_home_actor_get_render_snapshot(&render);
        if (!render.moving) {
            return true;
        }
        sim_advance(UI_FX_TICK_MS);
    }
    return false;
}

static int sim_verify_object_gate(void)
{
    if (world_service_set_agent_connected(true) != ESP_OK) {
        return 1;
    }
    world_action_request_t go_sofa = sim_object_request(
        "sim-3d-go-sofa", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.sofa");
    if (!sim_begin_object_action(&go_sofa, WORLD_OBJECT_ANIMATION_CAT_WALK) ||
        !sim_complete_object_action() || !sim_wait_for_actor(256U)) {
        fprintf(stderr, "VERIFY:phase3d:sim_object_anchor:FAIL reason=go_to_sofa\n");
        return 1;
    }
    ui_home_actor_render_snapshot_t render = {0};
    ui_home_actor_get_render_snapshot(&render);
    /* Living room is the centre lower bay: origin (60,52), plus registry
     * anchor (10,32). The renderer reports a global floor coordinate. */
    if (render.art_x != 70 || render.floor_y != 84 ||
        render.facing != WORLD_OBJECT_FACING_RIGHT ||
        strcmp(render.target_object_id, "living_room.sofa") != 0) {
        fprintf(stderr, "VERIFY:phase3d:sim_object_anchor:FAIL reason=anchor_or_facing\n");
        return 1;
    }

    world_action_request_t sit = sim_object_request(
        "sim-3d-sit-sofa", WORLD_ACTION_CHARACTER_SIT, "living_room.sofa");
    if (!sim_begin_object_action(&sit, WORLD_OBJECT_ANIMATION_CAT_SIT) ||
        !sim_complete_object_action()) {
        fprintf(stderr, "VERIFY:phase3d:sim_object_pose:FAIL reason=sit_binding\n");
        return 1;
    }
    ui_home_actor_get_render_snapshot(&render);
    if (render.pose != WORLD_CHARACTER_POSE_SITTING ||
        render.animation != WORLD_OBJECT_ANIMATION_CAT_SIT) {
        fprintf(stderr, "VERIFY:phase3d:sim_object_pose:FAIL reason=sit_pose\n");
        return 1;
    }

    world_action_request_t look = sim_object_request(
        "sim-3d-look-sofa", WORLD_ACTION_CHARACTER_LOOK_AT,
        "living_room.sofa");
    if (!sim_begin_object_action(&look, WORLD_OBJECT_ANIMATION_CAT_LOOK)) {
        fprintf(stderr, "VERIFY:phase3d:sim_animation_bindings:FAIL reason=look\n");
        return 1;
    }
    world_action_event_t cancelled = {0};
    if (world_service_cancel(look.action_id, &cancelled) != ESP_OK ||
        cancelled.error != WORLD_ACTION_ERROR_CANCELLED) {
        fprintf(stderr, "VERIFY:phase3d:sim_cancel:FAIL reason=cancel_lifecycle\n");
        return 1;
    }
    sim_advance(UI_FX_TICK_MS);
    ui_home_actor_get_render_snapshot(&render);
    if (render.pose != WORLD_CHARACTER_POSE_SITTING ||
        render.animation != WORLD_OBJECT_ANIMATION_CAT_SIT) {
        fprintf(stderr, "VERIFY:phase3d:sim_cancel:FAIL reason=pose_not_restored\n");
        return 1;
    }

    world_action_request_t paw = sim_object_request(
        "sim-3d-paw-sofa", WORLD_ACTION_CHARACTER_INTERACT,
        "living_room.sofa");
    if (!sim_begin_object_action(&paw, WORLD_OBJECT_ANIMATION_CAT_PAW) ||
        !sim_complete_object_action()) {
        fprintf(stderr, "VERIFY:phase3d:sim_animation_bindings:FAIL reason=interact\n");
        return 1;
    }

    world_action_request_t go_desk = sim_object_request(
        "sim-3d-go-desk", WORLD_ACTION_CHARACTER_GO_TO_OBJECT, "study.desk");
    if (!sim_begin_object_action(&go_desk, WORLD_OBJECT_ANIMATION_CAT_WALK) ||
        !sim_complete_object_action()) {
        fprintf(stderr, "VERIFY:phase3d:sim_object_anchor:FAIL reason=go_to_desk\n");
        return 1;
    }
    ui_home_actor_get_render_snapshot(&render);
    if (!render.moving ||
        (render.art_x == 94 && render.floor_y == 46)) {
        fprintf(stderr, "VERIFY:phase3d:sim_object_anchor:FAIL reason=go_to_desk_teleport\n");
        return 1;
    }

    /* A cancelled action must not survive in the UI's deferred queue. */
    world_action_request_t cancelled_interact = sim_object_request(
        "sim-3d-cancelled-interact-desk", WORLD_ACTION_CHARACTER_INTERACT,
        "study.desk");
    world_action_event_t cancelled_interact_event = {0};
    if (world_service_submit(&cancelled_interact, &cancelled_interact_event) != ESP_OK ||
        cancelled_interact_event.status != WORLD_ACTION_STATUS_ACCEPTED ||
        world_service_start_next(&cancelled_interact_event) != ESP_OK ||
        cancelled_interact_event.status != WORLD_ACTION_STATUS_STARTED) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=cancelled_deferred_start\n");
        return 1;
    }
    sim_advance(UI_FX_TICK_MS);
    world_service_snapshot_t repeated_started_snapshot = {0};
    world_service_get_snapshot(&repeated_started_snapshot);
    ui_home_actor_apply_snapshot(&repeated_started_snapshot);
    ui_home_actor_apply_snapshot(&repeated_started_snapshot);
    if (world_service_cancel(cancelled_interact.action_id,
                             &cancelled_interact_event) != ESP_OK ||
        cancelled_interact_event.status != WORLD_ACTION_STATUS_FAILED ||
        cancelled_interact_event.error != WORLD_ACTION_ERROR_CANCELLED) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=cancelled_deferred_terminal\n");
        return 1;
    }
    sim_advance(UI_FX_TICK_MS);
    ui_home_actor_get_render_snapshot(&render);
    if (!render.moving || render.animation != WORLD_OBJECT_ANIMATION_CAT_WALK) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=cancelled_deferred_overlap\n");
        return 1;
    }

    /* The protocol sequence can start and finish a short interaction while a
     * cross-storey go_to is still rendering. UI must retain the walk and defer
     * the interaction frames until the Human reaches the desk. */
    world_action_request_t interact_desk = sim_object_request(
        "sim-3d-interact-desk-during-walk", WORLD_ACTION_CHARACTER_INTERACT,
        "study.desk");
    world_action_event_t interact_event = {0};
    if (world_service_submit(&interact_desk, &interact_event) != ESP_OK ||
        interact_event.status != WORLD_ACTION_STATUS_ACCEPTED ||
        world_service_start_next(&interact_event) != ESP_OK ||
        interact_event.status != WORLD_ACTION_STATUS_STARTED) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=deferred_interact_start\n");
        return 1;
    }
    sim_advance(UI_FX_TICK_MS);
    world_service_get_snapshot(&repeated_started_snapshot);
    ui_home_actor_apply_snapshot(&repeated_started_snapshot);
    ui_home_actor_apply_snapshot(&repeated_started_snapshot);
    ui_home_actor_get_render_snapshot(&render);
    if (!render.moving || render.animation != WORLD_OBJECT_ANIMATION_CAT_WALK ||
        world_service_complete_active(&interact_event) != ESP_OK ||
        interact_event.status != WORLD_ACTION_STATUS_COMPLETED) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=deferred_interact_overlap\n");
        return 1;
    }
    sim_advance(UI_FX_TICK_MS);
    ui_home_actor_get_render_snapshot(&render);
    if (!render.moving || render.animation != WORLD_OBJECT_ANIMATION_CAT_WALK ||
        !sim_wait_for_actor(256U)) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=deferred_interact_walk\n");
        return 1;
    }
    ui_home_actor_get_render_snapshot(&render);
    /* Study is the centre upper bay: origin (60,14), plus anchor (34,32). */
    if (render.art_x != 94 || render.floor_y != 46 ||
        render.facing != WORLD_OBJECT_FACING_LEFT ||
        strcmp(render.target_object_id, "study.desk") != 0 ||
        render.animation != WORLD_OBJECT_ANIMATION_CAT_PAW) {
        fprintf(stderr, "VERIFY:phase3d:sim_object_anchor:FAIL reason=left_anchor\n");
        return 1;
    }
    for (size_t frame = 0U; frame < ACTOR_PAW_FRAME_COUNT / 2U; ++frame) {
        sim_advance(UI_FX_TICK_MS);
        ui_home_actor_get_render_snapshot(&render);
        if (render.animation != WORLD_OBJECT_ANIMATION_CAT_PAW) {
            fprintf(stderr,
                    "VERIFY:phase3d:sim_animation_bindings:FAIL reason=deferred_interact_frames\n");
            return 1;
        }
    }
    sim_advance(UI_FX_TICK_MS);
    ui_home_actor_get_render_snapshot(&render);
    if (render.animation == WORLD_OBJECT_ANIMATION_CAT_PAW) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=deferred_cancel_or_dedupe\n");
        return 1;
    }

    /* A newer go_to must invalidate animation work for the previous target. */
    world_action_request_t go_sofa_again = sim_object_request(
        "sim-3d-go-sofa-again", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.sofa");
    if (!sim_begin_object_action(&go_sofa_again, WORLD_OBJECT_ANIMATION_CAT_WALK) ||
        !sim_complete_object_action()) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=retarget_go_sofa\n");
        return 1;
    }
    world_action_request_t stale_sofa_interact = sim_object_request(
        "sim-3d-stale-sofa-interact", WORLD_ACTION_CHARACTER_INTERACT,
        "living_room.sofa");
    world_action_event_t stale_sofa_event = {0};
    if (world_service_submit(&stale_sofa_interact, &stale_sofa_event) != ESP_OK ||
        stale_sofa_event.status != WORLD_ACTION_STATUS_ACCEPTED ||
        world_service_start_next(&stale_sofa_event) != ESP_OK ||
        stale_sofa_event.status != WORLD_ACTION_STATUS_STARTED) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=retarget_interact_start\n");
        return 1;
    }
    sim_advance(UI_FX_TICK_MS);
    if (world_service_complete_active(&stale_sofa_event) != ESP_OK ||
        stale_sofa_event.status != WORLD_ACTION_STATUS_COMPLETED) {
        return 1;
    }
    sim_advance(UI_FX_TICK_MS);
    world_action_request_t go_desk_again = sim_object_request(
        "sim-3d-go-desk-again", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "study.desk");
    if (!sim_begin_object_action(&go_desk_again, WORLD_OBJECT_ANIMATION_CAT_WALK) ||
        !sim_complete_object_action() || !sim_wait_for_actor(256U)) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=retarget_go_desk\n");
        return 1;
    }
    ui_home_actor_get_render_snapshot(&render);
    if (render.art_x != 94 || render.floor_y != 46 ||
        strcmp(render.target_object_id, "study.desk") != 0 ||
        render.animation == WORLD_OBJECT_ANIMATION_CAT_PAW) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=stale_target_animation\n");
        return 1;
    }

    /* Fill the bounded UI queue, repeat one started snapshot, then exceed the
     * capacity once. It must play only the retained eight actions and settle. */
    world_action_request_t capacity_go = sim_object_request(
        "sim-3d-capacity-go-sofa", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.sofa");
    if (!sim_begin_object_action(&capacity_go, WORLD_OBJECT_ANIMATION_CAT_WALK) ||
        !sim_complete_object_action()) {
        return 1;
    }
    char capacity_action_ids[WORLD_SERVICE_ACTION_QUEUE_CAPACITY + 1U][48];
    for (size_t index = 0U;
         index < WORLD_SERVICE_ACTION_QUEUE_CAPACITY + 1U; ++index) {
        snprintf(capacity_action_ids[index], sizeof(capacity_action_ids[index]),
                 "sim-3d-capacity-interact-%u", (unsigned)index);
        world_action_request_t capacity_interact = sim_object_request(
            capacity_action_ids[index], WORLD_ACTION_CHARACTER_INTERACT,
            "living_room.sofa");
        world_action_event_t capacity_event = {0};
        if (world_service_submit(&capacity_interact, &capacity_event) != ESP_OK ||
            capacity_event.status != WORLD_ACTION_STATUS_ACCEPTED ||
            world_service_start_next(&capacity_event) != ESP_OK ||
            capacity_event.status != WORLD_ACTION_STATUS_STARTED) {
            fprintf(stderr,
                    "VERIFY:phase3d:sim_animation_bindings:FAIL reason=capacity_start\n");
            return 1;
        }
        sim_advance(UI_FX_TICK_MS);
        if (index == 0U) {
            world_service_get_snapshot(&repeated_started_snapshot);
            ui_home_actor_apply_snapshot(&repeated_started_snapshot);
            ui_home_actor_apply_snapshot(&repeated_started_snapshot);
        }
        if (world_service_complete_active(&capacity_event) != ESP_OK ||
            capacity_event.status != WORLD_ACTION_STATUS_COMPLETED) {
            return 1;
        }
        sim_advance(UI_FX_TICK_MS);
    }
    /* The oldest seen-id slot has now wrapped. Queue membership must still
     * reject a late duplicate of that retained action. */
    ui_home_actor_apply_snapshot(&repeated_started_snapshot);
    ui_home_actor_apply_snapshot(&repeated_started_snapshot);
    if (!sim_wait_for_actor(256U)) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=capacity_walk\n");
        return 1;
    }
    ui_home_actor_get_render_snapshot(&render);
    if (render.animation != WORLD_OBJECT_ANIMATION_CAT_PAW) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=capacity_first\n");
        return 1;
    }
    size_t deferred_ticks = 0U;
    while (render.animation == WORLD_OBJECT_ANIMATION_CAT_PAW &&
           deferred_ticks <= WORLD_SERVICE_ACTION_QUEUE_CAPACITY * 3U) {
        sim_advance(UI_FX_TICK_MS);
        deferred_ticks++;
        ui_home_actor_get_render_snapshot(&render);
    }
    if (deferred_ticks != WORLD_SERVICE_ACTION_QUEUE_CAPACITY * 3U ||
        render.animation != WORLD_OBJECT_ANIMATION_NONE ||
        render.pose != WORLD_CHARACTER_POSE_STANDING) {
        fprintf(stderr,
                "VERIFY:phase3d:sim_animation_bindings:FAIL reason=capacity_terminal ticks=%u\n",
                (unsigned)deferred_ticks);
        return 1;
    }

    if (world_service_set_object_occupied("living_room.sofa", true) != ESP_OK) {
        return 1;
    }
    world_action_request_t conflict = sim_object_request(
        "sim-3d-occupied-sofa", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.sofa");
    world_action_event_t rejected = {0};
    if (world_service_submit(&conflict, &rejected) != ESP_OK ||
        rejected.status != WORLD_ACTION_STATUS_FAILED ||
        rejected.error != WORLD_ACTION_ERROR_OBJECT_OCCUPIED) {
        fprintf(stderr, "VERIFY:phase3d:sim_occupancy_conflict:FAIL reason=not_rejected\n");
        return 1;
    }

    printf("VERIFY:phase3d:sim_object_anchor:PASS targets=sofa,desk facing=right,left\n");
    printf("VERIFY:phase3d:sim_object_pose:PASS pose=sitting floor_anchor=stable\n");
    printf("VERIFY:phase3d:sim_animation_bindings:PASS animations=walk,sit,look,paw fps=8\n");
    printf("VERIFY:phase3d:sim_deferred_sequence:PASS cancel=drop duplicate=dedupe "
           "retarget=clear capacity=8 overflow=drop_newest\n");
    printf("VERIFY:phase3d:sim_cancel:PASS restored=sitting\n");
    printf("VERIFY:phase3d:sim_occupancy_conflict:PASS error=OBJECT_OCCUPIED\n");
    return 0;
}

static bool sim_pet_inside_house(const ui_home_actor_render_snapshot_t *render)
{
    return render->pet_art_x >= 2 && render->pet_art_x + 10 <= 174 &&
           render->pet_floor_y >= 46 && render->pet_floor_y <= 84 &&
           render->pet_target_art_x >= 2 && render->pet_target_art_x + 10 <= 174 &&
           (render->pet_target_floor_y == 46 || render->pet_target_floor_y == 84) &&
           render->pet_room < UI_HOME_ROOM_COUNT &&
           render->pet_target_room < UI_HOME_ROOM_COUNT;
}

static bool sim_same_pet_state(const ui_home_actor_render_snapshot_t *left,
                               const ui_home_actor_render_snapshot_t *right)
{
    return left->pet_art_x == right->pet_art_x &&
           left->pet_floor_y == right->pet_floor_y &&
           left->pet_target_art_x == right->pet_target_art_x &&
           left->pet_target_floor_y == right->pet_target_floor_y &&
           left->pet_room == right->pet_room &&
           left->pet_target_room == right->pet_target_room &&
           left->pet_ticks_until_target == right->pet_ticks_until_target &&
           left->pet_target_revision == right->pet_target_revision &&
           left->pet_moving == right->pet_moving;
}

static int sim_verify_human_idle_gate(void)
{
    world_service_snapshot_t world = {0};
    ui_home_actor_render_snapshot_t render = {0};
    world_service_get_snapshot(&world);
    ui_home_actor_get_render_snapshot(&render);
    if (world.activity != WORLD_ACTIVITY_IDLE || render.sleeping) {
        fprintf(stderr, "VERIFY:human_idle:startup_awake:FAIL\n");
        return 1;
    }

    /* Fast-forward the monotonic clock without waiting ten real minutes. */
    sim_advance(WORLD_SERVICE_SLEEP_IDLE_MS - 1U);
    (void)world_service_update_sleep_clock(true, true);
    world_service_get_snapshot(&world);
    if (world.activity != WORLD_ACTIVITY_IDLE) {
        fprintf(stderr, "VERIFY:human_idle:threshold:FAIL reason=early_sleep\n");
        return 1;
    }
    sim_advance(1U);
    (void)world_service_update_sleep_clock(true, true);
    world_service_get_snapshot(&world);
    ui_home_actor_apply_snapshot(&world);
    ui_home_actor_get_render_snapshot(&render);
    if (world.activity != WORLD_ACTIVITY_SLEEP || !render.sleeping) {
        fprintf(stderr, "VERIFY:human_idle:threshold:FAIL reason=no_sleep\n");
        return 1;
    }

    ui_home_actor_render_snapshot_t cat_before = render;
    if (world_service_note_user_interaction() != ESP_OK) {
        return 1;
    }
    world_service_get_snapshot(&world);
    ui_home_actor_apply_snapshot(&world);
    ui_home_actor_get_render_snapshot(&render);
    if (world.activity != WORLD_ACTIVITY_IDLE || render.sleeping ||
        !sim_same_pet_state(&cat_before, &render)) {
        fprintf(stderr, "VERIFY:human_idle:wake:FAIL reason=interaction_or_cat\n");
        return 1;
    }

    sim_advance(WORLD_SERVICE_SLEEP_IDLE_MS);
    (void)world_service_update_sleep_clock(true, true);
    world_service_get_snapshot(&world);
    ui_home_actor_apply_snapshot(&world);
    ui_home_actor_get_render_snapshot(&render);
    if (world.activity != WORLD_ACTIVITY_SLEEP) {
        fprintf(stderr, "VERIFY:human_idle:action_wake:FAIL reason=setup\n");
        return 1;
    }

    cat_before = render;
    world_action_request_t move = {
        .action_id = "sim-human-idle-wake-move",
        .tool = WORLD_ACTION_CHARACTER_GO_TO_ROOM,
        .arguments.room = WORLD_ROOM_KITCHEN,
        .timeout_ms = 5000U,
    };
    world_action_event_t event = {0};
    if (world_service_submit(&move, &event) != ESP_OK ||
        world_service_start_next(&event) != ESP_OK ||
        event.status != WORLD_ACTION_STATUS_STARTED) {
        return 1;
    }
    world_service_get_snapshot(&world);
    ui_home_actor_apply_snapshot(&world);
    ui_home_actor_get_render_snapshot(&render);
    if (world.activity != WORLD_ACTIVITY_IDLE || render.sleeping ||
        !sim_same_pet_state(&cat_before, &render)) {
        fprintf(stderr, "VERIFY:human_idle:action_wake:FAIL reason=start_or_cat\n");
        return 1;
    }
    if (world_service_complete_active(&event) != ESP_OK ||
        event.status != WORLD_ACTION_STATUS_COMPLETED) {
        return 1;
    }
    world_service_get_snapshot(&world);
    ui_home_actor_apply_snapshot(&world);
    ui_home_actor_get_render_snapshot(&render);
    if (world.room != WORLD_ROOM_KITCHEN ||
        world.activity != WORLD_ACTIVITY_IDLE || render.sleeping ||
        !sim_same_pet_state(&cat_before, &render)) {
        fprintf(stderr, "VERIFY:human_idle:action_wake:FAIL reason=complete_or_cat\n");
        return 1;
    }

    if (!sim_wait_for_actor(256U)) {
        return 1;
    }
    /* The second cycle proves online Human sleep independently of HA fallback. */
    if (world_service_set_agent_connected(true) != ESP_OK) {
        return 1;
    }
    world_action_request_t go_to_sofa = sim_object_request(
        "sim-human-idle-sofa", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.sofa");
    if (!sim_begin_object_action(&go_to_sofa, WORLD_OBJECT_ANIMATION_CAT_WALK) ||
        !sim_complete_object_action() || !sim_wait_for_actor(256U)) {
        return 1;
    }
    world_action_request_t sit_sofa = sim_object_request(
        "sim-human-idle-sit", WORLD_ACTION_CHARACTER_SIT,
        "living_room.sofa");
    if (!sim_begin_object_action(&sit_sofa, WORLD_OBJECT_ANIMATION_CAT_SIT) ||
        !sim_complete_object_action()) {
        return 1;
    }
    (void)world_service_note_user_interaction();
    sim_advance(WORLD_SERVICE_SLEEP_IDLE_MS);
    cat_before = render;
    (void)world_service_update_sleep_clock(true, true);
    world_service_get_snapshot(&world);
    ui_home_actor_apply_snapshot(&world);
    ui_home_actor_get_render_snapshot(&render);
    if (world.activity != WORLD_ACTIVITY_SLEEP || !render.sleeping ||
        world.character_pose != WORLD_CHARACTER_POSE_SITTING ||
        strcmp(world.target_object_id, "living_room.sofa") != 0 ||
        strcmp(render.target_object_id, "living_room.sofa") != 0) {
        fprintf(stderr, "VERIFY:human_idle:object_sleep:FAIL\n");
        return 1;
    }

    printf("VERIFY:human_idle:threshold:PASS night=20:00-05:00 idle_ms=%u\n",
           (unsigned)WORLD_SERVICE_SLEEP_IDLE_MS);
    printf("VERIFY:human_idle:wake:PASS sources=interaction,action\n");
    printf("VERIFY:human_idle:object_sleep:PASS target=sofa pose=sitting render=sleep\n");
    printf("VERIFY:human_idle:cat_isolation:PASS source=local_timer\n");
    return 0;
}

static int sim_verify_pet_autonomy(void)
{
    ui_home_actor_render_snapshot_t before_human = {0};
    ui_home_actor_get_render_snapshot(&before_human);
    world_service_snapshot_t initial_human = {0};
    world_service_get_snapshot(&initial_human);
    if (!sim_pet_inside_house(&before_human) ||
        before_human.pet_ticks_until_target < 4U ||
        initial_human.room != WORLD_ROOM_STUDY ||
        before_human.pet_room != WORLD_ROOM_LIVING_ROOM) {
        fprintf(stderr,
                "VERIFY:pet_autonomy:safe_bounds:FAIL reason=initial_state x=%d floor=%d "
                "target_x=%d target_floor=%d human_room=%u room=%u target_room=%u ticks=%u\n",
                before_human.pet_art_x, before_human.pet_floor_y,
                before_human.pet_target_art_x, before_human.pet_target_floor_y,
                (unsigned)initial_human.room,
                (unsigned)before_human.pet_room, (unsigned)before_human.pet_target_room,
                (unsigned)before_human.pet_ticks_until_target);
        return 1;
    }

    if (world_service_set_agent_connected(true) != ESP_OK) {
        return 1;
    }

    /* Human deferred-animation transitions share the LVGL timer callback with
     * Cat. They must never skip Cat's independently-owned timer tick. */
    uint64_t cat_timer_start_ms = s_virtual_ms;
    world_action_request_t timer_human_go = sim_object_request(
        "sim-pet-timer-human-go-desk", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "study.desk");
    if (!sim_begin_object_action(&timer_human_go, WORLD_OBJECT_ANIMATION_CAT_WALK) ||
        !sim_complete_object_action()) {
        fprintf(stderr,
                "VERIFY:pet_autonomy:human_isolation:FAIL reason=deferred_timer_go\n");
        return 1;
    }
    world_action_request_t timer_human_interact = sim_object_request(
        "sim-pet-timer-human-interact", WORLD_ACTION_CHARACTER_INTERACT,
        "study.desk");
    world_action_event_t timer_human_event = {0};
    if (world_service_submit(&timer_human_interact, &timer_human_event) != ESP_OK ||
        timer_human_event.status != WORLD_ACTION_STATUS_ACCEPTED ||
        world_service_start_next(&timer_human_event) != ESP_OK ||
        timer_human_event.status != WORLD_ACTION_STATUS_STARTED) {
        return 1;
    }
    sim_advance(UI_FX_TICK_MS);
    if (world_service_complete_active(&timer_human_event) != ESP_OK ||
        timer_human_event.status != WORLD_ACTION_STATUS_COMPLETED) {
        return 1;
    }
    sim_advance(UI_FX_TICK_MS);
    if (!sim_wait_for_actor(64U)) {
        return 1;
    }
    for (size_t tick = 0U; tick < ACTOR_PAW_FRAME_COUNT / 2U + 1U; ++tick) {
        sim_advance(UI_FX_TICK_MS);
    }
    ui_home_actor_render_snapshot_t after_deferred = {0};
    ui_home_actor_get_render_snapshot(&after_deferred);
    uint32_t elapsed_cat_ticks =
        (uint32_t)((s_virtual_ms - cat_timer_start_ms) / UI_FX_TICK_MS);
    if (elapsed_cat_ticks >= before_human.pet_ticks_until_target ||
        after_deferred.pet_moving ||
        after_deferred.pet_target_revision != before_human.pet_target_revision ||
        after_deferred.pet_ticks_until_target !=
            before_human.pet_ticks_until_target - elapsed_cat_ticks) {
        fprintf(stderr,
                "VERIFY:pet_autonomy:timer_gate:FAIL reason=human_tick_interference "
                "elapsed=%u before=%u after=%u\n",
                (unsigned)elapsed_cat_ticks,
                (unsigned)before_human.pet_ticks_until_target,
                (unsigned)after_deferred.pet_ticks_until_target);
        return 1;
    }

    world_action_request_t human_go = sim_object_request(
        "sim-human-go-sofa", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.sofa");
    if (!sim_begin_object_action(&human_go, WORLD_OBJECT_ANIMATION_CAT_WALK) ||
        !sim_complete_object_action()) {
        fprintf(stderr, "VERIFY:pet_autonomy:human_isolation:FAIL reason=human_action\n");
        return 1;
    }

    ui_home_actor_render_snapshot_t after_human = {0};
    ui_home_actor_get_render_snapshot(&after_human);
    if (after_human.pet_art_x != before_human.pet_art_x ||
        after_human.pet_floor_y != before_human.pet_floor_y ||
        after_human.pet_target_art_x != before_human.pet_target_art_x ||
        after_human.pet_target_floor_y != before_human.pet_target_floor_y ||
        after_human.pet_target_revision != before_human.pet_target_revision ||
        after_human.pet_moving) {
        fprintf(stderr, "VERIFY:pet_autonomy:human_isolation:FAIL reason=pet_changed\n");
        return 1;
    }

    const uint32_t initial_revision = after_human.pet_target_revision;
    const int16_t initial_target_x = after_human.pet_target_art_x;
    const int16_t initial_target_floor = after_human.pet_target_floor_y;
    while (after_human.pet_ticks_until_target > 1U) {
        sim_advance(UI_FX_TICK_MS);
        ui_home_actor_get_render_snapshot(&after_human);
        if (after_human.pet_target_revision != initial_revision ||
            after_human.pet_target_art_x != initial_target_x ||
            after_human.pet_target_floor_y != initial_target_floor ||
            after_human.pet_moving) {
            fprintf(stderr, "VERIFY:pet_autonomy:timer_gate:FAIL reason=early_retarget\n");
            return 1;
        }
    }

    sim_advance(UI_FX_TICK_MS);
    ui_home_actor_get_render_snapshot(&after_human);
    if (!after_human.pet_moving ||
        after_human.pet_target_revision != initial_revision + 1U ||
        (after_human.pet_target_art_x == initial_target_x &&
         after_human.pet_target_floor_y == initial_target_floor)) {
        fprintf(stderr, "VERIFY:pet_autonomy:timer_gate:FAIL reason=no_retarget\n");
        return 1;
    }

    /* Cover a same-floor leg and the next cross-storey leg. Every rendered
     * position and every selected destination must stay inside the house. */
    bool completed_cross_storey = false;
    for (uint32_t tick = 0U; tick < 400U; ++tick) {
        sim_advance(UI_FX_TICK_MS);
        ui_home_actor_get_render_snapshot(&after_human);
        if (!sim_pet_inside_house(&after_human)) {
            fprintf(stderr, "VERIFY:pet_autonomy:safe_bounds:FAIL reason=out_of_bounds\n");
            return 1;
        }
        if (after_human.pet_target_revision >= initial_revision + 2U &&
            !after_human.pet_moving) {
            completed_cross_storey = true;
            break;
        }
    }
    if (!completed_cross_storey) {
        fprintf(stderr, "VERIFY:pet_autonomy:safe_bounds:FAIL reason=route_timeout\n");
        return 1;
    }

    printf("VERIFY:pet_autonomy:human_isolation:PASS source=local_timer\n");
    printf("VERIFY:pet_autonomy:timer_gate:PASS idle_ticks=80 deterministic=true\n");
    printf("VERIFY:pet_autonomy:safe_bounds:PASS routes=same_floor,cross_storey\n");
    return 0;
}

static void sim_usage(const char *argv0)
{
    fprintf(stderr,
            "usage: %s [--mode window|dump] [--out DIR] [--frames N]\n"
            "          [--clock-speed N] [--start-hour H] [--scenario]\n"
            "          [--verify-object-gate] [--verify-pet-autonomy]\n"
            "          [--verify-human-idle]\n",
            argv0);
}

int main(int argc, char **argv)
{
    sim_mode_t mode = SIM_MODE_WINDOW;
    const char *out_dir = "build-preview/frames";
    uint32_t frames = 0;
    int start_hour = 20;
    bool scenario = false;
    bool verify_object_gate = false;
    bool verify_pet_autonomy = false;
    bool verify_human_idle = false;

    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--mode") == 0 && i + 1 < argc) {
            mode = strcmp(argv[++i], "dump") == 0 ? SIM_MODE_DUMP : SIM_MODE_WINDOW;
        } else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) {
            out_dir = argv[++i];
        } else if (strcmp(argv[i], "--frames") == 0 && i + 1 < argc) {
            frames = (uint32_t)strtoul(argv[++i], NULL, 10);
        } else if (strcmp(argv[i], "--clock-speed") == 0 && i + 1 < argc) {
            s_clock_speed = (uint32_t)strtoul(argv[++i], NULL, 10);
        } else if (strcmp(argv[i], "--start-hour") == 0 && i + 1 < argc) {
            start_hour = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--scenario") == 0) {
            scenario = true;
        } else if (strcmp(argv[i], "--verify-object-gate") == 0) {
            verify_object_gate = true;
        } else if (strcmp(argv[i], "--verify-pet-autonomy") == 0) {
            verify_pet_autonomy = true;
        } else if (strcmp(argv[i], "--verify-human-idle") == 0) {
            verify_human_idle = true;
        } else {
            sim_usage(argv[0]);
            return 2;
        }
    }

    lv_init();
    /* Must come after lv_init: the tick callback lives in lv_global, which
     * LV_GLOBAL_INIT zeroes (lv_init.c:195). Setting it earlier silently leaves
     * LVGL with no clock, so no timer ever fires. */
    lv_tick_set_cb(sim_tick_get);

    /* 2026-07-30 at the requested hour, UTC. The fake clock formats with gmtime
     * so no timezone database is needed on the host. */
    s_clock_epoch_ms = (uint64_t)1785110400000ULL + (uint64_t)start_hour * 3600000ULL;
    fake_clock_set_epoch(s_clock_epoch_ms);
    fake_clock_set_synced(true);

    ui_time_source_t source = {.now = sim_time_now, .user_data = NULL};
    ui_time_source_set(&source);

    fake_store_seed();
    fake_ha_set_ready(false);

    lv_display_t *display = NULL;
    if (mode == SIM_MODE_DUMP) {
        display = sim_create_headless_display();
    } else {
#if LV_USE_SDL
        display = lv_sdl_window_create(SIM_HRES, SIM_VRES);
        if (display != NULL) {
            lv_sdl_window_set_title(display, "p4home pixel home");
            lv_sdl_mouse_create();
        }
#else
        fprintf(stderr, "built without SDL; use --mode dump\n");
        return 1;
#endif
    }
    if (display == NULL) {
        fprintf(stderr, "failed to create display\n");
        return 1;
    }

    if (verify_pet_autonomy && !sim_seed_non_living_human_before_ui()) {
        fprintf(stderr, "VERIFY:pet_autonomy:human_isolation:FAIL reason=seed_human_study\n");
        return 1;
    }

    if (ui_pages_render_bootstrap() != ESP_OK) {
        fprintf(stderr, "ui_pages_render_bootstrap failed\n");
        return 1;
    }

    if (verify_object_gate) {
        return sim_verify_object_gate();
    }
    if (verify_pet_autonomy) {
        return sim_verify_pet_autonomy();
    }
    if (verify_human_idle) {
        return sim_verify_human_idle_gate();
    }

    if (frames == 0) {
        frames = scenario ? fake_scenario_length_ticks() : 240U;
    }

    if (mode == SIM_MODE_DUMP) {
        char command[600];
        snprintf(command, sizeof(command), "mkdir -p '%s'", out_dir);
        if (system(command) != 0) {
            fprintf(stderr, "could not create %s\n", out_dir);
            return 1;
        }
        for (uint32_t frame = 0; frame < frames; ++frame) {
            if (scenario) {
                fake_scenario_step(frame);
            }
            sim_advance(UI_FX_TICK_MS);
            sim_write_snapshot(out_dir, frame);
        }
        printf("wrote %u frames to %s\n", (unsigned)frames, out_dir);
        return 0;
    }

    printf("SDL window mode. Close the window to exit.\n");
    for (uint32_t frame = 0;; ++frame) {
        if (scenario) {
            fake_scenario_step(frame);
        }
        sim_advance(UI_FX_TICK_MS);
        struct timespec sleep_for = {.tv_sec = 0, .tv_nsec = UI_FX_TICK_MS * 1000000L};
        nanosleep(&sleep_for, NULL);
    }
    return 0;
}
