from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "agent/packages/contracts/src/conversation-ui-protocol.ts"
SERVICE_HEADER = ROOT / "firmware/components/conversation_service/include/conversation_service.h"
SERVICE_SOURCE = ROOT / "firmware/components/conversation_service/conversation_service.c"
VOICE_SOURCE = ROOT / "firmware/components/voice_transport/voice_transport.c"
ACTOR_SOURCE = ROOT / "firmware/components/ui_pages/ui_home_actor.c"
HOME_SOURCE = ROOT / "firmware/components/ui_pages/ui_page_home.c"
COORDINATOR = ROOT / "agent/apps/runtime/src/voice-interaction-coordinator.ts"
SERVER = ROOT / "agent/apps/runtime/src/voice-websocket-server.ts"
PRODUCT = ROOT / "agent/apps/runtime/src/product-voice-main.ts"
FONT_GENERATOR = ROOT / "scripts/generate-ui-cjk-font.py"


class Phase5EConversationUiContractTest(unittest.TestCase):
    def test_dialog_capacity_and_common_chinese_font_coverage(self) -> None:
        actor = ACTOR_SOURCE.read_text(encoding="utf-8")
        home = HOME_SOURCE.read_text(encoding="utf-8")
        generator_source = FONT_GENERATOR.read_text(encoding="utf-8")
        self.assertIn("UI_ACTOR_DIALOG_PAGE_MAX 224U", actor)
        self.assertIn("UI_HOME_HUD_DIALOG_ART_H 38", home)
        self.assertIn('"--bpp",\n        "2",', generator_source)

        spec = importlib.util.spec_from_file_location("ui_cjk_font_generator", FONT_GENERATOR)
        if spec is None or spec.loader is None:
            self.fail("could not load CJK font generator")
        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)
        symbols = generator.collect_symbols()
        self.assertGreaterEqual(len(symbols), 3755)
        self.assertTrue(set("智能助手可以理解复杂中文表达").issubset(symbols))
        self.assertTrue(set("，。！？；：、（）【】《》“”‘’—…·").issubset(symbols))

    def test_agent_and_firmware_share_strict_bounded_v1_contract(self) -> None:
        contract = CONTRACT.read_text(encoding="utf-8")
        header = SERVICE_HEADER.read_text(encoding="utf-8")
        voice = VOICE_SOURCE.read_text(encoding="utf-8")

        for expected in (
            "CONVERSATION_UI_PROTOCOL_VERSION 1U",
            "CONVERSATION_UI_USER_TEXT_MAX_CHARS 256U",
            "CONVERSATION_UI_USER_TEXT_MAX_BYTES 1024U",
            "CONVERSATION_UI_RESPONSE_TEXT_MAX_CHARS 512U",
            "CONVERSATION_UI_RESPONSE_TEXT_MAX_BYTES 2048U",
        ):
            self.assertIn(expected, header)
        self.assertIn("CONVERSATION_UI_PROTOCOL_VERSION = 1", contract)
        self.assertIn("CONVERSATION_UI_MAX_USER_CHARS = 256", contract)
        self.assertIn("CONVERSATION_UI_MAX_RESPONSE_CHARS = 512", contract)
        self.assertIn("cJSON_GetArraySize(root) != 11", voice)
        self.assertIn('strcmp(type->valuestring, "ui.update")', voice)

    def test_voice_ui_channel_is_display_only_and_stale_fenced(self) -> None:
        service = SERVICE_SOURCE.read_text(encoding="utf-8")
        actor = ACTOR_SOURCE.read_text(encoding="utf-8")
        home = HOME_SOURCE.read_text(encoding="utf-8")

        self.assertIn("update->revision <= current->revision", service)
        self.assertIn("update->stream_id != current->stream_id", service)
        self.assertIn("conversation_service_get_snapshot", home)
        self.assertIn("ui_home_actor_apply_conversation", home)
        self.assertIn("ui_pages_show_page_locked(UI_PAGES_PAGE_HOME)", home)
        conversation_render = actor.split(
            "void ui_home_actor_apply_conversation", 1
        )[1].split("void ui_home_actor_get_render_snapshot", 1)[0]
        self.assertNotIn("world_service_", conversation_render)
        self.assertNotIn("character.say", conversation_render)
        self.assertIn("VERIFY:phase5e:ui_conversation:PASS", conversation_render)
        self.assertIn("ui_home_actor_say(s_conversation_dialog, accent, false)", conversation_render)

    def test_ui_completion_waits_for_actual_render_ack_and_audio_can_be_deferred(self) -> None:
        service = SERVICE_SOURCE.read_text(encoding="utf-8")
        voice = VOICE_SOURCE.read_text(encoding="utf-8")
        coordinator = COORDINATOR.read_text(encoding="utf-8")
        server = SERVER.read_text(encoding="utf-8")

        self.assertIn("conversation_service_mark_rendered", service)
        self.assertIn("conversation_service_set_rendered_observer", voice)
        self.assertIn('cJSON_AddStringToObject(root, "type", "ui.applied")', voice)
        rendered_callback = voice.split(
            "static void voice_conversation_rendered", 1
        )[1].split("static esp_err_t voice_playback_send_json", 1)[0]
        self.assertIn("ui_ack_pending = true", rendered_callback)
        self.assertNotIn("voice_send_json", rendered_callback)
        self.assertIn("presentConversationUi", server)
        self.assertIn('return "deferred"', coordinator)
        self.assertIn('uiDelivery, "deferred"', coordinator)
        self.assertIn("ui_failed", coordinator)

    def test_voice_dialog_logging_excludes_transcript_and_response(self) -> None:
        actor = ACTOR_SOURCE.read_text(encoding="utf-8")
        private_branch = actor.split("if (log_text)", 1)[1].split("\n}", 1)[0]
        self.assertIn("voice dialog updated bytes=%u", private_branch)
        self.assertNotIn("s_conversation_dialog", private_branch)
        self.assertNotIn("response_text", private_branch)

    def test_product_entry_uses_real_dependencies_and_required_audio(self) -> None:
        product = PRODUCT.read_text(encoding="utf-8")
        package = (ROOT / "agent/package.json").read_text(encoding="utf-8")

        for expected in (
            "new OllamaHttpProvider",
            "new PythonSttProvider",
            "new PythonTtsProvider",
            "new RoleAwareTtsPipeline",
            "new RobotHaClient",
            "new SqliteAuditStore",
            "createPrivateRoleMemoryRuntime",
            'ui_output: "required"',
            'audio_output: "required"',
            "productionMemoryStoreOptions",
        ):
            self.assertIn(expected, product)
        self.assertIn('"start:voice"', package)
        self.assertNotIn("response.text", product)
        self.assertIn("deviceTokenBytes.fill(0)", product)
        self.assertIn("key.fill(0)", product)


if __name__ == "__main__":
    unittest.main()
