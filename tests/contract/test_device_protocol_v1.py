from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from sim.fake.device_protocol_peer import (
    ACTION_TIMEOUT_MAX_MS,
    ACTION_TIMEOUT_MIN_MS,
    ContractError,
    FakeDeviceProtocolPeer,
    FakeSequentialToolRunner,
    IDEMPOTENCY_TTL_MS,
    MAX_JSON_FRAME_BYTES,
    MESSAGE_TYPES,
    ROOM_IDS,
    TOOL_NAMES,
    validate_message,
    validate_tool_result,
    validate_transport_auth,
    validate_tool_call,
)


ROOT = Path(__file__).resolve().parents[2]
PROTOCOL = ROOT / "contracts" / "device-protocol" / "v1"
TOOLS = ROOT / "contracts" / "tools" / "v1"


class Clock:
    def __init__(self, now: int = 1_786_761_600_000) -> None:
        self.now = now

    def __call__(self) -> int:
        return self.now


def request(
    seq: int,
    action_id: str,
    tool: str = "character.go_to_room",
    arguments: dict | None = None,
    timeout_ms: int = 10_000,
    session_id: str = "fake-session-1",
) -> dict:
    return {
        "protocol_version": 1,
        "message_id": f"{session_id}-request-{seq}",
        "correlation_id": None,
        "device_id": "p4home-fake",
        "session_id": session_id,
        "seq": seq,
        "sent_at_ms": 1_786_761_600_000,
        "type": "action.request",
        "payload": {
            "action_id": action_id,
            "tool": tool,
            "arguments": arguments if arguments is not None else {"room_id": "study"},
            "timeout_ms": timeout_ms,
            "origin": "test",
        },
    }


def cancel(seq: int, action_id: str) -> dict:
    return {
        "protocol_version": 1,
        "message_id": f"cancel-{seq}",
        "correlation_id": None,
        "device_id": "p4home-fake",
        "session_id": "fake-session-1",
        "seq": seq,
        "sent_at_ms": 1_786_761_600_000,
        "type": "action.cancel",
        "payload": {"action_id": action_id, "reason": "user changed intent"},
    }


