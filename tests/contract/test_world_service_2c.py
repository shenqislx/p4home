from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORLD_HEADER = ROOT / "firmware/components/world_service/include/world_service.h"
WORLD_SOURCE = ROOT / "firmware/components/world_service/world_service.c"
ACTOR_HEADER = ROOT / "firmware/components/ui_pages/include/ui_home_actor.h"
ACTOR_SOURCE = ROOT / "firmware/components/ui_pages/ui_home_actor.c"


class WorldServicePhase2CContractTests(unittest.TestCase):
    def test_firmware_world_ids_and_tools_match_frozen_v1_catalog(self) -> None:
        catalog = json.loads(
            (ROOT / "contracts/tools/v1/tool-catalog.json").read_text(encoding="utf-8")
        )
        header = WORLD_HEADER.read_text(encoding="utf-8")
        source = WORLD_SOURCE.read_text(encoding="utf-8")

        room_tokens = [
            "WORLD_ROOM_PRIMARY_BEDROOM",
            "WORLD_ROOM_STUDY",
            "WORLD_ROOM_GUEST_ROOM",
            "WORLD_ROOM_ENTRY",
            "WORLD_ROOM_LIVING_ROOM",
            "WORLD_ROOM_KITCHEN",
        ]
        tool_tokens = [
            "WORLD_ACTION_CHARACTER_GET_STATE",
            "WORLD_ACTION_CHARACTER_GO_TO_ROOM",
            "WORLD_ACTION_CHARACTER_SET_ACTIVITY",
            "WORLD_ACTION_CHARACTER_SAY",
            "WORLD_ACTION_GET_SNAPSHOT",
        ]
        self.assertEqual(
            [room["id"] for room in catalog["rooms"]],
            ["primary_bedroom", "study", "guest_room", "entry", "living_room", "kitchen"],
        )
        self.assertEqual(
            [tool["name"] for tool in catalog["tools"]],
            [
                "character.get_state",
                "character.go_to_room",
                "character.set_activity",
                "character.say",
                "world.get_snapshot",
            ],
        )
        for left, right in zip(room_tokens, room_tokens[1:]):
            self.assertLess(header.index(left), header.index(right))
        for left, right in zip(tool_tokens, tool_tokens[1:]):
            self.assertLess(header.index(left), header.index(right))
        for tool in (item["name"] for item in catalog["tools"]):
            self.assertIn(f'"{tool}"', source)

    def test_firmware_limits_match_frozen_v1_protocol(self) -> None:
        header = WORLD_HEADER.read_text(encoding="utf-8")
        self.assertRegex(header, r"WORLD_SERVICE_ACTION_QUEUE_CAPACITY\s+8U")
        self.assertRegex(header, r"WORLD_SERVICE_SAY_TEXT_MAX_CHARS\s+256U")
        self.assertRegex(header, r"WORLD_SERVICE_IDEMPOTENCY_RETENTION_MS\s+600000U")

    def test_actor_public_api_is_snapshot_only(self) -> None:
        header = ACTOR_HEADER.read_text(encoding="utf-8")
        source = ACTOR_SOURCE.read_text(encoding="utf-8")
        declarations = re.findall(r"^(?:esp_err_t|void|bool|size_t)\s+(ui_home_actor_\w+)\(",
                                  header, re.MULTILINE)
        self.assertEqual(
            declarations,
            [
                "ui_home_actor_create",
                "ui_home_actor_apply_snapshot",
                "ui_home_actor_apply_conversation",
                "ui_home_actor_create_dialog",
            ],
        )
        self.assertNotIn("world_service_apply_local_fallback", source)
        self.assertNotIn("panel_data_store", source)
        self.assertNotIn("ha_client", source)

    def test_actor_pages_full_v1_say_text_and_replays_equal_text(self) -> None:
        source = ACTOR_SOURCE.read_text(encoding="utf-8")
        self.assertRegex(
            source,
            r"UI_ACTOR_DIALOG_TEXT_MAX\s+\(CONVERSATION_UI_DIALOG_TEXT_MAX_BYTES \+ 1U\)",
        )
        self.assertIn("ui_home_actor_dialog_page_end", source)
        self.assertNotIn("strncmp(s_dialog_full", source)


if __name__ == "__main__":
    unittest.main()
