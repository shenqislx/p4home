from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORLD_CONTRACT = ROOT / "contracts/world/v1"
REGISTRY_PATH = WORLD_CONTRACT / "object-registry.json"
SCHEMA_PATH = WORLD_CONTRACT / "object-registry.schema.json"
REGISTRY_HEADER = (
    ROOT / "firmware/components/world_service/include/world_object_registry.h"
)
REGISTRY_SOURCE = ROOT / "firmware/components/world_service/world_object_registry.c"
AGENT_SOURCE = ROOT / "agent/packages/contracts/src/world-object-registry.ts"


ROOM_ENUMS = {
    "primary_bedroom": "WORLD_ROOM_PRIMARY_BEDROOM",
    "study": "WORLD_ROOM_STUDY",
    "guest_room": "WORLD_ROOM_GUEST_ROOM",
    "entry": "WORLD_ROOM_ENTRY",
    "living_room": "WORLD_ROOM_LIVING_ROOM",
    "kitchen": "WORLD_ROOM_KITCHEN",
}
ACTION_ENUMS = {
    "go_to": "WORLD_OBJECT_ACTION_GO_TO",
    "sit": "WORLD_OBJECT_ACTION_SIT",
    "look_at": "WORLD_OBJECT_ACTION_LOOK_AT",
    "interact": "WORLD_OBJECT_ACTION_INTERACT",
}
ANIMATION_ENUMS = {
    "cat_walk": "WORLD_OBJECT_ANIMATION_CAT_WALK",
    "cat_sit": "WORLD_OBJECT_ANIMATION_CAT_SIT",
    "cat_look": "WORLD_OBJECT_ANIMATION_CAT_LOOK",
    "cat_paw": "WORLD_OBJECT_ANIMATION_CAT_PAW",
}


class WorldObjectRegistryPhase3AContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
        self.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_registry_identity_ids_and_anchors_are_stable(self) -> None:
        readme = (WORLD_CONTRACT / "README.md").read_text(encoding="utf-8")
        self.assertIn("> Status: frozen for Phase 3A", readme)
        self.assertEqual(1, self.registry["schema_version"])
        self.assertEqual("p4home.object-registry/v1", self.registry["registry_id"])
        self.assertEqual("p4home.room-art/v1", self.registry["coordinate_space"])
        self.assertEqual(
            ["living_room.sofa", "study.desk", "living_room.window"],
            [item["object_id"] for item in self.registry["objects"]],
        )

        ids: set[str] = set()
        anchors: set[tuple[str, int, int]] = set()
        for item in self.registry["objects"]:
            self.assertNotIn(item["object_id"], ids)
            ids.add(item["object_id"])
            self.assertTrue(item["object_id"].startswith(f'{item["room_id"]}.'))
            anchor = item["anchor"]
            self.assertGreaterEqual(anchor["art_x"], 0)
            self.assertLessEqual(anchor["art_x"], 48)
            self.assertGreaterEqual(anchor["floor_y"], 0)
            self.assertLessEqual(anchor["floor_y"], 34)
            anchor_key = (item["room_id"], anchor["art_x"], anchor["floor_y"])
            self.assertNotIn(anchor_key, anchors)
            anchors.add(anchor_key)
            self.assertEqual("go_to", item["supported_actions"][0])
            self.assertEqual(
                set(item["supported_actions"]), set(item["animation_bindings"])
            )

    def test_schema_and_registry_share_room_and_action_sets(self) -> None:
        definitions = self.schema["$defs"]
        self.assertEqual(list(ROOM_ENUMS), definitions["roomId"]["enum"])
        self.assertEqual(list(ACTION_ENUMS), definitions["objectAction"]["enum"])
        self.assertEqual(list(ANIMATION_ENUMS), definitions["animationBinding"]["enum"])
        objects_schema = self.schema["properties"]["objects"]
        self.assertEqual(len(self.registry["objects"]), objects_schema["minItems"])
        self.assertEqual(len(self.registry["objects"]), objects_schema["maxItems"])

    def test_firmware_registry_matches_json_contract(self) -> None:
        header = REGISTRY_HEADER.read_text(encoding="utf-8")
        source = REGISTRY_SOURCE.read_text(encoding="utf-8")
        capacity = len(self.registry["objects"])
        self.assertRegex(
            header, rf"WORLD_OBJECT_REGISTRY_CAPACITY\s+{capacity}U"
        )

        positions = [source.index(f'"{item["object_id"]}"') for item in self.registry["objects"]]
        self.assertEqual(sorted(positions), positions)
        for index, item in enumerate(self.registry["objects"]):
            start = positions[index]
            end = positions[index + 1] if index + 1 < len(positions) else source.index("};", start)
            block = source[start:end]
            self.assertIn(f'.room = {ROOM_ENUMS[item["room_id"]]}', block)
            self.assertIn(f'.anchor_art_x = {item["anchor"]["art_x"]}', block)
            self.assertIn(f'.anchor_floor_y = {item["anchor"]["floor_y"]}', block)
            self.assertIn(
                f'WORLD_OBJECT_FACING_{item["anchor"]["facing"].upper()}', block
            )
            for action, action_enum in ACTION_ENUMS.items():
                action_mask = f"WORLD_OBJECT_ACTION_MASK({action_enum})"
                binding_prefix = f"[{action_enum}] ="
                if action in item["supported_actions"]:
                    expected_animation = ANIMATION_ENUMS[
                        item["animation_bindings"][action]
                    ]
                    self.assertIn(action_mask, block)
                    self.assertIn(
                        f"[{action_enum}] = {expected_animation}", block
                    )
                else:
                    self.assertNotIn(action_mask, block)
                    self.assertNotIn(binding_prefix, block)

    def test_agent_projection_explicitly_omits_execution_metadata(self) -> None:
        source = AGENT_SOURCE.read_text(encoding="utf-8")
        projection_start = source.index("export function projectWorldObjectCapabilities")
        projection = source[projection_start:]
        self.assertIn("object_id: object.object_id", projection)
        self.assertIn("available: liveAvailability.get(object.object_id)!", projection)
        self.assertNotIn("anchor:", projection)
        self.assertNotIn("animation_bindings:", projection)
        self.assertNotIn("export function getWorldObjectRegistry", source)
        self.assertNotIn("export function parseWorldObjectRegistry", source)

    def test_phase_3_evidence_markdown_is_not_globally_ignored(self) -> None:
        gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("!evidence/agent-phase-3/", gitignore)
        self.assertIn("!evidence/agent-phase-3/*.md", gitignore)

    def test_frozen_v1_tools_are_not_expanded_by_phase_3a(self) -> None:
        catalog = json.loads(
            (ROOT / "contracts/tools/v1/tool-catalog.json").read_text(encoding="utf-8")
        )
        names = [tool["name"] for tool in catalog["tools"]]
        self.assertEqual(
            [
                "character.get_state",
                "character.go_to_room",
                "character.set_activity",
                "character.say",
                "world.get_snapshot",
            ],
            names,
        )
        self.assertFalse(any(name in {"go_to", "sit", "look_at", "interact"} for name in names))


if __name__ == "__main__":
    unittest.main()
