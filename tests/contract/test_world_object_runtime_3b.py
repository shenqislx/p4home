from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORLD_HEADER = ROOT / "firmware/components/world_service/include/world_service.h"
WORLD_SOURCE = ROOT / "firmware/components/world_service/world_service.c"
TRANSPORT_HEADER = ROOT / "firmware/components/agent_transport/include/agent_transport.h"
TRANSPORT_SOURCE = ROOT / "firmware/components/agent_transport/agent_transport.c"
TRANSPORT_KCONFIG = ROOT / "firmware/components/agent_transport/Kconfig.projbuild"
ROLE_PROFILES = ROOT / "agent/apps/runtime/src/role-profiles.ts"


class WorldObjectRuntimePhase3BContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = json.loads(
            (ROOT / "contracts/world/v1/object-registry.json").read_text(
                encoding="utf-8"
            )
        )
        self.v1_catalog = json.loads(
            (ROOT / "contracts/tools/v1/tool-catalog.json").read_text(
                encoding="utf-8"
            )
        )
        self.v2_catalog = json.loads(
            (ROOT / "contracts/tools/v2/tool-catalog.json").read_text(
                encoding="utf-8"
            )
        )

    def test_tool_schema_v2_is_an_exact_v1_compatible_superset(self) -> None:
        v1_names = [tool["name"] for tool in self.v1_catalog["tools"]]
        v2_names = [tool["name"] for tool in self.v2_catalog["tools"]]
        self.assertEqual(1, self.v1_catalog["schema_version"])
        self.assertEqual(2, self.v2_catalog["schema_version"])
        self.assertEqual(v1_names, v2_names[: len(v1_names)])
        self.assertEqual(
            [
                "character.go_to",
                "character.sit",
                "character.look_at",
                "character.interact",
            ],
            v2_names[len(v1_names) :],
        )
        action_by_tool = {
            "character.go_to": "go_to",
            "character.sit": "sit",
            "character.look_at": "look_at",
            "character.interact": "interact",
        }
        result_ref_by_tool = {
            "character.go_to": "tool-result.schema.json#/$defs/goToObjectResult",
            "character.sit": "tool-result.schema.json#/$defs/sitObjectResult",
            "character.look_at": "tool-result.schema.json#/$defs/lookAtObjectResult",
            "character.interact": "tool-result.schema.json#/$defs/interactObjectResult",
        }
        for tool in self.v2_catalog["tools"][len(v1_names) :]:
            expected_ids = [
                item["object_id"]
                for item in self.registry["objects"]
                if action_by_tool[tool["name"]] in item["supported_actions"]
            ]
            self.assertEqual(
                expected_ids,
                tool["parameters"]["properties"]["target_id"]["enum"],
            )
            self.assertEqual(result_ref_by_tool[tool["name"]], tool["result_schema_ref"])

    def test_v2_model_contracts_exclude_execution_metadata(self) -> None:
        payloads = json.loads(
            (
                ROOT
                / "contracts/device-protocol/v2/messages/payloads.schema.json"
            ).read_text(encoding="utf-8")
        )
        tool_results = json.loads(
            (ROOT / "contracts/tools/v2/tool-result.schema.json").read_text(
                encoding="utf-8"
            )
        )
        model_contract = json.dumps(
            [self.v2_catalog, payloads, tool_results], ensure_ascii=False
        )
        for forbidden in (
            '"anchor"',
            '"art_x"',
            '"floor_y"',
            '"facing"',
            '"animation_bindings"',
            '"default_available"',
        ):
            self.assertNotIn(forbidden, model_contract)

    def test_world_runtime_exposes_authoritative_object_state_and_errors(self) -> None:
        header = WORLD_HEADER.read_text(encoding="utf-8")
        source = WORLD_SOURCE.read_text(encoding="utf-8")
        for token in (
            "target_object_id",
            "character_art_x",
            "character_floor_y",
            "character_facing",
            "character_pose",
            "active_animation",
            "WORLD_ACTION_ERROR_UNKNOWN_OBJECT",
            "WORLD_ACTION_ERROR_UNSUPPORTED_OBJECT_ACTION",
            "WORLD_ACTION_ERROR_OBJECT_UNAVAILABLE",
            "WORLD_ACTION_ERROR_OBJECT_OCCUPIED",
            "WORLD_ACTION_ERROR_OBJECT_NOT_REACHED",
        ):
            self.assertIn(token, header)
        self.assertIn("world_object_request_error_locked", source)
        self.assertGreaterEqual(source.count("world_object_request_error_locked(record)"), 3)
        self.assertIn("world_object_error_retryable", source)
        self.assertIn("world_release_character_occupancy_locked", source)

    def test_transport_defaults_to_v1_and_gates_v2_capabilities(self) -> None:
        header = TRANSPORT_HEADER.read_text(encoding="utf-8")
        source = TRANSPORT_SOURCE.read_text(encoding="utf-8")
        kconfig = TRANSPORT_KCONFIG.read_text(encoding="utf-8")
        self.assertIn("AGENT_TRANSPORT_PROTOCOL_V1 1U", header)
        self.assertIn("AGENT_TRANSPORT_PROTOCOL_V2 2U", header)
        self.assertIn("config P4HOME_AGENT_PROTOCOL_VERSION", kconfig)
        self.assertIn("default 1", kconfig)
        self.assertIn("agent_uses_object_runtime()", source)
        self.assertIn("WORLD_ACTION_V1_LAST", source)
        self.assertIn("WORLD_ACTION_OBJECT_LAST", source)
        self.assertIn('cJSON_AddItemToObject(capabilities, "objects"', source)
        self.assertIn(
            'cJSON_AddNumberToObject(root, "protocol_version", s_agent.protocol_version)',
            source,
        )

    def test_phase_3b_does_not_expose_object_tools_to_roles(self) -> None:
        profiles = ROLE_PROFILES.read_text(encoding="utf-8")
        for tool in (
            '"character.go_to"',
            '"character.sit"',
            '"character.look_at"',
            '"character.interact"',
        ):
            self.assertNotIn(tool, profiles)


if __name__ == "__main__":
    unittest.main()
