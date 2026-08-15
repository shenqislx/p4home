"""Dependency-free reference peer for P4 Device Protocol v1 contract tests.

This module is intentionally a simulator fake, not production Agent or firmware code.
It makes lifecycle, idempotency, deadline and reconnect rules executable in Phase 0.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable


PROTOCOL_VERSION = 1
MAX_JSON_FRAME_BYTES = 16_384
DEFAULT_QUEUE_CAPACITY = 8
ROOM_IDS = (
    "primary_bedroom",
    "study",
    "guest_room",
    "entry",
    "living_room",
    "kitchen",
)
TOOL_NAMES = (
    "character.get_state",
    "character.go_to_room",
    "character.set_activity",
    "character.say",
    "world.get_snapshot",
)
MESSAGE_TYPES = (
    "device.hello",
    "device.capabilities",
    "world.snapshot",
    "world.changed",
    "user.text",
    "action.request",
    "action.accepted",
    "action.started",
    "action.completed",
    "action.failed",
    "action.cancel",
    "heartbeat",
    "error",
)

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_ENVELOPE_FIELDS = {
    "protocol_version",
    "message_id",
    "correlation_id",
    "device_id",
    "session_id",
    "seq",
    "sent_at_ms",
    "type",
    "payload",
}
_PAYLOAD_FIELDS: dict[str, tuple[set[str], set[str]]] = {
    "device.hello": (
        {"boot_id", "firmware_version", "protocol_versions", "connection_reason"},
        set(),
    ),
    "device.capabilities": (
        {"selected_protocol_version", "rooms", "actions", "limits"},
        set(),
    ),
    "world.snapshot": (
        {"snapshot_id", "reason", "state_version", "observed_at_ms", "character"},
        set(),
    ),
    "world.changed": (
        {"state_version", "observed_at_ms", "character"},
        set(),
    ),
    "user.text": ({"text", "locale", "source"}, set()),
    "action.request": (
        {"action_id", "tool", "arguments", "deadline_at_ms", "origin"},
        set(),
    ),
    "action.accepted": ({"action_id", "queue_position", "accepted_at_ms"}, set()),
    "action.started": ({"action_id", "started_at_ms"}, set()),
    "action.completed": (
        {"action_id", "completed_at_ms", "state_version", "result"},
        set(),
    ),
    "action.failed": ({"action_id", "failed_at_ms", "error"}, set()),
    "action.cancel": ({"action_id", "reason"}, set()),
    "heartbeat": ({"uptime_ms", "last_rx_seq", "state_version"}, set()),
    "error": ({"code", "message", "retryable"}, {"details"}),
}


class ContractError(ValueError):
    """Stable validation/runtime failure used by the fake peer."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _require_id(value: Any, field: str) -> None:
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        raise ContractError("INVALID_MESSAGE", f"{field} must be a valid protocol id")