class ContractFixtureTests(unittest.TestCase):
    def test_all_json_documents_parse(self) -> None:
        documents = list((ROOT / "contracts").rglob("*.json"))
        self.assertGreaterEqual(len(documents), 7)
        for path in documents:
            with self.subTest(path=path):
                json.loads(path.read_text(encoding="utf-8"))

    def test_valid_message_fixtures(self) -> None:
        fixtures = json.loads((PROTOCOL / "examples" / "valid" / "messages.json").read_text())
        self.assertGreaterEqual(len(fixtures), len(MESSAGE_TYPES))
        for fixture in fixtures:
            with self.subTest(message_type=fixture["type"]):
                validate_message(fixture)

    def test_valid_fixtures_form_consistent_action_and_resync_lifecycles(self) -> None:
        fixtures = json.loads((PROTOCOL / "examples" / "valid" / "messages.json").read_text())
        requests: dict[str, dict] = {}
        states: dict[str, str] = {}
        cancels: dict[str, str] = {}
        resync_requests: set[str] = set()

        for message in fixtures:
            payload = message["payload"]
            if message["type"] == "action.request":
                action_id = payload["action_id"]
                self.assertNotIn(action_id, requests)
                requests[action_id] = message
                states[action_id] = "requested"
            elif message["type"] == "action.accepted":
                action_id = payload["action_id"]
                self.assertEqual("requested", states[action_id])
                self.assertEqual(requests[action_id]["message_id"], message["correlation_id"])
                states[action_id] = "accepted"
            elif message["type"] == "action.started":
                action_id = payload["action_id"]
                self.assertEqual("accepted", states[action_id])
                self.assertEqual(requests[action_id]["message_id"], message["correlation_id"])
                states[action_id] = "started"
            elif message["type"] == "action.completed":
                action_id = payload["action_id"]
                self.assertEqual("started", states[action_id])
                self.assertEqual(requests[action_id]["message_id"], message["correlation_id"])
                self.assertEqual(requests[action_id]["payload"]["tool"], payload["tool"])
                validate_tool_result(payload["tool"], payload["result"])
                states[action_id] = "completed"
            elif message["type"] == "action.cancel":
                action_id = payload["action_id"]
                self.assertIn(states[action_id], {"accepted", "started"})
                cancels[action_id] = message["message_id"]
            elif message["type"] == "action.failed":
                action_id = payload["action_id"]
                if payload["error"]["code"] == "CANCELLED":
                    self.assertEqual(cancels[action_id], message["correlation_id"])
                states[action_id] = "failed"
            elif message["type"] == "world.resync.request":
                resync_requests.add(message["message_id"])
            elif message["type"] == "world.snapshot" and payload["reason"] == "resync":
                self.assertIn(message["correlation_id"], resync_requests)

        self.assertEqual({"action-001": "completed", "action-002": "failed"}, states)

        agent_to_device = {"action.request", "action.cancel", "world.resync.request"}
        agent_sequences = [item["seq"] for item in fixtures if item["type"] in agent_to_device]
        device_sequences = [item["seq"] for item in fixtures if item["type"] not in agent_to_device]
        self.assertEqual(list(range(1, len(agent_sequences) + 1)), agent_sequences)
        self.assertEqual(list(range(1, len(device_sequences) + 1)), device_sequences)

    def test_invalid_message_fixtures(self) -> None:
        fixtures = json.loads((PROTOCOL / "examples" / "invalid" / "messages.json").read_text())
        for fixture in fixtures:
            message = copy.deepcopy(fixture["message"])
            if fixture.get("fixture_mutation"):
                message["payload"]["arguments"]["text"] *= 20
            with self.subTest(name=fixture["name"]):
                with self.assertRaises(ContractError) as raised:
                    validate_message(message)
                self.assertEqual(fixture["expected_error"], raised.exception.code)

    def test_tool_catalog_and_richer_golden_intents(self) -> None:
        catalog = json.loads((TOOLS / "tool-catalog.json").read_text())
        self.assertEqual(1, catalog["schema_version"])
        self.assertEqual(
            {
                "mode": "sequential",
                "start_next_after": "previous_terminal_success",
                "on_error": "stop",
                "max_calls_per_turn": 4,
            },
            catalog["execution_policy"],
        )
        self.assertEqual(set(ROOM_IDS), {room["id"] for room in catalog["rooms"]})
        self.assertEqual(set(TOOL_NAMES), {tool["name"] for tool in catalog["tools"]})

        scenarios = json.loads((TOOLS / "fixtures" / "golden-intents.json").read_text())
        self.assertGreaterEqual(len(scenarios), 32)
        self.assertEqual(len(scenarios), len({scenario["id"] for scenario in scenarios}))
        self.assertGreaterEqual(sum(not scenario["expected"] for scenario in scenarios), 10)
        self.assertGreaterEqual(sum(len(scenario["expected"]) > 1 for scenario in scenarios), 7)
        covered_tools: set[str] = set()
        covered_rooms: set[str] = set()
        for scenario in scenarios:
            with self.subTest(scenario=scenario["id"]):
                self.assertTrue(scenario["text"].strip())
                self.assertLessEqual(len(scenario["expected"]), 4)
                if not scenario["expected"]:
                    self.assertIn("no_tool", scenario)
                    self.assertIn(
                        scenario["no_tool"]["code"],
                        {"UNSUPPORTED_TOOL", "UNKNOWN_ROOM", "NO_ACTION", "CLARIFICATION_REQUIRED", "OUT_OF_SCOPE"},
                    )
                for call in scenario["expected"]:
                    validate_tool_call(call["name"], call["arguments"])
                    covered_tools.add(call["name"])
                    if "room_id" in call["arguments"]:
                        covered_rooms.add(call["arguments"]["room_id"])
        self.assertEqual(set(TOOL_NAMES), covered_tools)
        self.assertEqual(set(ROOM_IDS), covered_rooms)

    def test_message_type_sources_are_consistent(self) -> None:
        envelope = json.loads((PROTOCOL / "envelope.schema.json").read_text())
        message_schema = json.loads((PROTOCOL / "message.schema.json").read_text())
        fixtures = json.loads((PROTOCOL / "examples" / "valid" / "messages.json").read_text())

        envelope_types = set(envelope["properties"]["type"]["enum"])
        dispatch_types = {
            branch["properties"]["type"]["const"]
            for branch in message_schema["allOf"][1]["oneOf"]
        }
        fixture_types = {fixture["type"] for fixture in fixtures}

        self.assertEqual(set(MESSAGE_TYPES), envelope_types)
        self.assertEqual(envelope_types, dispatch_types)
        self.assertEqual(envelope_types, fixture_types)

    def test_tool_schema_sources_are_consistent(self) -> None:
        catalog = json.loads((TOOLS / "tool-catalog.json").read_text())
        tool_result = json.loads((TOOLS / "tool-result.schema.json").read_text())
        payloads = json.loads((PROTOCOL / "messages" / "payloads.schema.json").read_text())
        scenarios = json.loads((TOOLS / "fixtures" / "golden-intents.json").read_text())

        catalog_tools = {tool["name"] for tool in catalog["tools"]}
        catalog_rooms = {room["id"] for room in catalog["rooms"]}
        protocol_tools = set(payloads["$defs"]["toolName"]["enum"])
        protocol_rooms = set(payloads["$defs"]["roomId"]["enum"])
        result_tools = set(tool_result["properties"]["name"]["enum"])
        result_errors = set(
            tool_result["properties"]["error"]["oneOf"][1]["properties"]["code"]["enum"]
        )
        action_errors = set(payloads["$defs"]["actionError"]["properties"]["code"]["enum"])
        result_refs = {tool["name"]: tool["result_schema_ref"] for tool in catalog["tools"]}

        self.assertEqual(set(TOOL_NAMES), catalog_tools)
        self.assertEqual(catalog_tools, protocol_tools)
        self.assertEqual(catalog_tools, result_tools)
        self.assertEqual(set(ROOM_IDS), catalog_rooms)
        self.assertEqual(catalog_rooms, protocol_rooms)
        self.assertTrue(action_errors <= result_errors)
        self.assertEqual(
            {
                "character.get_state": "tool-result.schema.json#/$defs/characterState",
                "character.go_to_room": "tool-result.schema.json#/$defs/goToRoomResult",
                "character.set_activity": "tool-result.schema.json#/$defs/setActivityResult",
                "character.say": "tool-result.schema.json#/$defs/sayResult",
                "world.get_snapshot": "tool-result.schema.json#/$defs/worldSnapshotResult",
            },
            result_refs,
        )

    def test_action_completed_and_tool_results_share_exact_dispatch(self) -> None:
        payloads = json.loads((PROTOCOL / "messages" / "payloads.schema.json").read_text())
        tool_result = json.loads((TOOLS / "tool-result.schema.json").read_text())
        completed_branches = payloads["$defs"]["actionCompleted"]["allOf"][0]["oneOf"]
        completed_dispatch = {
            branch["properties"]["tool"]["const"]: branch["properties"]["result"]["$ref"].rsplit("/", 1)[-1]
            for branch in completed_branches
        }
        result_dispatch = {}
        for branch in tool_result["allOf"]:
            condition = branch["if"]["properties"]
            if "name" in condition:
                result_dispatch[condition["name"]["const"]] = branch["then"]["properties"]["result"]["$ref"].rsplit("/", 1)[-1]
        self.assertEqual(completed_dispatch, result_dispatch)
        for definition_name in completed_dispatch.values():
            self.assertEqual(payloads["$defs"][definition_name], tool_result["$defs"][definition_name])

    def test_success_result_rejects_another_tools_shape(self) -> None:
        fixtures = json.loads((PROTOCOL / "examples" / "valid" / "messages.json").read_text())
        completed = copy.deepcopy(next(item for item in fixtures if item["type"] == "action.completed"))
        completed["payload"]["result"] = {"text": "wrong shape"}
        with self.assertRaises(ContractError) as raised:
            validate_message(completed)
        self.assertEqual("INVALID_MESSAGE", raised.exception.code)

    def test_transport_security_policy_and_auth_boundary(self) -> None:
        policy = json.loads((PROTOCOL / "transport-security.json").read_text())
        self.assertTrue(policy["tls"]["required"])
        self.assertEqual("paired_spki_pin", policy["tls"]["server_identity"])
        self.assertTrue(policy["tls"]["certificate_rotation_requires_physical_confirmation"])
        self.assertEqual(256, policy["authentication"]["minimum_token_entropy_bits"])
        self.assertTrue(policy["authentication"]["reject_before_websocket_upgrade"])
        self.assertTrue(policy["pairing"]["requires_local_physical_confirmation"])
        self.assertTrue(policy["pairing"]["pins_runtime_public_key"])
        self.assertFalse(policy["pairing"]["secret_allowed_in_json_messages"])
        self.assertFalse(policy["pairing"]["secret_allowed_in_logs"])
        message_fixtures = (
            (PROTOCOL / "examples" / "valid" / "messages.json").read_text()
            + (PROTOCOL / "examples" / "invalid" / "messages.json").read_text()
        ).lower()
        self.assertNotIn("authorization", message_fixtures)
        self.assertNotIn("bearer ", message_fixtures)

        headers = {
            "Authorization": f"Bearer {'a' * 43}",
            "X-P4-Device-ID": "p4home-demo",
        }
        validate_transport_auth(
            headers,
            expected_device_id="p4home-demo",
            expected_token="a" * 43,
            secure_transport=True,
        )
        for name, changed, code in (
            ("bad token", {**headers, "Authorization": "Bearer wrong"}, "AUTH_FAILED"),
            ("wrong device", {**headers, "X-P4-Device-ID": "other"}, "DEVICE_ID_MISMATCH"),
        ):
            with self.subTest(name=name):
                with self.assertRaises(ContractError) as raised:
                    validate_transport_auth(
                        changed,
                        expected_device_id="p4home-demo",
                        expected_token="a" * 43,
                        secure_transport=True,
                    )
                self.assertEqual(code, raised.exception.code)
        with self.assertRaises(ContractError) as raised:
            validate_transport_auth(
                headers,
                expected_device_id="p4home-demo",
                expected_token="a" * 43,
                secure_transport=False,
            )
        self.assertEqual("INSECURE_TRANSPORT", raised.exception.code)

    def test_action_request_schema_dispatches_exact_tool_arguments(self) -> None:
        catalog = json.loads((TOOLS / "tool-catalog.json").read_text())
        payloads = json.loads((PROTOCOL / "messages" / "payloads.schema.json").read_text())
        definitions = payloads["$defs"]
        branches = definitions["actionRequest"]["allOf"][0]["oneOf"]
        dispatch = {
            branch["properties"]["tool"]["const"]: branch["properties"]["arguments"]["$ref"]
            for branch in branches
        }

        expected_refs = {
            "character.get_state": "#/$defs/emptyArguments",
            "character.go_to_room": "#/$defs/goToRoomArguments",
            "character.set_activity": "#/$defs/setActivityArguments",
            "character.say": "#/$defs/sayArguments",
            "world.get_snapshot": "#/$defs/emptyArguments",
        }
        self.assertEqual(expected_refs, dispatch)

        catalog_parameters = {tool["name"]: tool["parameters"] for tool in catalog["tools"]}
        for tool_name, reference in dispatch.items():
            definition_name = reference.rsplit("/", 1)[-1]
            self.assertEqual(catalog_parameters[tool_name], definitions[definition_name])


class FakePeerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.peer = FakeDeviceProtocolPeer(self.clock)

    def test_complete_action_lifecycle(self) -> None:
        accepted = self.peer.receive(request(1, "action-1"))
        self.assertEqual("action.accepted", accepted["type"])
        started = self.peer.start("action-1")
        self.assertEqual("action.started", started["type"])
        completed = self.peer.complete("action-1")
        self.assertEqual("action.completed", completed["type"])
        self.assertEqual("character.go_to_room", completed["payload"]["tool"])
        self.assertEqual({"room_id": "study"}, completed["payload"]["result"])

    def test_duplicate_action_id_is_idempotent(self) -> None:
        first = self.peer.receive(request(1, "same-action"))
        retry = request(2, "same-action")
        retry["message_id"] = "request-retry"
        second = self.peer.receive(retry)
        self.assertEqual("action.accepted", second["type"])
        self.assertEqual(first["payload"], second["payload"])
        self.assertEqual(1, len(self.peer.actions))

    def test_idempotency_survives_reconnect_until_retention_expires(self) -> None:
        self.peer.receive(request(1, "same-action"))
        self.peer.start("same-action")
        completed = self.peer.complete("same-action")
        self.peer.reconnect()

        self.clock.now += IDEMPOTENCY_TTL_MS - 1
        retry = self.peer.receive(request(1, "same-action", session_id="fake-session-2"))
        self.assertEqual("action.completed", retry["type"])
        self.assertEqual(completed["payload"], retry["payload"])

        self.clock.now += 1
        self.peer.reconnect()
        after_expiry = self.peer.receive(request(1, "same-action", session_id="fake-session-3"))
        self.assertEqual("action.accepted", after_expiry["type"])

    def test_reused_action_id_with_different_arguments_fails(self) -> None:
        self.peer.receive(request(1, "same-action"))
        self.peer.reconnect()
        changed = request(
            1,
            "same-action",
            arguments={"room_id": "kitchen"},
            session_id="fake-session-2",
        )
        result = self.peer.receive(changed)
        self.assertEqual("ACTION_ID_CONFLICT", result["payload"]["error"]["code"])

    def test_timeout_range_is_relative_and_bounded(self) -> None:
        for value in (ACTION_TIMEOUT_MIN_MS - 1, ACTION_TIMEOUT_MAX_MS + 1):
            with self.subTest(timeout_ms=value):
                with self.assertRaises(ContractError) as raised:
                    validate_message(request(1, "invalid-timeout", timeout_ms=value))
                self.assertEqual("INVALID_MESSAGE", raised.exception.code)

    def test_started_action_times_out(self) -> None:
        self.peer.receive(request(1, "timeout", timeout_ms=ACTION_TIMEOUT_MIN_MS))
        self.peer.start("timeout")
        self.clock.now += ACTION_TIMEOUT_MIN_MS
        results = self.peer.expire()
        self.assertEqual(1, len(results))
        self.assertEqual("DEADLINE_EXCEEDED", results[0]["payload"]["error"]["code"])

    def test_timeout_ignores_sender_wall_clock(self) -> None:
        message = request(1, "skewed-clock", timeout_ms=ACTION_TIMEOUT_MIN_MS)
        message["sent_at_ms"] = 0
        result = self.peer.receive(message)
        self.assertEqual("action.accepted", result["type"])
        self.clock.now += ACTION_TIMEOUT_MIN_MS
        self.assertEqual("DEADLINE_EXCEEDED", self.peer.expire()[0]["payload"]["error"]["code"])

    def test_cancel_requires_terminal_confirmation(self) -> None:
        self.peer.receive(request(1, "cancel-me"))
        result = self.peer.receive(cancel(2, "cancel-me"))
        self.assertEqual("action.failed", result["type"])
        self.assertEqual("CANCELLED", result["payload"]["error"]["code"])

    def test_queue_full_is_rejected(self) -> None:
        peer = FakeDeviceProtocolPeer(self.clock, queue_capacity=1)
        peer.receive(request(1, "first"))
        result = peer.receive(request(2, "second"))
        self.assertEqual("QUEUE_FULL", result["payload"]["error"]["code"])
        self.assertTrue(result["payload"]["error"]["retryable"])

    def test_reconnect_emits_capabilities_then_full_snapshot(self) -> None:
        messages = self.peer.reconnect()
        self.assertEqual(
            ["device.hello", "device.capabilities", "world.snapshot"],
            [item["type"] for item in messages],
        )
        self.assertEqual("reconnect", messages[0]["payload"]["connection_reason"])
        self.assertEqual("reconnect", messages[2]["payload"]["reason"])
        self.assertEqual(1, messages[0]["seq"])
        self.assertEqual(2, messages[1]["seq"])
        self.assertEqual(3, messages[2]["seq"])

    def test_explicit_resync_request_returns_correlated_snapshot(self) -> None:
        message = {
            "protocol_version": 1,
            "message_id": "resync-1",
            "correlation_id": None,
            "device_id": "p4home-fake",
            "session_id": "fake-session-1",
            "seq": 1,
            "sent_at_ms": self.clock.now,
            "type": "world.resync.request",
            "payload": {"reason": "state_version_gap", "last_applied_state_version": 3},
        }
        result = self.peer.receive(message)
        self.assertEqual("world.snapshot", result["type"])
        self.assertEqual("resync", result["payload"]["reason"])
        self.assertEqual("resync-1", result["correlation_id"])

    def test_oversized_frame_is_rejected(self) -> None:
        raw = b"{" + b" " * MAX_JSON_FRAME_BYTES + b"}"
        with self.assertRaises(ContractError) as raised:
            self.peer.receive_frame(raw)
        self.assertEqual("FRAME_TOO_LARGE", raised.exception.code)

    def test_out_of_order_sequence_is_rejected(self) -> None:
        self.peer.receive(request(2, "first"))
        stale = request(1, "stale")
        stale["message_id"] = "stale-message"
        with self.assertRaises(ContractError) as raised:
            self.peer.receive(stale)
        self.assertEqual("SEQ_OUT_OF_ORDER", raised.exception.code)

    def test_envelope_cannot_switch_transport_identity_in_band(self) -> None:
        wrong_device = request(1, "wrong-device")
        wrong_device["device_id"] = "another-device"
        wrong_session = request(1, "wrong-session", session_id="invented-session")
        for message, code in (
            (wrong_device, "DEVICE_ID_MISMATCH"),
            (wrong_session, "SESSION_MISMATCH"),
        ):
            with self.subTest(code=code):
                with self.assertRaises(ContractError) as raised:
                    self.peer.receive(message)
                self.assertEqual(code, raised.exception.code)

    def test_sequence_gap_requires_resync(self) -> None:
        self.peer.receive(request(1, "first"))
        with self.assertRaises(ContractError) as raised:
            self.peer.receive(request(3, "gap"))
        self.assertEqual("SEQ_GAP", raised.exception.code)

    def test_every_tool_emits_its_exact_result_shape(self) -> None:
        cases = (
            ("character.get_state", {}, {"room_id", "activity", "speaking", "active_action_id"}),
            ("character.go_to_room", {"room_id": "kitchen"}, {"room_id"}),
            ("character.set_activity", {"activity": "sleep"}, {"activity"}),
            ("character.say", {"text": "测试"}, {"text"}),
            ("world.get_snapshot", {}, {"state_version", "observed_at_ms", "character"}),
        )
        for index, (tool, arguments, result_keys) in enumerate(cases, start=1):
            action_id = f"shape-{index}"
            self.peer.receive(request(index, action_id, tool=tool, arguments=arguments))
            self.peer.start(action_id)
            completed = self.peer.complete(action_id)
            self.assertEqual(tool, completed["payload"]["tool"])
            self.assertEqual(result_keys, set(completed["payload"]["result"]))
            validate_tool_result(tool, completed["payload"]["result"])


class SequentialToolRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.calls = [
            {"name": "character.go_to_room", "arguments": {"room_id": "study"}},
            {"name": "character.say", "arguments": {"text": "我到了"}},
        ]

    def test_next_call_waits_for_previous_terminal_success(self) -> None:
        runner = FakeSequentialToolRunner(self.calls)
        self.assertEqual(self.calls[0], runner.start_next())
        with self.assertRaises(ContractError) as raised:
            runner.start_next()
        self.assertEqual("DEVICE_BUSY", raised.exception.code)
        runner.finish_active(success=True)
        self.assertEqual(self.calls[1], runner.start_next())
        runner.finish_active(success=True)
        self.assertIsNone(runner.start_next())

    def test_failure_stops_remaining_calls(self) -> None:
        runner = FakeSequentialToolRunner(self.calls)
        runner.start_next()
        runner.finish_active(success=False)
        self.assertIsNone(runner.start_next())

    def test_batch_limit_rejects_five_calls(self) -> None:
        with self.assertRaises(ContractError) as raised:
            FakeSequentialToolRunner(self.calls * 2 + self.calls[:1])
        self.assertEqual("INVALID_ARGUMENT", raised.exception.code)


if __name__ == "__main__":
    unittest.main()
