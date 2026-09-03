#include "ui_page_home.h"

#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "sdkconfig.h"
#include "conversation_service.h"
#include "ha_client.h"
#include "panel_data_store.h"
#include "ui_async.h"
#include "ui_fonts.h"
#include "ui_home_actor.h"
#include "ui_home_rooms.h"
#include "ui_pages.h"
#include "ui_pixel_art.h"
#include "ui_pixel_fx.h"
#include "ui_pixel_palette.h"
#include "ui_time_source.h"
#include "world_service.h"

static const char *TAG = "ui_home";

/* Layout in device pixels. The banner and navigation bar above are unchanged. */
#define UI_HOME_ROOT_X 40
#define UI_HOME_ROOT_Y 104
#define UI_HOME_ROOT_W 944
#define UI_HOME_ROOT_H 456

#define UI_HOME_SKY_H 96
#define UI_HOME_HOUSE_W (UI_PX(UI_HOME_HOUSE_ART_W))  /* 704 */
#define UI_HOME_HOUSE_H (UI_PX(UI_HOME_HOUSE_ART_H))  /* 360 */
#define UI_HOME_HUD_X 712
#define UI_HOME_HUD_W 232
#define UI_HOME_HUD_H 360

/* Sky band in art pixels: 236 x 24. */
#define UI_HOME_SKY_ART_W 236
#define UI_HOME_SKY_ART_H 24

#define UI_HOME_STAR_COUNT 9U
#define UI_HOME_CLOUD_COUNT 3U
#define UI_HOME_PARTICLE_COUNT 12U
#define UI_HOME_FOG_BAND_COUNT 3U
#define UI_HOME_HUD_DIALOG_ART_H 38

/* HH:MM drawn from hud_digits sprites. The bundled pixel fonts only carry the
 * CJK ranges they were generated for, and LVGL cannot scale a font, so a hero
 * clock has to be sprites if it is to sit on the same 4 px grid. */
#define UI_HOME_CLOCK_GLYPHS 5U
#define UI_HOME_CLOCK_COLON_INDEX 10U
#define UI_HOME_DIGIT_ART_W 7
#define UI_HOME_DIGIT_ADVANCE 8

typedef enum {
    UI_HOME_SKY_DAWN = 0,
    UI_HOME_SKY_DAY,
    UI_HOME_SKY_DUSK,
    UI_HOME_SKY_NIGHT,
} ui_home_sky_phase_t;

typedef enum {
    UI_HOME_WEATHER_CLEAR = 0,
    UI_HOME_WEATHER_CLOUDY,
    UI_HOME_WEATHER_RAIN,
    UI_HOME_WEATHER_SNOW,
    UI_HOME_WEATHER_FOG,
} ui_home_weather_t;

typedef enum {
    UI_HOME_PARTICLE_FALLING = 0,
    UI_HOME_PARTICLE_SPLASH,
} ui_home_particle_phase_t;

typedef struct {
    lv_obj_t *sprite;
    int16_t art_x;
    int16_t art_y;
    ui_home_particle_phase_t phase;
    uint8_t splash_frame;
} ui_home_particle_t;

static lv_obj_t *s_root;
static lv_obj_t *s_sky;
static lv_obj_t *s_sky_fill;
static lv_obj_t *s_hill_far;
static lv_obj_t *s_hill_near;
static lv_obj_t *s_sun;
static lv_obj_t *s_moon;
static lv_obj_t *s_clouds[UI_HOME_CLOUD_COUNT];
static lv_obj_t *s_fog_bands[UI_HOME_FOG_BAND_COUNT];
static lv_obj_t *s_stars[UI_HOME_STAR_COUNT];
static lv_obj_t *s_house;
static lv_obj_t *s_window_light;
static lv_obj_t *s_hud;
static lv_obj_t *s_hud_clock[UI_HOME_CLOCK_GLYPHS];
static lv_obj_t *s_hud_summary;
static lv_obj_t *s_hud_badge;
#if CONFIG_P4HOME_UI_PIXEL_CRT_OVERLAY
static lv_obj_t *s_crt_overlay;
#endif
static ui_home_particle_t s_particles[UI_HOME_PARTICLE_COUNT];

static portMUX_TYPE s_refresh_lock = portMUX_INITIALIZER_UNLOCKED;
static bool s_refresh_queued;
static bool s_conversation_show_queued;
static bool s_ready;
static conversation_snapshot_t s_conversation_snapshot;
static uint32_t s_world_local_conversation_revision;
static uint32_t s_world_conversation_epoch;
static uint32_t s_world_conversation_revision;
static ui_home_sky_phase_t s_sky_phase = UI_HOME_SKY_NIGHT;
static ui_home_weather_t s_weather = UI_HOME_WEATHER_CLEAR;
static bool s_night = true;
static int8_t s_window_light_hour = -1;
static uint8_t s_moon_phase;
static int16_t s_cloud_offset;
static int16_t s_hill_offset;

static const lv_image_dsc_t *const s_rain_frames[] = FX_RAIN_FRAMES;
static const lv_image_dsc_t *const s_splash_frames[] = FX_SPLASH_FRAMES;
static const lv_image_dsc_t *const s_snow_frames[] = FX_SNOW_FRAMES;
static const lv_image_dsc_t *const s_sun_frames[] = ENV_SUN_FRAMES;
static const lv_image_dsc_t *const s_moon_frames[] = ENV_MOON_FRAMES;
static const lv_image_dsc_t *const s_digit_frames[] = HUD_DIGITS_FRAMES;

/* Star positions in sky art pixels, spread so no two blink in the same column. */
static const int8_t s_star_art[UI_HOME_STAR_COUNT][2] = {
    {14, 4}, {38, 9}, {62, 3}, {90, 11}, {118, 6},
    {148, 2}, {176, 10}, {198, 5}, {222, 8},
};

