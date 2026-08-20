from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class Phase3DSimulatorHardwareGateContractTests(unittest.TestCase):
    def test_pixel_renderer_consumes_object_semantics_and_exposes_a_gate(self) -> None:
        actor = (ROOT / "firmware/components/ui_pages/ui_home_actor.c").read_text(
            encoding="utf-8"
        )
        simulator = (ROOT / "sim/main.c").read_text(encoding="utf-8")
        cmake = (ROOT / "sim/CMakeLists.txt").read_text(encoding="utf-8")
        for token in (
            "snapshot->target_object_id",
            "snapshot->character_art_x",
            "snapshot->character_floor_y",
            "snapshot->character_facing",
            "snapshot->character_pose",
            "snapshot->active_animation",
            "ACTOR_OBJECT_WALK_FRAMES",
            "ACTOR_SIT_FRAMES",
            "ACTOR_LOOK_FRAMES",
            "ACTOR_PAW_FRAMES",
        ):
            self.assertIn(token, actor)
        for marker in (
            "VERIFY:phase3d:sim_object_anchor:PASS",
            "VERIFY:phase3d:sim_object_pose:PASS",
            "VERIFY:phase3d:sim_animation_bindings:PASS",
            "VERIFY:phase3d:sim_cancel:PASS",
            "VERIFY:phase3d:sim_occupancy_conflict:PASS",
        ):
            self.assertIn(marker, simulator)
        self.assertIn(
            "add_test(NAME pixel_object_gate COMMAND pixel_sim --mode dump --verify-object-gate)",
            cmake,
        )

    def test_websocket_executor_leaves_a_real_cancellation_and_render_window(self) -> None:
        transport = (
            ROOT / "firmware/components/agent_transport/agent_transport.c"
        ).read_text(encoding="utf-8")
        request_handler = transport[
            transport.index("static void agent_handle_action_request") :
            transport.index("static void agent_handle_cancel")
        ]
        worker = transport[
            transport.index("static void agent_worker") :
            transport.index("esp_err_t agent_transport_init")
        ]
        self.assertNotIn("world_service_start_next", request_handler)
        self.assertNotIn("world_service_complete_active", request_handler)
        self.assertIn("AGENT_OBJECT_ACTION_RENDER_MS 250U", transport)
        self.assertIn("AGENT_LOCAL_FALLBACK_GRACE_MS 10000U", transport)
        self.assertIn("agent_capability_objects_json", transport)
        self.assertNotIn(
            "world_service_snapshot_t snapshot = {0};\n        world_service_get_snapshot(&snapshot);\n        cJSON_AddItemToObject(capabilities",
            transport,
        )
        self.assertIn("agent_progress_action_queue();", worker)
        self.assertIn("agent_publish_world_disconnect_if_due();", worker)
        self.assertIn(
            "!event->from_cache && agent_object_tool(event->tool)",
            transport,
        )
        self.assertIn("VERIFY:phase3d:device_object_cancel:PASS", transport)

    def test_hardware_profile_selects_protocol_v2_and_emits_strong_markers(self) -> None:
        workflow = (
            ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml"
        ).read_text(encoding="utf-8")
        profile = (
            ROOT / "scripts/prepare-agent-hardware-sdkconfig.py"
        ).read_text(encoding="utf-8")
        harness = (
            ROOT / "agent/apps/device-harness/src/cli.ts"
        ).read_text(encoding="utf-8")
        defaults = (ROOT / "firmware/sdkconfig.defaults").read_text(encoding="utf-8")
        self.assertIn("- phase3d_object", workflow)
        self.assertIn('echo "AGENT_PROTOCOL_VERSION=2"', workflow)
        self.assertIn('--protocol-version "$AGENT_PROTOCOL_VERSION"', workflow)
        self.assertIn("CONFIG_P4HOME_AGENT_PROTOCOL_VERSION", profile)
        self.assertIn(
            'protocol_version: profile === "phase3d_object" ? 2 : 1',
            harness,
        )
        self.assertIn("CONFIG_P4HOME_AGENT_TRANSPORT_TASK_STACK=12288", defaults)
        self.assertIn("agent_transport_task_stack_size_bytes", workflow)
        self.assertGreaterEqual(
            workflow.count('if [[ "${{ inputs.validation_profile }}" != "generic" ]]; then'),
            2,
        )
        for marker in (
            "VERIFY:phase3d:object_action_chain:PASS",
            "VERIFY:phase3d:reconnect_snapshot:PASS",
            "VERIFY:phase3d:object_cancel:PASS",
        ):
            self.assertIn(marker, harness)

    def test_local_fallback_releases_stale_object_ownership(self) -> None:
        world = (ROOT / "firmware/components/world_service/world_service.c").read_text(
            encoding="utf-8"
        )
        fallback = world[
            world.index("esp_err_t world_service_apply_local_fallback") :
            world.index("esp_err_t world_service_set_object_available")
        ]
        self.assertIn("world_release_character_occupancy_locked();", fallback)
        self.assertIn("s_world.snapshot.target_object_id[0] = '\\0';", fallback)
        self.assertIn(
            "s_world.snapshot.character_pose = WORLD_CHARACTER_POSE_STANDING;",
            fallback,
        )


if __name__ == "__main__":
    unittest.main()
