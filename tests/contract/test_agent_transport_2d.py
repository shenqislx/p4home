from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TRANSPORT_HEADER = ROOT / "firmware/components/agent_transport/include/agent_transport.h"
TRANSPORT_SOURCE = ROOT / "firmware/components/agent_transport/agent_transport.c"
BOARD_SOURCE = ROOT / "firmware/components/board_support/board_support.c"
MAIN_SOURCE = ROOT / "firmware/main/app_main.c"
HARDWARE_WORKFLOW = ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml"


class AgentTransportPhase2DContractTests(unittest.TestCase):
    def test_transport_matches_frozen_security_boundary(self) -> None:
        policy = json.loads(
            (ROOT / "contracts/device-protocol/v1/transport-security.json").read_text(
                encoding="utf-8"
            )
        )
        header = TRANSPORT_HEADER.read_text(encoding="utf-8")
        source = TRANSPORT_SOURCE.read_text(encoding="utf-8")

        self.assertEqual(policy["websocket_path"], "/v1/device")
        self.assertEqual(policy["tls"]["server_identity"], "paired_spki_pin")
        self.assertIn('static const char scheme[] = "wss://"', source)
        self.assertIn("strncmp(uri, scheme, strlen(scheme))", source)
        self.assertIn('static const char path[] = "/v1/device"', source)
        self.assertIn("strcmp(uri_path, path) == 0", source)
        self.assertIn("strchr(uri, '?')", source)
        self.assertIn("memchr(authority, '@'", source)
        self.assertIn("mbedtls_pk_write_pubkey_der", source)
        self.assertIn("mbedtls_sha256", source)
        self.assertIn("agent_constant_time_equal", source)
        self.assertIn('"Authorization: Bearer %s\\r\\nX-P4-Device-ID: %s\\r\\n"', source)
        self.assertIn("AGENT_TRANSPORT_SPKI_SHA256_BYTES 32U", header)
        self.assertNotRegex(source, r"ESP_LOG\w*\([^;]*s_agent\.token")

    def test_transport_has_frozen_frame_limit_and_full_handshake(self) -> None:
        header = TRANSPORT_HEADER.read_text(encoding="utf-8")
        source = TRANSPORT_SOURCE.read_text(encoding="utf-8")

        self.assertIn("AGENT_TRANSPORT_MAX_JSON_FRAME_BYTES 16384U", header)
        handshake = re.search(
            r"static esp_err_t agent_send_handshake\(void\)(.*?)static void agent_ws_event",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(handshake)
        handshake_types = ["device.hello", "device.capabilities", "world.snapshot"]
        positions = [handshake.group(1).index(f'agent_send_payload("{name}"') for name in handshake_types]
        self.assertEqual(positions, sorted(positions))
        for message_type in (
            "world.changed",
            "world.resync.request",
            "action.request",
            "action.accepted",
            "action.started",
            "action.completed",
            "action.failed",
            "action.cancel",
            "heartbeat",
            "error",
        ):
            self.assertIn(f'"{message_type}"', source)

    def test_agent_transport_is_independent_and_starts_after_world_service(self) -> None:
        board = BOARD_SOURCE.read_text(encoding="utf-8")
        world_position = board.index("world_service_init(NULL)")
        agent_init_position = board.index("agent_transport_init(NULL)")
        agent_start_position = board.index("agent_transport_start()")
        ha_position = board.index("ha_client_init()")

        self.assertLess(world_position, agent_init_position)
        self.assertLess(agent_init_position, agent_start_position)
        self.assertLess(agent_start_position, ha_position)
        self.assertNotIn("ha_client", TRANSPORT_SOURCE.read_text(encoding="utf-8"))

    def test_message_ids_do_not_reset_when_websocket_reconnects(self) -> None:
        source = TRANSPORT_SOURCE.read_text(encoding="utf-8")
        connected_case = re.search(
            r"case WEBSOCKET_EVENT_CONNECTED:(.*?)case WEBSOCKET_EVENT_DISCONNECTED:",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(connected_case)
        self.assertNotIn("message_counter = 0", connected_case.group(1))
        self.assertIn("session_counter++", connected_case.group(1))

    def test_transport_does_not_publish_or_work_before_handshake_completes(self) -> None:
        source = TRANSPORT_SOURCE.read_text(encoding="utf-8")
        connected_case = re.search(
            r"case WEBSOCKET_EVENT_CONNECTED: \{(.*?)case WEBSOCKET_EVENT_DISCONNECTED:",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(connected_case)
        body = connected_case.group(1)
        handshake = body.index("agent_send_handshake()")
        publish_connected = body.index("s_agent.connected = true")
        fallback_connected = body.index("world_service_set_agent_connected(true)")
        self.assertLess(handshake, publish_connected)
        self.assertLess(handshake, fallback_connected)
        self.assertIn("socket_connected", source)
        self.assertIn("if (agent_connected())", source)

    def test_transport_serializes_actions_and_rejects_binary_frames(self) -> None:
        source = TRANSPORT_SOURCE.read_text(encoding="utf-8")

        self.assertIn("action_mutex", source)
        self.assertIn("xSemaphoreTake(s_agent.action_mutex", source)
        self.assertIn("data->op_code == 0x2U", source)
        self.assertIn('"binary frames are not supported"', source)
        self.assertIn("agent_valid_heartbeat(payload)", source)
        self.assertIn("esp_websocket_client_stop(s_agent.ws)", source)
        self.assertIn("esp_websocket_client_start(s_agent.ws)", source)
        self.assertIn(".enable_close_reconnect = true", source)
        malformed_envelope = re.search(
            r"if \(root == NULL.*?invalid protocol envelope.*?agent_request_reconnect\(\)",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(malformed_envelope)

    def test_hardware_gate_exports_offline_and_runtime_metrics(self) -> None:
        header = TRANSPORT_HEADER.read_text(encoding="utf-8")
        source = TRANSPORT_SOURCE.read_text(encoding="utf-8")
        main = MAIN_SOURCE.read_text(encoding="utf-8")

        self.assertIn("ever_connected", header)
        self.assertIn("disconnected_duration_ms", header)
        self.assertIn("worker_stack_high_water_bytes", header)
        self.assertIn("last_disconnect_at_ms", source)
        self.assertIn("7200000ULL", main)
        self.assertIn('log_verify_marker("agent_transport", "offline_2h_fallback"', main)

    def test_hardware_workflow_starts_node_from_the_agent_workspace(self) -> None:
        workflow = HARDWARE_WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("cd agent\n            node --import tsx apps/device-harness/src/cli.ts", workflow)
        self.assertNotIn("node --import tsx agent/apps/device-harness", workflow)
        self.assertIn("P4HOME_AGENT_DEVICE_TOKEN_FILE", workflow)
        self.assertNotIn("P4HOME_AGENT_DEVICE_TOKEN=", workflow)


if __name__ == "__main__":
    unittest.main()