static void ui_page_home_passive(lv_obj_t *object)
{
    if (object != NULL) {
        lv_obj_clear_flag(object, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    }
}

static lv_obj_t *ui_page_home_panel(lv_obj_t *parent, int32_t x, int32_t y,
                                    int32_t width, int32_t height, uint32_t colour)
{
    lv_obj_t *panel = lv_obj_create(parent);
    if (panel == NULL) {
        return NULL;
    }
    lv_obj_set_size(panel, width, height);
    lv_obj_set_pos(panel, x, y);
    lv_obj_set_style_bg_color(panel, lv_color_hex(colour), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(panel, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(panel, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(panel, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(panel, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(panel, 0, LV_PART_MAIN);
    ui_page_home_passive(panel);
    return panel;
}

/* --- Environment ---------------------------------------------------------- */

static const lv_image_dsc_t *ui_page_home_sky_src(ui_home_sky_phase_t phase)
{
    switch (phase) {
    case UI_HOME_SKY_DAWN:
        return &env_sky_dawn;
    case UI_HOME_SKY_DAY:
        return &env_sky_day;
    case UI_HOME_SKY_DUSK:
        return &env_sky_dusk;
    case UI_HOME_SKY_NIGHT:
    default:
        return &env_sky_night;
    }
}

static ui_home_sky_phase_t ui_page_home_phase_for_hour(int hour)
{
    if (hour >= 5 && hour < 8) {
        return UI_HOME_SKY_DAWN;
    }
    if (hour >= 8 && hour < 17) {
        return UI_HOME_SKY_DAY;
    }
    if (hour >= 17 && hour < 20) {
        return UI_HOME_SKY_DUSK;
    }
    return UI_HOME_SKY_NIGHT;
}

/* Lamp colour temperature drifts with the hour: yellow at dawn, white at noon,
 * orange at dusk. */
static uint32_t ui_page_home_window_tint(int hour)
{
    if (hour < 9) {
        return UI_PAL_LAMP_BASE;
    }
    if (hour < 15) {
        return UI_PAL_LAMP_HI;
    }
    if (hour < 19) {
        return UI_PAL_LAMP_LIGHT;
    }
    return UI_PAL_LAMP_DARK;
}

static void ui_page_home_apply_environment(void)
{
    struct tm local = {0};
    bool clock_ready = ui_time_source_local(&local);
    int hour = clock_ready ? local.tm_hour : 21;

    ui_home_sky_phase_t phase = ui_page_home_phase_for_hour(hour);
    s_night = (phase == UI_HOME_SKY_NIGHT);
    /* The visual falls back to a night sky before clock sync, but semantic
     * sleep must fail awake until local wall time is trustworthy. */
    (void)world_service_update_sleep_clock(clock_ready,
                                           clock_ready && s_night);

    if (phase != s_sky_phase) {
        /* One src swap for the whole band; the gradient itself is pre-dithered
         * because LVGL v9 has no runtime gradient dithering. */
        lv_obj_set_style_bg_image_src(s_sky_fill, ui_page_home_sky_src(phase), LV_PART_MAIN);
        s_sky_phase = phase;
    }

    /* This whole function runs once a second, so anything unconditional here is
     * an invalidation every second. LVGL style writes do not compare before
     * invalidating, so the guards have to be explicit. */
    static int8_t s_stars_night = -1;
    bool night_changed = (s_stars_night != (int8_t)s_night);
    if (night_changed) {
        s_stars_night = (int8_t)s_night;
        for (size_t i = 0; i < UI_HOME_STAR_COUNT; ++i) {
            if (s_stars[i] != NULL) {
                lv_obj_set_style_bg_opa(s_stars[i], s_night ? LV_OPA_COVER : LV_OPA_TRANSP,
                                        LV_PART_MAIN);
            }
        }
    }
    if (s_moon != NULL) {
        uint8_t moon_phase = 4U;
        if (ui_time_source_moon_phase(&moon_phase) && moon_phase != s_moon_phase) {
            ui_pixel_fx_sprite_set_src(s_moon, s_moon_frames[moon_phase % ENV_MOON_FRAME_COUNT]);
            s_moon_phase = moon_phase;
        }
        /* lv_obj_add_flag(LV_OBJ_FLAG_HIDDEN) invalidates unconditionally, so it
         * must not be called on every pass. */
        if (night_changed) {
            if (s_night) {
                lv_obj_clear_flag(s_moon, LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(s_moon, LV_OBJ_FLAG_HIDDEN);
            }
        }
    }
    if (s_sun != NULL) {
        /* Overcast hides the sun. A sun disc sitting behind falling rain is the
         * kind of detail that breaks the whole illusion. */
        bool sun_visible = !s_night && (s_weather == UI_HOME_WEATHER_CLEAR ||
                                        s_weather == UI_HOME_WEATHER_CLOUDY);
        static int8_t s_sun_shown = -1;
        if (s_sun_shown != (int8_t)sun_visible) {
            s_sun_shown = (int8_t)sun_visible;
            if (sun_visible) {
                lv_obj_clear_flag(s_sun, LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(s_sun, LV_OBJ_FLAG_HIDDEN);
            }
        }
        if (sun_visible) {
            /* Arc across the band between 06:00 and 19:00. */
            int32_t span = 13;
            int32_t progress = hour - 6;
            progress = progress < 0 ? 0 : (progress > span ? span : progress);
            int32_t art_x = 12 + (progress * (UI_HOME_SKY_ART_W - 30)) / span;
            int32_t rise = progress <= span / 2 ? progress : span - progress;
            int32_t art_y = 14 - rise * 2;
            ui_pixel_fx_sprite_move(s_sun, art_x, art_y < 1 ? 1 : art_y);
        }
    }

    /* Landscape and shell tint. Recolouring is a style write on an existing
     * object, so a phase change costs one invalidation per layer and no extra
     * art. Without it the hills stay midday-green against a night sky, which is
     * the single most obvious tell that the scene is faked.
     *
     * Tracked separately from s_sky_phase, which starts at NIGHT to match the
     * initial sky src: comparing against it would skip the very first tint pass
     * whenever the panel boots at night and leave the hills midday-green. */
    static int8_t s_tinted_phase = -1;
    bool tint_changed = (s_tinted_phase != (int8_t)phase);
    static const struct {
        uint32_t colour;
        lv_opa_t opa;
    } tint_by_phase[] = {
        [UI_HOME_SKY_DAWN] = {UI_PAL_SKY_DAWN_HI, LV_OPA_30},
        [UI_HOME_SKY_DAY] = {UI_PAL_SKY_DAY_HI, LV_OPA_TRANSP},
        [UI_HOME_SKY_DUSK] = {UI_PAL_SKY_DUSK_BASE, LV_OPA_50},
        [UI_HOME_SKY_NIGHT] = {UI_PAL_SKY_NIGHT_DARK, LV_OPA_80},
    };
    if (tint_changed) {
        s_tinted_phase = (int8_t)phase;
        lv_obj_t *const tinted[] = {s_hill_far, s_hill_near};
        for (size_t i = 0; i < sizeof(tinted) / sizeof(tinted[0]); ++i) {
            if (tinted[i] == NULL) {
                continue;
            }
            lv_obj_set_style_bg_image_recolor(tinted[i],
                                              lv_color_hex(tint_by_phase[phase].colour),
                                              LV_PART_MAIN);
            lv_obj_set_style_bg_image_recolor_opa(tinted[i], tint_by_phase[phase].opa,
                                                  LV_PART_MAIN);
            lv_obj_set_style_image_recolor(tinted[i],
                                           lv_color_hex(tint_by_phase[phase].colour),
                                           LV_PART_MAIN);
            lv_obj_set_style_image_recolor_opa(tinted[i], tint_by_phase[phase].opa,
                                               LV_PART_MAIN);
        }
        ui_home_rooms_set_shell_tint(tint_by_phase[phase].colour, tint_by_phase[phase].opa);

        /* Backdrop showing in the corners either side of the roof. It has to be
         * the tinted hillside tone rather than the shadow colour, otherwise the
         * roof is silhouetted against a black void that no other part of the
         * scene explains. Same mix the hill recolour applies, then darkened so
         * the backdrop always sits tonally behind the shell: at night both
         * converge on the sky colour and the roof would otherwise vanish. */
        if (s_house != NULL) {
            lv_color_t hill = lv_color_mix(lv_color_hex(tint_by_phase[phase].colour),
                                           lv_color_hex(UI_PAL_LEAF_DARK),
                                           tint_by_phase[phase].opa);
            lv_obj_set_style_bg_color(s_house, lv_color_darken(hill, LV_OPA_40),
                                      LV_PART_MAIN);
        }
    }

    /* Interior ambient follows the same phase. Daylight through the windows is
     * strong enough that an unlit room still reads as furnished; after dark the
     * same room drops to a silhouette, which is what makes turning a lamp on feel
     * like it did something. */
    static const ui_home_ambient_t ambient_by_phase[] = {
        [UI_HOME_SKY_DAWN] = {LV_OPA_70, UI_PAL_PANEL},
        [UI_HOME_SKY_DAY] = {LV_OPA_COVER, UI_PAL_PANEL_ALT},
        [UI_HOME_SKY_DUSK] = {LV_OPA_60, UI_PAL_PANEL},
        [UI_HOME_SKY_NIGHT] = {LV_OPA_30, UI_PAL_PANEL},
    };
    ui_home_rooms_set_ambient(&ambient_by_phase[phase]);

    /* The window light band only moves four times an hour, so it costs almost
     * nothing but sells the passage of time better than anything animated. */
    if (s_window_light != NULL && hour != s_window_light_hour) {
        s_window_light_hour = (int8_t)hour;
        bool visible = clock_ready && !s_night;
        if (visible) {
            lv_obj_clear_flag(s_window_light, LV_OBJ_FLAG_HIDDEN);
            int32_t step = ((hour - 6) * 4) % (UI_HOME_ROOM_ART_W - 26);
            if (step < 0) {
                step = 0;
            }
            lv_obj_set_pos(s_window_light,
                           UI_PX(UI_HOME_LOWER_ART_Y == 0 ? 0 : 62 + step),
                           UI_PX(UI_HOME_LOWER_ART_Y + UI_HOME_ROOM_ART_H - 8));
            lv_obj_set_style_bg_color(s_window_light,
                                      lv_color_hex(ui_page_home_window_tint(hour)),
                                      LV_PART_MAIN);
        } else {
            lv_obj_add_flag(s_window_light, LV_OBJ_FLAG_HIDDEN);
        }
    }

    /* Only the glyphs that changed get a new src, so a minute tick invalidates
     * two 28x44 rectangles rather than the whole HUD. */
    uint8_t glyphs[UI_HOME_CLOCK_GLYPHS] = {
        (uint8_t)(clock_ready ? local.tm_hour / 10 : 0),
        (uint8_t)(clock_ready ? local.tm_hour % 10 : 0),
        UI_HOME_CLOCK_COLON_INDEX,
        (uint8_t)(clock_ready ? local.tm_min / 10 : 0),
        (uint8_t)(clock_ready ? local.tm_min % 10 : 0),
    };
    static uint8_t s_shown_glyphs[UI_HOME_CLOCK_GLYPHS] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
    static int8_t s_shown_ready = -1;
    for (size_t i = 0; i < UI_HOME_CLOCK_GLYPHS; ++i) {
        if (s_hud_clock[i] == NULL) {
            continue;
        }
        if (s_shown_glyphs[i] != glyphs[i]) {
            s_shown_glyphs[i] = glyphs[i];
            ui_pixel_fx_sprite_set_src(s_hud_clock[i], s_digit_frames[glyphs[i]]);
        }
        if (s_shown_ready != (int8_t)clock_ready) {
            lv_obj_set_style_opa(s_hud_clock[i], clock_ready ? LV_OPA_COVER : LV_OPA_40,
                                 LV_PART_MAIN);
        }
    }
    s_shown_ready = (int8_t)clock_ready;
}

/* --- Weather ------------------------------------------------------------- */

static ui_home_weather_t ui_page_home_weather_from_text(const char *value_text)
{
    /* weather_service publishes "Today|<condition>|..." into a TEXT entity, so
     * the condition is the second pipe-delimited field. */
    const char *separator = strchr(value_text, '|');
    if (separator == NULL) {
        return UI_HOME_WEATHER_CLEAR;
    }
    separator++;
    if (strncmp(separator, "Rain", 4) == 0 || strncmp(separator, "Thunder", 7) == 0) {
        return UI_HOME_WEATHER_RAIN;
    }
    if (strncmp(separator, "Snow", 4) == 0) {
        return UI_HOME_WEATHER_SNOW;
    }
    if (strncmp(separator, "Fog", 3) == 0) {
        return UI_HOME_WEATHER_FOG;
    }
    if (strncmp(separator, "Cloudy", 6) == 0) {
        return UI_HOME_WEATHER_CLOUDY;
    }
    return UI_HOME_WEATHER_CLEAR;
}

static void ui_page_home_reseed_particle(size_t index)
{
    ui_home_particle_t *particle = &s_particles[index];
    if (particle->sprite == NULL) {
        return;
    }
    /* Deterministic spread instead of rand(): identical every run, which is what
     * makes simulator frame dumps comparable between builds. */
    particle->art_x = (int16_t)(4 + (index * 19U) % (UI_HOME_SKY_ART_W - 8));
    particle->art_y = (int16_t)(-(int16_t)((index * 7U) % UI_HOME_SKY_ART_H));
    particle->phase = UI_HOME_PARTICLE_FALLING;
    particle->splash_frame = 0;
}

static void ui_page_home_apply_weather(ui_home_weather_t weather)
{
    if (weather == s_weather) {
        return;
    }
    s_weather = weather;
    bool particles_active = (weather == UI_HOME_WEATHER_RAIN ||
                             weather == UI_HOME_WEATHER_SNOW);
    for (size_t i = 0; i < UI_HOME_PARTICLE_COUNT; ++i) {
        if (s_particles[i].sprite == NULL) {
            continue;
        }
        if (particles_active) {
            ui_pixel_fx_sprite_set_src(s_particles[i].sprite,
                             weather == UI_HOME_WEATHER_RAIN ? s_rain_frames[0]
                                                            : s_snow_frames[0]);
            ui_page_home_reseed_particle(i);
            ui_pixel_fx_sprite_move(s_particles[i].sprite, s_particles[i].art_x,
                                    s_particles[i].art_y);
            lv_obj_clear_flag(s_particles[i].sprite, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s_particles[i].sprite, LV_OBJ_FLAG_HIDDEN);
        }
    }

    /* Fog and heavy cloud dim the whole sky rather than adding objects. */
    lv_opa_t cloud_opa = LV_OPA_COVER;
    if (weather == UI_HOME_WEATHER_FOG) {
        cloud_opa = LV_OPA_40;
    } else if (weather == UI_HOME_WEATHER_CLEAR) {
        cloud_opa = LV_OPA_60;
    }
    for (size_t i = 0; i < UI_HOME_CLOUD_COUNT; ++i) {
        if (s_clouds[i] != NULL) {
            lv_obj_set_style_opa(s_clouds[i], cloud_opa, LV_PART_MAIN);
        }
    }

    for (size_t i = 0; i < UI_HOME_FOG_BAND_COUNT; ++i) {
        if (s_fog_bands[i] == NULL) {
            continue;
        }
        if (weather == UI_HOME_WEATHER_FOG) {
            lv_obj_clear_flag(s_fog_bands[i], LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s_fog_bands[i], LV_OBJ_FLAG_HIDDEN);
        }
    }
    ESP_LOGI(TAG, "weather effect -> %d", (int)weather);
}

/* Wall-clock effects are not driven by Home Assistant, so they need their own
 * heartbeat: without this the clock digits, sky phase, moon and window light only
 * change when an entity happens to update. Every 8 ticks is once a second, which
 * is the coarsest rate at which a minute rollover still looks immediate. */
static bool ui_page_home_clock_tick(uint32_t tick, void *user_data)
{
    (void)tick;
    (void)user_data;
    ui_home_sky_phase_t before = s_sky_phase;
    ui_page_home_apply_environment();
    /* Crossing into a new sky phase changes the interior ambient, so the rooms
     * have to be repainted even though no entity changed. */
    if (s_sky_phase != before) {
        for (size_t i = 0; i < UI_HOME_ROOM_COUNT; ++i) {
            ui_home_rooms_apply(i);
        }
    }
    return true;
}

/* Clear weather gets a breathing halo instead of particles: 4 dithered frames
 * ping-ponged so the sun never snaps back to frame 0. */
static bool ui_page_home_sun_tick(uint32_t tick, void *user_data)
{
    (void)user_data;
    if (s_sun == NULL || lv_obj_has_flag(s_sun, LV_OBJ_FLAG_HIDDEN)) {
        return true;
    }
    if (s_weather != UI_HOME_WEATHER_CLEAR) {
        return true;
    }
    static const uint8_t pingpong[] = {0, 1, 2, 3, 2, 1};
    uint8_t frame = pingpong[(tick / 4U) % (sizeof(pingpong) / sizeof(pingpong[0]))];
    ui_pixel_fx_sprite_set_src(s_sun, s_sun_frames[frame]);
    return true;
}

static bool ui_page_home_particle_tick(uint32_t tick, void *user_data)
{
    (void)user_data;
    if (s_weather != UI_HOME_WEATHER_RAIN && s_weather != UI_HOME_WEATHER_SNOW) {
        return true;
    }
    bool rain = (s_weather == UI_HOME_WEATHER_RAIN);
    /* Snow falls at half the rate and drifts sideways; rain falls straight and
     * fast, then splashes. */
    if (!rain && (tick % 2U) != 0U) {
        return true;
    }

    for (size_t i = 0; i < UI_HOME_PARTICLE_COUNT; ++i) {
        ui_home_particle_t *particle = &s_particles[i];
        if (particle->sprite == NULL) {
            continue;
        }

        /* A particle sprite has exactly one owner. Rain landing frames are
         * advanced here instead of handing the sprite to the generic one-shot
         * scheduler, which would otherwise race this loop's move/reseed. */
        if (rain && particle->phase == UI_HOME_PARTICLE_SPLASH) {
            if ((size_t)particle->splash_frame + 1U < FX_SPLASH_FRAME_COUNT) {
                particle->splash_frame++;
                ui_pixel_fx_sprite_set_src(particle->sprite,
                                           s_splash_frames[particle->splash_frame]);
            } else {
                ui_pixel_fx_sprite_set_src(particle->sprite, s_rain_frames[0]);
                ui_page_home_reseed_particle(i);
                ui_pixel_fx_sprite_move(particle->sprite, particle->art_x,
                                        particle->art_y);
            }
            continue;
        }

        particle->art_y = (int16_t)(particle->art_y + (rain ? 3 : 1));
        if (!rain) {
            /* Quantised sway: a smooth sine would be sub-pixel at this scale. */
            int8_t sway = ((tick / 4U + i) % 2U) ? 1 : -1;
            particle->art_x = (int16_t)(particle->art_x + sway);
        }

        if (particle->art_y >= UI_HOME_SKY_ART_H - 2) {
            if (rain) {
                particle->art_y = UI_HOME_SKY_ART_H - 2;
                particle->phase = UI_HOME_PARTICLE_SPLASH;
                particle->splash_frame = 0;
                ui_pixel_fx_sprite_set_src(particle->sprite, s_splash_frames[0]);
            } else {
                ui_pixel_fx_sprite_set_src(particle->sprite, s_snow_frames[0]);
                ui_page_home_reseed_particle(i);
            }
        } else if (rain) {
            ui_pixel_fx_sprite_set_src(particle->sprite, s_rain_frames[tick % FX_RAIN_FRAME_COUNT]);
        }
        ui_pixel_fx_sprite_move(particle->sprite, particle->art_x, particle->art_y);
    }
    return true;
}

static bool ui_page_home_parallax_tick(uint32_t tick, void *user_data)
{
    (void)tick;
    (void)user_data;
    /* Three layers at different rates. The far hills never move, which is what
     * gives the other two something to be parallax against. */
    s_cloud_offset = (int16_t)((s_cloud_offset + 1) % UI_HOME_SKY_ART_W);
    for (size_t i = 0; i < UI_HOME_CLOUD_COUNT; ++i) {
        if (s_clouds[i] == NULL) {
            continue;
        }
        int16_t base = (int16_t)(i * 74);
        int16_t art_x = (int16_t)((base + s_cloud_offset) % UI_HOME_SKY_ART_W);
        ui_pixel_fx_sprite_move(s_clouds[i], art_x, (int16_t)(3 + i * 4));
    }
    if (s_hill_near != NULL) {
        /* Scrolled by moving the whole (oversized) tiled panel one art pixel at
         * a time and wrapping at the tile width, so the seam never shows. */
        s_hill_offset = (int16_t)((s_hill_offset + 1) % 32);
        lv_obj_set_pos(s_hill_near, UI_PX(-s_hill_offset),
                       UI_PX(UI_HOME_SKY_ART_H - 10));
    }

    /* Fog drifts on the same slow beat, each band at its own rate so the layers
     * separate. Only three tiled panels, so it costs three moves per beat. */
    if (s_weather == UI_HOME_WEATHER_FOG) {
        for (size_t i = 0; i < UI_HOME_FOG_BAND_COUNT; ++i) {
            if (s_fog_bands[i] == NULL) {
                continue;
            }
            int16_t drift = (int16_t)((s_hill_offset * (int16_t)(i + 1)) % 16);
            lv_obj_set_pos(s_fog_bands[i], UI_PX(-drift),
                           UI_PX((int16_t)(6 + i * 5)));
        }
    }
    return true;
}

static bool ui_page_home_star_tick(uint32_t tick, void *user_data)
{
    (void)user_data;
    if (!s_night) {
        return true;
    }
    /* Each star has its own phase so the field twinkles instead of strobing. */
    for (size_t i = 0; i < UI_HOME_STAR_COUNT; ++i) {
        if (s_stars[i] == NULL) {
            continue;
        }
        bool bright = ((tick + i * 3U) % 6U) < 4U;
        lv_obj_set_style_bg_color(s_stars[i],
                                  lv_color_hex(bright ? UI_PAL_INK : UI_PAL_SKY_NIGHT_HI),
                                  LV_PART_MAIN);
    }
    return true;
}

/* --- Aggregation and refresh --------------------------------------------- */

static bool ui_page_home_collect(const panel_sensor_t *sensor, void *user_data)
{
    ui_home_summary_t *summary = (ui_home_summary_t *)user_data;
    if (sensor == NULL) {
        return true;
    }
    if (sensor->kind == PANEL_SENSOR_KIND_TEXT && strcmp(sensor->icon, "weather") == 0) {
        ui_page_home_apply_weather(ui_page_home_weather_from_text(sensor->value_text));
        return true;
    }
    ui_home_rooms_collect(sensor, summary);
    return true;
}

static void ui_page_home_apply_world(const ui_home_summary_t *summary)
{
    static const world_room_id_t world_rooms[UI_HOME_ROOM_COUNT] = {
        WORLD_ROOM_PRIMARY_BEDROOM,
        WORLD_ROOM_STUDY,
        WORLD_ROOM_GUEST_ROOM,
        WORLD_ROOM_ENTRY,
        WORLD_ROOM_LIVING_ROOM,
        WORLD_ROOM_KITCHEN,
    };
    world_local_fallback_context_t context = {
        .ha_connected = ha_client_ready(),
        .online_entities = summary->online,
        .lights_on_total = summary->lights_on,
        .climates_on_total = summary->climates_on,
    };
    for (size_t index = 0U; index < UI_HOME_ROOM_COUNT; ++index) {
        world_room_id_t room = world_rooms[index];
        context.room_lit[room] = ui_home_room_is_lit(index);
        context.room_climate_on[room] = ui_home_room_has_climate_on(index);
    }
    (void)world_service_apply_local_fallback(&context);

    world_service_snapshot_t snapshot = {0};
    world_service_get_snapshot(&snapshot);
    ui_home_actor_apply_snapshot(&snapshot);
}

static void ui_page_home_apply_hud(const ui_home_summary_t *summary)
{
    bool connected = ha_client_ready();

    char text[96];
    snprintf(text, sizeof(text), "灯 %02u/%02u\n空调 %02u\n在线 %02u/%02u",
             (unsigned)summary->lights_on, (unsigned)summary->lights_total,
             (unsigned)summary->climates_on,
             (unsigned)summary->online, (unsigned)summary->entities);
    lv_label_set_text(s_hud_summary, text);

    lv_label_set_text(s_hud_badge, connected ? "ONLINE" : "LINKING");
    lv_obj_set_style_text_color(s_hud_badge,
                                lv_color_hex(connected ? UI_PAL_ACCENT_CYAN
                                                       : UI_PAL_LAMP_LIGHT),
                                LV_PART_MAIN);
}

/* Conversation rendering remains display-only. This page-level bridge records
 * Human activity in World without allowing transcript content into World/Cat. */
static void ui_page_home_apply_conversation_presence(
    const conversation_snapshot_t *snapshot)
{
    if (snapshot->local_stage != CONVERSATION_LOCAL_STAGE_IDLE) {
        if (snapshot->local_revision != s_world_local_conversation_revision) {
            (void)world_service_set_user_interaction_active(true);
            s_world_local_conversation_revision = snapshot->local_revision;
        }
        return;
    }
    if (!snapshot->available) {
        (void)world_service_set_user_interaction_active(false);
        return;
    }

    const conversation_update_t *update = &snapshot->update;
    bool active = update->stage == CONVERSATION_STAGE_LISTENING ||
                  update->stage == CONVERSATION_STAGE_TRANSCRIBING ||
                  update->stage == CONVERSATION_STAGE_THINKING;
    bool new_revision = update->epoch != s_world_conversation_epoch ||
                        update->revision != s_world_conversation_revision;
    if (new_revision) {
        (void)world_service_note_user_interaction();
        s_world_conversation_epoch = update->epoch;
        s_world_conversation_revision = update->revision;
    }
    (void)world_service_set_user_interaction_active(active);
}

static void ui_page_home_refresh_locked(void)
{
    if (!s_ready && s_root == NULL) {
        return;
    }
    ui_home_summary_t summary = {0};
    ui_home_rooms_reset_aggregates();
    panel_data_store_iterate(ui_page_home_collect, &summary);

    ui_page_home_apply_environment();
    for (size_t i = 0; i < UI_HOME_ROOM_COUNT; ++i) {
        ui_home_rooms_apply(i);
    }
    ui_page_home_apply_world(&summary);
    conversation_service_get_snapshot(&s_conversation_snapshot);
    ui_page_home_apply_conversation_presence(&s_conversation_snapshot);
    ui_home_actor_apply_conversation(&s_conversation_snapshot);
    ui_page_home_apply_hud(&summary);
}

static void ui_page_home_refresh_async(void *user_data)
{
    (void)user_data;
    portENTER_CRITICAL(&s_refresh_lock);
    s_refresh_queued = false;
    portEXIT_CRITICAL(&s_refresh_lock);
    ui_page_home_refresh_locked();
}

static void ui_page_home_queue_refresh(void)
{
    bool should_queue = false;
    portENTER_CRITICAL(&s_refresh_lock);
    if (!s_refresh_queued) {
        s_refresh_queued = true;
        should_queue = true;
    }
    portEXIT_CRITICAL(&s_refresh_lock);
    if (should_queue && ui_async_call(ui_page_home_refresh_async, NULL) != LV_RESULT_OK) {
        portENTER_CRITICAL(&s_refresh_lock);
        s_refresh_queued = false;
        portEXIT_CRITICAL(&s_refresh_lock);
    }
}

static void ui_page_home_store_observer(const panel_sensor_t *sensor, void *user_data)
{
    (void)user_data;
    if (sensor == NULL) {
        return;
    }
    if (sensor->kind != PANEL_SENSOR_KIND_BINARY &&
        sensor->kind != PANEL_SENSOR_KIND_CLIMATE &&
        sensor->kind != PANEL_SENSOR_KIND_TEXT) {
        return;
    }
    ui_page_home_queue_refresh();
}

static void ui_page_home_world_observer(const world_service_snapshot_t *snapshot,
                                        void *user_data)
{
    (void)user_data;
    if (snapshot != NULL) {
        ui_page_home_queue_refresh();
    }
}

static void ui_page_home_conversation_async(void *user_data)
{
    (void)user_data;
    portENTER_CRITICAL(&s_refresh_lock);
    s_conversation_show_queued = false;
    portEXIT_CRITICAL(&s_refresh_lock);
    if (ui_pages_current_page() == UI_PAGES_PAGE_HOME) {
        ui_page_home_refresh_locked();
    } else {
        ui_pages_show_page_locked(UI_PAGES_PAGE_HOME);
    }
}

static void ui_page_home_conversation_observer(void *user_data)
{
    (void)user_data;
    bool should_queue = false;
    portENTER_CRITICAL(&s_refresh_lock);
    if (!s_conversation_show_queued) {
        s_conversation_show_queued = true;
        should_queue = true;
    }
    portEXIT_CRITICAL(&s_refresh_lock);
    if (should_queue && ui_async_call(ui_page_home_conversation_async, NULL) != LV_RESULT_OK) {
        portENTER_CRITICAL(&s_refresh_lock);
        s_conversation_show_queued = false;
        portEXIT_CRITICAL(&s_refresh_lock);
    }
}

/* --- Events --------------------------------------------------------------- */

static void ui_page_home_room_event(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
        return;
    }
    size_t index = (size_t)(uintptr_t)lv_event_get_user_data(event);
    const ui_home_room_def_t *def = ui_home_room_def(index);
    if (def == NULL) {
        return;
    }
    const ui_home_room_state_t *state = ui_home_room_state(index);
    ui_pages_page_t target = (state != NULL && state->climate_total > 0U)
                                 ? UI_PAGES_PAGE_CLIMATE
                                 : UI_PAGES_PAGE_DASHBOARD;

    ESP_LOGW(TAG, "VERIFY:ui:pixel_room:PASS room=%s target=%s", def->title,
             ui_pages_page_to_text(target));
    ui_pages_show_page_locked(target);
}

/* --- Construction --------------------------------------------------------- */

static esp_err_t ui_page_home_create_sky(lv_obj_t *parent)
{
    s_sky = ui_page_home_panel(parent, 0, 0, UI_HOME_ROOT_W, UI_HOME_SKY_H,
                               UI_PAL_SKY_NIGHT_BASE);
    ESP_RETURN_ON_FALSE(s_sky != NULL, ESP_ERR_NO_MEM, TAG, "sky alloc failed");
    lv_obj_set_style_clip_corner(s_sky, true, LV_PART_MAIN);

    /* The gradient is a 4 px wide tile stretched across the band, so a whole
     * dithered sky costs 288 bytes of flash. */
    s_sky_fill = ui_page_home_panel(s_sky, 0, 0, UI_HOME_ROOT_W, UI_HOME_SKY_H,
                                    UI_PAL_SKY_NIGHT_BASE);
    ESP_RETURN_ON_FALSE(s_sky_fill != NULL, ESP_ERR_NO_MEM, TAG, "sky fill alloc failed");
    lv_obj_set_style_bg_image_src(s_sky_fill, &env_sky_night, LV_PART_MAIN);
    lv_obj_set_style_bg_image_tiled(s_sky_fill, true, LV_PART_MAIN);

    for (size_t i = 0; i < UI_HOME_STAR_COUNT; ++i) {
        s_stars[i] = ui_page_home_panel(s_sky, UI_PX(s_star_art[i][0]),
                                        UI_PX(s_star_art[i][1]), UI_PX(1), UI_PX(1),
                                        UI_PAL_INK);
        ESP_RETURN_ON_FALSE(s_stars[i] != NULL, ESP_ERR_NO_MEM, TAG, "star alloc failed");
    }

    s_moon = ui_pixel_fx_sprite(s_sky, &env_moon_4, UI_HOME_SKY_ART_W - 26, 3);
    ESP_RETURN_ON_FALSE(s_moon != NULL, ESP_ERR_NO_MEM, TAG, "moon alloc failed");

    s_sun = ui_pixel_fx_sprite(s_sky, &env_sun_0, 20, 4);
    ESP_RETURN_ON_FALSE(s_sun != NULL, ESP_ERR_NO_MEM, TAG, "sun alloc failed");
    lv_obj_add_flag(s_sun, LV_OBJ_FLAG_HIDDEN);

    for (size_t i = 0; i < UI_HOME_CLOUD_COUNT; ++i) {
        s_clouds[i] = ui_pixel_fx_sprite(s_sky, &env_cloud, (int32_t)(i * 74),
                                         (int32_t)(3 + i * 4));
        ESP_RETURN_ON_FALSE(s_clouds[i] != NULL, ESP_ERR_NO_MEM, TAG, "cloud alloc failed");
    }

    /* Far hills are a single static sprite; near hills tile and scroll. */
    s_hill_far = ui_pixel_fx_sprite(s_sky, &env_hill, 40, UI_HOME_SKY_ART_H - 10);
    ESP_RETURN_ON_FALSE(s_hill_far != NULL, ESP_ERR_NO_MEM, TAG, "far hill alloc failed");
    lv_obj_set_style_opa(s_hill_far, LV_OPA_60, LV_PART_MAIN);

    s_hill_near = ui_page_home_panel(s_sky, 0, UI_PX(UI_HOME_SKY_ART_H - 10),
                                     UI_HOME_ROOT_W + UI_PX(32), UI_PX(10),
                                     UI_PAL_LEAF_DARK);
    ESP_RETURN_ON_FALSE(s_hill_near != NULL, ESP_ERR_NO_MEM, TAG, "near hill alloc failed");
    lv_obj_set_style_bg_image_src(s_hill_near, &env_hill_near, LV_PART_MAIN);
    lv_obj_set_style_bg_image_tiled(s_hill_near, true, LV_PART_MAIN);

    /* Fog is three drifting dithered bands rather than particles: fog has no
     * discrete elements to animate, and a translucent tiled band is both cheaper
     * and a better read than a cloud of sprites. */
    for (size_t i = 0; i < UI_HOME_FOG_BAND_COUNT; ++i) {
        s_fog_bands[i] = ui_page_home_panel(s_sky, 0, UI_PX(6 + (int32_t)i * 5),
                                            UI_HOME_ROOT_W + UI_PX(16), UI_PX(3),
                                            UI_PAL_SKY_DAY_HI);
        ESP_RETURN_ON_FALSE(s_fog_bands[i] != NULL, ESP_ERR_NO_MEM, TAG,
                            "fog band alloc failed");
        lv_obj_set_style_bg_image_src(s_fog_bands[i], &fx_scanline, LV_PART_MAIN);
        lv_obj_set_style_bg_image_tiled(s_fog_bands[i], true, LV_PART_MAIN);
        lv_obj_set_style_bg_opa(s_fog_bands[i], (lv_opa_t)(LV_OPA_50 - i * 10U),
                                LV_PART_MAIN);
        lv_obj_add_flag(s_fog_bands[i], LV_OBJ_FLAG_HIDDEN);
    }

    for (size_t i = 0; i < UI_HOME_PARTICLE_COUNT; ++i) {
        s_particles[i].sprite = ui_pixel_fx_sprite(s_sky, &fx_rain_0, 0, 0);
        ESP_RETURN_ON_FALSE(s_particles[i].sprite != NULL, ESP_ERR_NO_MEM, TAG,
                            "particle alloc failed");
        lv_obj_add_flag(s_particles[i].sprite, LV_OBJ_FLAG_HIDDEN);
        ui_page_home_reseed_particle(i);
    }
    return ESP_OK;
}

static esp_err_t ui_page_home_create_hud(lv_obj_t *parent)
{
    s_hud = ui_page_home_panel(parent, UI_HOME_HUD_X, UI_HOME_SKY_H, UI_HOME_HUD_W,
                               UI_HOME_HUD_H, UI_PAL_PANEL);
    ESP_RETURN_ON_FALSE(s_hud != NULL, ESP_ERR_NO_MEM, TAG, "hud alloc failed");
    lv_obj_set_style_border_width(s_hud, UI_PX(1), LV_PART_MAIN);
    lv_obj_set_style_border_color(s_hud, lv_color_hex(UI_PAL_GRID), LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_hud, UI_PX(3), LV_PART_MAIN);

    for (size_t i = 0; i < UI_HOME_CLOCK_GLYPHS; ++i) {
        s_hud_clock[i] = ui_pixel_fx_sprite(s_hud, s_digit_frames[0],
                                            (int32_t)(i * UI_HOME_DIGIT_ADVANCE), 0);
        ESP_RETURN_ON_FALSE(s_hud_clock[i] != NULL, ESP_ERR_NO_MEM, TAG,
                            "clock glyph alloc failed");
    }

    s_hud_badge = lv_label_create(s_hud);
    ESP_RETURN_ON_FALSE(s_hud_badge != NULL, ESP_ERR_NO_MEM, TAG, "badge alloc failed");
    lv_label_set_text(s_hud_badge, "LINKING");
    lv_obj_set_style_text_font(s_hud_badge, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_hud_badge, lv_color_hex(UI_PAL_LAMP_LIGHT), LV_PART_MAIN);
    lv_obj_set_pos(s_hud_badge, 0, UI_PX(14));

    s_hud_summary = lv_label_create(s_hud);
    ESP_RETURN_ON_FALSE(s_hud_summary != NULL, ESP_ERR_NO_MEM, TAG, "summary alloc failed");
    lv_label_set_text(s_hud_summary, "灯 --/--\n空调 --\n在线 --/--");
    lv_obj_set_style_text_font(s_hud_summary, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_hud_summary, lv_color_hex(UI_PAL_INK), LV_PART_MAIN);
    lv_obj_set_style_text_line_space(s_hud_summary, UI_PX(1), LV_PART_MAIN);
    lv_obj_set_pos(s_hud_summary, 0, UI_PX(21));

    ESP_RETURN_ON_ERROR(ui_home_actor_create_dialog(s_hud, 52, UI_HOME_HUD_DIALOG_ART_H),
                        TAG, "dialog create failed");
    lv_obj_align(lv_obj_get_child(s_hud, -1), LV_ALIGN_BOTTOM_LEFT, 0, 0);
    return ESP_OK;
}

esp_err_t ui_page_home_init(void)
{
    lv_obj_t *screen = lv_screen_active();
    ESP_RETURN_ON_FALSE(screen != NULL, ESP_ERR_INVALID_STATE, TAG, "no active screen");
    ESP_RETURN_ON_ERROR(world_service_init(NULL), TAG, "world service init failed");
    ESP_RETURN_ON_ERROR(conversation_service_init(), TAG,
                        "conversation service init failed");

    s_root = ui_page_home_panel(screen, UI_HOME_ROOT_X, UI_HOME_ROOT_Y,
                                UI_HOME_ROOT_W, UI_HOME_ROOT_H, UI_PAL_SCREEN);
    ESP_RETURN_ON_FALSE(s_root != NULL, ESP_ERR_NO_MEM, TAG, "home root alloc failed");

    ESP_RETURN_ON_ERROR(ui_pixel_fx_init(), TAG, "fx init failed");
    ESP_RETURN_ON_ERROR(ui_page_home_create_sky(s_root), TAG, "sky create failed");

    s_house = ui_page_home_panel(s_root, 0, UI_HOME_SKY_H, UI_HOME_HOUSE_W,
                                 UI_HOME_HOUSE_H, UI_PAL_SHADOW);
    ESP_RETURN_ON_FALSE(s_house != NULL, ESP_ERR_NO_MEM, TAG, "house alloc failed");

    ESP_RETURN_ON_ERROR(ui_home_rooms_create(s_house, ui_page_home_room_event), TAG,
                        "rooms create failed");

    /* Daylight cast onto the living-room floor. Sized in art pixels, moved on
     * the hour, hidden at night. */
    s_window_light = ui_page_home_panel(s_house, UI_PX(62),
                                        UI_PX(UI_HOME_LOWER_ART_Y + UI_HOME_ROOM_ART_H - 8),
                                        UI_PX(22), UI_PX(4), UI_PAL_LAMP_HI);
    ESP_RETURN_ON_FALSE(s_window_light != NULL, ESP_ERR_NO_MEM, TAG,
                        "window light alloc failed");
    /* Dithered rather than a flat wash: a solid band reads as a shelf, the
     * scanline tile reads as light falling through glass. */
    lv_obj_set_style_bg_image_src(s_window_light, &fx_scanline, LV_PART_MAIN);
    lv_obj_set_style_bg_image_tiled(s_window_light, true, LV_PART_MAIN);
    lv_obj_set_style_bg_image_recolor_opa(s_window_light, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_window_light, LV_OPA_50, LV_PART_MAIN);
    lv_obj_add_flag(s_window_light, LV_OBJ_FLAG_HIDDEN);

    ESP_RETURN_ON_ERROR(ui_home_actor_create(s_house), TAG, "actor create failed");
    ESP_RETURN_ON_ERROR(ui_page_home_create_hud(s_root), TAG, "hud create failed");

#if CONFIG_P4HOME_UI_PIXEL_CRT_OVERLAY
    /* Fully static scanline and vignette layer. Costs one draw at creation and
     * nothing afterwards, and it is the single highest-yield change for making
     * the page read as a game screen rather than a widget dashboard. */
    s_crt_overlay = ui_page_home_panel(s_root, 0, 0, UI_HOME_ROOT_W, UI_HOME_ROOT_H,
                                       UI_PAL_SHADOW);
    ESP_RETURN_ON_FALSE(s_crt_overlay != NULL, ESP_ERR_NO_MEM, TAG, "crt alloc failed");
    lv_obj_set_style_bg_opa(s_crt_overlay, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_bg_image_src(s_crt_overlay, &fx_scanline, LV_PART_MAIN);
    lv_obj_set_style_bg_image_tiled(s_crt_overlay, true, LV_PART_MAIN);
    lv_obj_add_flag(s_crt_overlay, LV_OBJ_FLAG_IGNORE_LAYOUT);
    ui_page_home_passive(s_crt_overlay);
#endif

    ESP_RETURN_ON_ERROR(ui_pixel_fx_register(ui_page_home_particle_tick, NULL, 1, 0), TAG,
                        "particle tick failed");
    ESP_RETURN_ON_ERROR(ui_pixel_fx_register(ui_page_home_parallax_tick, NULL, 8, 1), TAG,
                        "parallax tick failed");
    ESP_RETURN_ON_ERROR(ui_pixel_fx_register(ui_page_home_star_tick, NULL, 4, 2), TAG,
                        "star tick failed");
    ESP_RETURN_ON_ERROR(ui_pixel_fx_register(ui_page_home_sun_tick, NULL, 4, 3), TAG,
                        "sun tick failed");
    ESP_RETURN_ON_ERROR(ui_pixel_fx_register(ui_page_home_clock_tick, NULL, 8, 5), TAG,
                        "clock tick failed");

    ESP_RETURN_ON_ERROR(panel_data_store_add_observer(ui_page_home_store_observer, NULL),
                        TAG, "failed to attach home observer");
    ESP_RETURN_ON_ERROR(world_service_add_observer(ui_page_home_world_observer, NULL),
                        TAG, "failed to attach world observer");
    ESP_RETURN_ON_ERROR(conversation_service_add_observer(
                            ui_page_home_conversation_observer, NULL),
                        TAG, "failed to attach conversation observer");

    s_ready = true;
    ui_page_home_refresh_locked();
    ESP_LOGW(TAG, "VERIFY:ui:pixel_home:PASS rooms=%u groups=12 grid=%upx",
             (unsigned)UI_HOME_ROOM_COUNT, (unsigned)UI_PX_SCALE);
    return ESP_OK;
}

void ui_page_home_show(void)
{
    if (s_root != NULL) {
        lv_obj_clear_flag(s_root, LV_OBJ_FLAG_HIDDEN);
        ui_pixel_fx_set_active(true);
        ui_page_home_refresh_locked();
    }
}

lv_obj_t *ui_page_home_root(void)
{
    return s_root;
}

bool ui_page_home_ready(void)
{
    return s_ready;
}