def _require_exact_object(
    value: Any, required: set[str], optional: set[str], label: str
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError("INVALID_MESSAGE", f"{label} must be an object")
    missing = required - value.keys()
    extra = value.keys() - required - optional
    if missing or extra:
        raise ContractError(
            "INVALID_MESSAGE",
            f"{label} fields invalid; missing={sorted(missing)}, extra={sorted(extra)}",
        )
    return value


def validate_tool_call(name: Any, arguments: Any) -> None:
    """Validate one v1 tool name and its exact argument object."""

    if name not in TOOL_NAMES:
        raise ContractError("UNSUPPORTED_TOOL", f"tool {name!r} is not available in v1")
    if not isinstance(arguments, dict):
        raise ContractError("INVALID_ARGUMENT", "tool arguments must be an object")

    expected: dict[str, set[str]] = {
        "character.get_state": set(),
        "character.go_to_room": {"room_id"},
        "character.set_activity": {"activity"},
        "character.say": {"text"},
        "world.get_snapshot": set(),
    }
    if set(arguments) != expected[name]:
        raise ContractError("INVALID_ARGUMENT", f"invalid arguments for {name}")

    if name == "character.go_to_room" and arguments["room_id"] not in ROOM_IDS:
        raise ContractError("UNKNOWN_ROOM", f"unknown room {arguments['room_id']!r}")
    if name == "character.set_activity" and arguments["activity"] not in {"idle", "sleep"}:
        raise ContractError("INVALID_ARGUMENT", "activity must be idle or sleep")
    if name == "character.say":
        text = arguments["text"]
        if not isinstance(text, str) or not 1 <= len(text) <= 256:
            raise ContractError("INVALID_ARGUMENT", "say text must contain 1..256 characters")


def _validate_character(value: Any) -> None:
    character = _require_exact_object(
        value,
        {"room_id", "activity", "speaking", "active_action_id"},
        set(),
        "payload.character",
    )
    if character["room_id"] not in ROOM_IDS:
        raise ContractError("INVALID_MESSAGE", "character room is not registered")
    if character["activity"] not in {"idle", "sleep"}:
        raise ContractError("INVALID_MESSAGE", "character activity is invalid")
    if not isinstance(character["speaking"], bool):
        raise ContractError("INVALID_MESSAGE", "character speaking must be boolean")
    if character["active_action_id"] is not None:
        _require_id(character["active_action_id"], "payload.character.active_action_id")


def validate_message(message: Any) -> None:
    """Validate v1 fixtures without requiring a third-party JSON Schema package."""

    if not isinstance(message, dict):
        raise ContractError("INVALID_MESSAGE", "message must be an object")
    if message.get("protocol_version") != PROTOCOL_VERSION:
        raise ContractError("UNSUPPORTED_VERSION", "only protocol version 1 is supported")
    _require_exact_object(message, _ENVELOPE_FIELDS, set(), "message")
    _require_id(message["message_id"], "message_id")
    if message["correlation_id"] is not None:
        _require_id(message["correlation_id"], "correlation_id")
    _require_id(message["device_id"], "device_id")
    _require_id(message["session_id"], "session_id")
    if not isinstance(message["seq"], int) or message["seq"] < 0:
        raise ContractError("INVALID_MESSAGE", "seq must be a non-negative integer")
    if not isinstance(message["sent_at_ms"], int) or message["sent_at_ms"] < 0:
        raise ContractError("INVALID_MESSAGE", "sent_at_ms must be a non-negative integer")
    message_type = message["type"]
    if message_type not in MESSAGE_TYPES:
        raise ContractError("UNSUPPORTED_MESSAGE_TYPE", f"unknown type {message_type!r}")

    required, optional = _PAYLOAD_FIELDS[message_type]
    payload = _require_exact_object(message["payload"], required, optional, "payload")

    for id_field in ("boot_id", "snapshot_id", "action_id"):
        if id_field in payload:
            _require_id(payload[id_field], f"payload.{id_field}")

    if message_type == "device.hello":
        if payload["protocol_versions"] != [1]:
            raise ContractError("INVALID_MESSAGE", "protocol_versions must be [1]")
        if payload["connection_reason"] not in {"boot", "reconnect", "manual", "test"}:
            raise ContractError("INVALID_MESSAGE", "invalid connection reason")
    elif message_type == "device.capabilities":
        if payload["selected_protocol_version"] != 1:
            raise ContractError("INVALID_MESSAGE", "selected protocol must be 1")
        if set(payload["rooms"]) != set(ROOM_IDS) or len(payload["rooms"]) != len(ROOM_IDS):
            raise ContractError("INVALID_MESSAGE", "capability rooms do not match v1")
        if set(payload["actions"]) != set(TOOL_NAMES) or len(payload["actions"]) != len(TOOL_NAMES):
            raise ContractError("INVALID_MESSAGE", "capability actions do not match v1")
        if payload["limits"] != {
            "max_json_frame_bytes": MAX_JSON_FRAME_BYTES,
            "action_queue_capacity": DEFAULT_QUEUE_CAPACITY,
            "say_text_max_chars": 256,
        }:
            raise ContractError("INVALID_MESSAGE", "capability limits do not match v1")
    elif message_type in {"world.snapshot", "world.changed"}:
        _validate_character(payload["character"])
    elif message_type == "user.text":
        if not isinstance(payload["text"], str) or not 1 <= len(payload["text"]) <= 1024:
            raise ContractError("INVALID_MESSAGE", "user text length is invalid")
        if payload["locale"] != "zh-CN" or payload["source"] not in {"touch", "voice", "simulator"}:
            raise ContractError("INVALID_MESSAGE", "user text locale or source is invalid")
    elif message_type == "action.request":
        validate_tool_call(payload["tool"], payload["arguments"])
        if not isinstance(payload["deadline_at_ms"], int) or payload["deadline_at_ms"] < 0:
            raise ContractError("INVALID_MESSAGE", "deadline must be a non-negative integer")
        if payload["origin"] not in {"user", "agent", "autonomy", "test"}:
            raise ContractError("INVALID_MESSAGE", "invalid action origin")
    elif message_type == "action.accepted":
        if not isinstance(payload["queue_position"], int) or not 0 <= payload["queue_position"] < 8:
            raise ContractError("INVALID_MESSAGE", "queue position is outside v1 capacity")
    elif message_type == "action.completed" and not isinstance(payload["result"], dict):
        raise ContractError("INVALID_MESSAGE", "action result must be an object")
    elif message_type == "action.failed":
        error = _require_exact_object(
            payload["error"], {"code", "message", "retryable"}, {"details"}, "payload.error"
        )
        if error["code"] not in {
            "INVALID_ARGUMENT",
            "UNSUPPORTED_TOOL",
            "UNKNOWN_ROOM",
            "QUEUE_FULL",
            "DEADLINE_EXCEEDED",
            "CANCELLED",
            "DEVICE_BUSY",
            "INTERNAL",
        }:
            raise ContractError("INVALID_MESSAGE", "unknown action error code")


@dataclass
class _Action:
    request_message_id: str
    tool: str
    arguments: dict[str, Any]
    deadline_at_ms: int
    state: str
    latest_type: str
    latest_payload: dict[str, Any]


class FakeDeviceProtocolPeer:
    """Small deterministic P4-side peer used to verify protocol behavior."""

    def __init__(
        self,
        now_ms: Callable[[], int],
        queue_capacity: int = DEFAULT_QUEUE_CAPACITY,
        device_id: str = "p4home-fake",
    ) -> None:
        self.now_ms = now_ms
        self.queue_capacity = queue_capacity
        self.device_id = device_id
        self.session_number = 1
        self.session_id = "fake-session-1"
        self.tx_seq = 0
        self.last_rx_seq = -1
        self.seen_message_ids: set[str] = set()
        self.actions: dict[str, _Action] = {}
        self.state_version = 1
        self.character = {
            "room_id": "living_room",
            "activity": "idle",
            "speaking": False,
            "active_action_id": None,
        }

    def _emit(
        self, message_type: str, payload: dict[str, Any], correlation_id: str | None = None
    ) -> dict[str, Any]:
        self.tx_seq += 1
        message = {
            "protocol_version": 1,
            "message_id": f"fake-msg-{self.session_number}-{self.tx_seq}",
            "correlation_id": correlation_id,
            "device_id": self.device_id,
            "session_id": self.session_id,
            "seq": self.tx_seq,
            "sent_at_ms": self.now_ms(),
            "type": message_type,
            "payload": payload,
        }
        validate_message(message)
        return message

    def _failure(
        self,
        action_id: str,
        code: str,
        message: str,
        correlation_id: str,
        retryable: bool = False,
    ) -> dict[str, Any]:
        payload = {
            "action_id": action_id,
            "failed_at_ms": self.now_ms(),
            "error": {"code": code, "message": message, "retryable": retryable},
        }
        return self._emit("action.failed", payload, correlation_id)

    def _active_count(self) -> int:
        return sum(action.state in {"accepted", "started"} for action in self.actions.values())

    def receive_frame(self, raw: bytes) -> dict[str, Any]:
        if len(raw) > MAX_JSON_FRAME_BYTES:
            raise ContractError("FRAME_TOO_LARGE", "JSON frame exceeds 16 KiB")
        try:
            message = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ContractError("INVALID_MESSAGE", "frame is not valid UTF-8 JSON") from exc
        return self.receive(message)

    def receive(self, message: dict[str, Any]) -> dict[str, Any]:
        validate_message(message)
        if message["message_id"] in self.seen_message_ids:
            raise ContractError("DUPLICATE_MESSAGE", "message_id was already processed")
        if message["session_id"] == self.session_id and message["seq"] <= self.last_rx_seq:
            raise ContractError("SEQ_OUT_OF_ORDER", "sequence did not increase")
        self.seen_message_ids.add(message["message_id"])
        self.last_rx_seq = message["seq"]

        if message["type"] == "action.cancel":
            return self._cancel(message)
        if message["type"] != "action.request":
            raise ContractError("UNSUPPORTED_MESSAGE_TYPE", "fake peer accepts action messages only")

        payload = message["payload"]
        action_id = payload["action_id"]
        existing = self.actions.get(action_id)
        if existing is not None:
            return self._emit(existing.latest_type, existing.latest_payload, message["message_id"])
        if payload["deadline_at_ms"] <= self.now_ms():
            return self._failure(
                action_id,
                "DEADLINE_EXCEEDED",
                "action deadline elapsed before enqueue",
                message["message_id"],
            )
        if self._active_count() >= self.queue_capacity:
            return self._failure(
                action_id,
                "QUEUE_FULL",
                "device action queue is full",
                message["message_id"],
                retryable=True,
            )

        accepted = {
            "action_id": action_id,
            "queue_position": self._active_count(),
            "accepted_at_ms": self.now_ms(),
        }
        self.actions[action_id] = _Action(
            request_message_id=message["message_id"],
            tool=payload["tool"],
            arguments=dict(payload["arguments"]),
            deadline_at_ms=payload["deadline_at_ms"],
            state="accepted",
            latest_type="action.accepted",
            latest_payload=accepted,
        )
        return self._emit("action.accepted", accepted, message["message_id"])

    def start(self, action_id: str) -> dict[str, Any]:
        action = self.actions.get(action_id)
        if action is None:
            raise ContractError("ACTION_NOT_FOUND", f"unknown action {action_id}")
        if action.state != "accepted":
            return self._emit(action.latest_type, action.latest_payload, action.request_message_id)
        payload = {"action_id": action_id, "started_at_ms": self.now_ms()}
        action.state = "started"
        action.latest_type = "action.started"
        action.latest_payload = payload
        self.character["active_action_id"] = action_id
        return self._emit("action.started", payload, action.request_message_id)

    def complete(self, action_id: str) -> dict[str, Any]:
        action = self.actions.get(action_id)
        if action is None:
            raise ContractError("ACTION_NOT_FOUND", f"unknown action {action_id}")
        if action.state == "completed":
            return self._emit(action.latest_type, action.latest_payload, action.request_message_id)
        if action.state != "started":
            raise ContractError("INVALID_MESSAGE", "only a started action can complete")

        if action.tool == "character.go_to_room":
            self.character["room_id"] = action.arguments["room_id"]
        elif action.tool == "character.set_activity":
            self.character["activity"] = action.arguments["activity"]
        self.character["active_action_id"] = None
        self.state_version += 1
        result = {
            "action_id": action_id,
            "completed_at_ms": self.now_ms(),
            "state_version": self.state_version,
            "result": dict(self.character),
        }
        action.state = "completed"
        action.latest_type = "action.completed"
        action.latest_payload = result
        return self._emit("action.completed", result, action.request_message_id)

    def _cancel(self, message: dict[str, Any]) -> dict[str, Any]:
        action_id = message["payload"]["action_id"]
        action = self.actions.get(action_id)
        if action is None:
            raise ContractError("ACTION_NOT_FOUND", f"unknown action {action_id}")
        if action.state in {"completed", "failed"}:
            return self._emit(action.latest_type, action.latest_payload, message["message_id"])
        payload = {
            "action_id": action_id,
            "failed_at_ms": self.now_ms(),
            "error": {
                "code": "CANCELLED",
                "message": message["payload"]["reason"],
                "retryable": False,
            },
        }
        action.state = "failed"
        action.latest_type = "action.failed"
        action.latest_payload = payload
        self.character["active_action_id"] = None
        return self._emit("action.failed", payload, message["message_id"])

    def expire(self) -> list[dict[str, Any]]:
        expired: list[dict[str, Any]] = []
        for action_id, action in self.actions.items():
            if action.state in {"accepted", "started"} and action.deadline_at_ms <= self.now_ms():
                payload = {
                    "action_id": action_id,
                    "failed_at_ms": self.now_ms(),
                    "error": {
                        "code": "DEADLINE_EXCEEDED",
                        "message": "action deadline elapsed during execution",
                        "retryable": False,
                    },
                }
                action.state = "failed"
                action.latest_type = "action.failed"
                action.latest_payload = payload
                self.character["active_action_id"] = None
                expired.append(self._emit("action.failed", payload, action.request_message_id))
        return expired

    def reconnect(self) -> list[dict[str, Any]]:
        self.session_number += 1
        self.session_id = f"fake-session-{self.session_number}"
        self.tx_seq = 0
        self.last_rx_seq = -1
        capabilities = self._emit(
            "device.capabilities",
            {
                "selected_protocol_version": 1,
                "rooms": list(ROOM_IDS),
                "actions": list(TOOL_NAMES),
                "limits": {
                    "max_json_frame_bytes": MAX_JSON_FRAME_BYTES,
                    "action_queue_capacity": 8,
                    "say_text_max_chars": 256,
                },
            },
        )
        snapshot = self._emit(
            "world.snapshot",
            {
                "snapshot_id": f"snapshot-{self.session_number}",
                "reason": "reconnect",
                "state_version": self.state_version,
                "observed_at_ms": self.now_ms(),
                "character": dict(self.character),
            },
        )
        return [capabilities, snapshot]
