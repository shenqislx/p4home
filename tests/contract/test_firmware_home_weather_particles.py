from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
HOME_SOURCE = ROOT / "firmware" / "components" / "ui_pages" / "ui_page_home.c"
FX_HEADER = ROOT / "firmware" / "components" / "ui_pages" / "include" / "ui_pixel_fx.h"
PIXEL_ART_HEADER = (
    ROOT / "firmware" / "components" / "ui_pixel_art" / "include" / "ui_pixel_art.h"
)


def function_body(source: str, signature: str, next_signature: str) -> str:
    return source[source.index(signature) : source.index(next_signature)]


class FirmwareHomeWeatherParticleContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = HOME_SOURCE.read_text(encoding="utf-8")
        cls.reseed = function_body(
            cls.source,
            "static void ui_page_home_reseed_particle",
            "static void ui_page_home_apply_weather",
        )
        cls.weather = function_body(
            cls.source,
            "static void ui_page_home_apply_weather",
            "static bool ui_page_home_clock_tick",
        )
        cls.tick = function_body(
            cls.source,
            "static bool ui_page_home_particle_tick",
            "static bool ui_page_home_parallax_tick",
        )

    def test_particle_sprite_has_one_animation_owner(self) -> None:
        self.assertIn("UI_HOME_PARTICLE_FALLING", self.source)
        self.assertIn("UI_HOME_PARTICLE_SPLASH", self.source)
        self.assertIn("ui_home_particle_phase_t phase", self.source)
        self.assertIn("uint8_t splash_frame", self.source)
        self.assertNotIn("ui_pixel_fx_play_once", self.tick)

    def test_rain_splash_finishes_before_reseed_and_never_falls(self) -> None:
        splash = self.tick.split(
            "if (rain && particle->phase == UI_HOME_PARTICLE_SPLASH)", 1
        )[1].split("particle->art_y =", 1)[0]

        self.assertIn("particle->splash_frame + 1U < FX_SPLASH_FRAME_COUNT", splash)
        self.assertIn("s_splash_frames[particle->splash_frame]", splash)
        self.assertLess(
            splash.index("ui_pixel_fx_sprite_set_src(particle->sprite, s_rain_frames[0])"),
            splash.index("ui_page_home_reseed_particle(i)"),
        )
        reseed_branch = splash.split("} else {", 1)[1]
        self.assertLess(
            reseed_branch.index("ui_page_home_reseed_particle(i)"),
            reseed_branch.index("ui_pixel_fx_sprite_move"),
        )
        self.assertNotIn("LV_OBJ_FLAG_HIDDEN", reseed_branch)
        self.assertIn("continue;", splash)
        self.assertNotIn("ui_pixel_fx_sprite_move", splash.split("} else {", 1)[0])

    def test_landing_owns_splash_frame_and_snow_reseeds_directly(self) -> None:
        landing_tail = self.tick.split(
            "if (particle->art_y >= UI_HOME_SKY_ART_H - 2)", 1
        )[1]
        landing = landing_tail.split("} else if (rain)", 1)[0]

        self.assertIn("particle->phase = UI_HOME_PARTICLE_SPLASH", landing)
        self.assertIn("particle->splash_frame = 0", landing)
        self.assertIn("s_splash_frames[0]", landing)
        self.assertLess(
            landing.index("particle->art_y = UI_HOME_SKY_ART_H - 2"),
            landing.index("s_splash_frames[0]"),
        )
        self.assertIn("s_snow_frames[0]", landing)
        self.assertIn("ui_page_home_reseed_particle(i)", landing)
        tail_move = landing_tail.index("ui_pixel_fx_sprite_move(particle->sprite")
        self.assertLess(landing_tail.index("particle->art_y = UI_HOME_SKY_ART_H - 2"), tail_move)
        self.assertLess(landing_tail.index("s_splash_frames[0]"), tail_move)

    def test_reseed_and_weather_switch_clear_stale_splash_state(self) -> None:
        self.assertIn("particle->phase = UI_HOME_PARTICLE_FALLING", self.reseed)
        self.assertIn("particle->splash_frame = 0", self.reseed)
        self.assertIn("ui_page_home_reseed_particle(i)", self.weather)
        self.assertIn("weather == UI_HOME_WEATHER_RAIN ? s_rain_frames[0]", self.weather)
        self.assertIn(": s_snow_frames[0]", self.weather)
        activation = self.weather.split("if (particles_active)", 1)[1].split("} else {", 1)[0]
        self.assertLess(
            activation.index("ui_pixel_fx_sprite_set_src"),
            activation.index("ui_page_home_reseed_particle(i)"),
        )
        self.assertLess(
            activation.index("ui_page_home_reseed_particle(i)"),
            activation.index("ui_pixel_fx_sprite_move"),
        )
        self.assertLess(
            activation.index("ui_pixel_fx_sprite_move"),
            activation.index("lv_obj_clear_flag"),
        )

    def test_particle_resource_budget_remains_fixed(self) -> None:
        create_sky = function_body(
            self.source,
            "static esp_err_t ui_page_home_create_sky",
            "static esp_err_t ui_page_home_create_hud",
        )
        fx_header = FX_HEADER.read_text(encoding="utf-8")
        pixel_art_header = PIXEL_ART_HEADER.read_text(encoding="utf-8")
        register = self.source.split(
            "ui_pixel_fx_register(ui_page_home_particle_tick", 1
        )[1].split(";", 1)[0]

        self.assertIn("#define UI_HOME_PARTICLE_COUNT 12U", self.source)
        self.assertIn("#define UI_FX_TICK_MS 125U", fx_header)
        self.assertIn("#define FX_SPLASH_FRAME_COUNT 2", pixel_art_header)
        self.assertIn(", NULL, 1, 0)", register)
        self.assertEqual(1, create_sky.count("s_particles[i].sprite = ui_pixel_fx_sprite("))
        self.assertNotIn("splash_sprite", self.source)


if __name__ == "__main__":
    unittest.main()
