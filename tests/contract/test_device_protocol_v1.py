from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from sim.fake.device_protocol_peer import (
    ContractError,
    FakeDeviceProtocolPeer,
    MAX_JSON_FRAME_BYTES,
    ROOM_IDS,
    TOOL_NAMES,
    validate_message,
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
    deadline_at_ms: int = 1_786_761_610_000,
) -> dict:
    return {
        "protocol_version": 1,
        "message_id": f"request-{seq}",
        "correlation_id": None,
        "device_id": "agent-fake",
        "session_id": "fake-session-1",
        "seq": seq,
        "sent_at_ms": 1_786_761_600_000,
        "type": "action.request",
        "payload": {
            "action_id": action_id,
            "tool": tool,
            "arguments": arguments if arguments is not None else {"room_id": "study"},
            "deadline_at_ms": deadline_at_ms,
            "origin": "test",
        },
    }


def cancel(seq: int, action_id: str) -> dict:
    return {
        "protocol_version": 1,
        "message_id": f"cancel-{seq}",
        "correlation_id": None,
        "device_id": "agent-fake",
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
        self.assertEqual(13, len(fixtures))
        for fixture in fixtures:
            with self.subTest(message_type=fixture["type"]):
                validate_message(fixture)

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

    def test_tool_catalog_and_twenty_golden_intents(self) -> None:
        catalog = json.loads((TOOLS / "tool-catalog.json").read_text())
        self.assertEqual(1, catalog["schema_version"])
        self.assertEqual(set(ROOM_IDS), {room["id"] for room in catalog["rooms"]})
        self.assertEqual(set(TOOL_NAMES), {tool["name"] for tool in catalog["tools"]})

        scenarios = json.loads((TOOLS / "fixtures" / "golden-intents.json").read_text())
        self.assertEqual(20, len(scenarios))
        self.assertEqual(20, len({scenario["id"] for scenario in scenarios}))
        for scenario in scenarios:
            with self.subTest(scenario=scenario["id"]):
                if not scenario["expected"]:
                    self.assertIn("no_tool", scenario)
                for call in scenario["expected"]:
                    validate_tool_call(call["name"], call["arguments"])


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
        self.assertEqual("study", completed["payload"]["result"]["room_id"])

    def test_duplicate_action_id_is_idempotent(self) -> None:
        first = self.peer.receive(request(1, "same-action"))
        retry = request(2, "same-action")
        retry["message_id"] = "request-retry"
        second = self.peer.receive(retry)
        self.assertEqual("action.accepted", second["type"])
        self.assertEqual(first["payload"], second["payload"])
        self.assertEqual(1, len(self.peer.actions))

    def test_expired_request_is_rejected(self) -> None:
        result = self.peer.receive(
            request(1, "expired", deadline_at_ms=self.clock.now)
        )
        self.assertEqual("action.failed", result["type"])
        self.assertEqual("DEADLINE_EXCEEDED", result["payload"]["error"]["code"])

    def test_started_action_times_out(self) -> None:
        self.peer.receive(request(1, "timeout", deadline_at_ms=self.clock.now + 5))
        self.peer.start("timeout")
        self.clock.now += 5
        results = self.peer.expire()
        self.assertEqual(1, len(results))
        self.assertEqual("DEADLINE_EXCEEDED", results[0]["payload"]["error"]["code"])

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
        self.assertEqual(["device.capabilities", "world.snapshot"], [item["type"] for item in messages])
        self.assertEqual("reconnect", messages[1]["payload"]["reason"])
        self.assertEqual(1, messages[0]["seq"])
        self.assertEqual(2, messages[1]["seq"])

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


if __name__ == "__main__":
    unittest.main()
