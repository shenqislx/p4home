#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "lvgl.h"

#include "fake_backend.h"
#include "ui_home_actor.h"
#include "ui_home_actor_test.h"
#include "ui_pages.h"
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
        !sim_complete_object_action() || !sim_wait_for_actor(256U)) {
        fprintf(stderr, "VERIFY:phase3d:sim_object_anchor:FAIL reason=go_to_desk\n");
        return 1;
    }
    ui_home_actor_get_render_snapshot(&render);
    /* Study is the centre upper bay: origin (60,14), plus anchor (34,32). */
    if (render.art_x != 94 || render.floor_y != 46 ||
        render.facing != WORLD_OBJECT_FACING_LEFT ||
        strcmp(render.target_object_id, "study.desk") != 0) {
        fprintf(stderr, "VERIFY:phase3d:sim_object_anchor:FAIL reason=left_anchor\n");
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
    printf("VERIFY:phase3d:sim_cancel:PASS restored=sitting\n");
    printf("VERIFY:phase3d:sim_occupancy_conflict:PASS error=OBJECT_OCCUPIED\n");
    return 0;
}

static void sim_usage(const char *argv0)
{
    fprintf(stderr,
            "usage: %s [--mode window|dump] [--out DIR] [--frames N]\n"
            "          [--clock-speed N] [--start-hour H] [--scenario]\n"
            "          [--verify-object-gate]\n",
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

    if (ui_pages_render_bootstrap() != ESP_OK) {
        fprintf(stderr, "ui_pages_render_bootstrap failed\n");
        return 1;
    }

    if (verify_object_gate) {
        return sim_verify_object_gate();
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
