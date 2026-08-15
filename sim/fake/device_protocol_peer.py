"""Dependency-free reference peer for P4 Device Protocol v1 contract tests.

This module is intentionally a simulator fake, not production Agent or firmware code.
It makes lifecycle, idempotency, timeout and reconnect rules executable in Phase 0.
"""

from __future__ import annotations

import json
import hmac
import re
from dataclasses import dataclass
from typing import Any, Callable


PROTOCOL_VERSION = 1
MAX_JSON_FRAME_BYTES = 16_384
DEFAULT_QUEUE_CAPACITY = 8
ACTION_TIMEOUT_MIN_MS = 100
ACTION_TIMEOUT_MAX_MS = 120_000
IDEMPOTENCY_TTL_MS = 600_000
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
    "world.resync.request",
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
    "world.resync.request": (
        {"reason", "last_applied_state_version"},
        set(),
    ),
    "user.text": ({"text", "locale", "source"}, set()),
    "action.request": (
        {"action_id", "tool", "arguments", "timeout_ms", "origin"},
        set(),
    ),
    "action.accepted": ({"action_id", "queue_position", "accepted_at_ms"}, set()),
    "action.started": ({"action_id", "started_at_ms"}, set()),
    "action.completed": (
        {"action_id", "tool", "completed_at_ms", "state_version", "result"},
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


def validate_transport_auth(
    headers: dict[str, str],
    *,
    expected_device_id: str,
    expected_token: str,
    secure_transport: bool,
    allow_insecure_test_transport: bool = False,
) -> None:
    """Validate the authenticated WebSocket upgrade boundary used by v1."""

    normalized = {name.lower(): value for name, value in headers.items()}
    if not secure_transport and not allow_insecure_test_transport:
        raise ContractError("INSECURE_TRANSPORT", "TLS is required outside local tests")
    if normalized.get("x-p4-device-id") != expected_device_id:
        raise ContractError("DEVICE_ID_MISMATCH", "upgrade device id does not match pairing")
    authorization = normalized.get("authorization", "")
    expected = f"Bearer {expected_token}"
    if not hmac.compare_digest(authorization, expected):
        raise ContractError("AUTH_FAILED", "device bearer credential is missing or invalid")


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


def validate_tool_result(name: Any, result: Any) -> None:
    """Validate the exact successful result object for one v1 tool."""

    if name not in TOOL_NAMES:
        raise ContractError("UNSUPPORTED_TOOL", f"tool {name!r} is not available in v1")
    if not isinstance(result, dict):
        raise ContractError("INVALID_MESSAGE", "tool result must be an object")

    if name == "character.get_state":
        _validate_character(result)
    elif name == "character.go_to_room":
        value = _require_exact_object(result, {"room_id"}, set(), "payload.result")
        if value["room_id"] not in ROOM_IDS:
            raise ContractError("INVALID_MESSAGE", "result room is not registered")
    elif name == "character.set_activity":
        value = _require_exact_object(result, {"activity"}, set(), "payload.result")
        if value["activity"] not in {"idle", "sleep"}:
            raise ContractError("INVALID_MESSAGE", "result activity is invalid")
    elif name == "character.say":
        value = _require_exact_object(result, {"text"}, set(), "payload.result")
        if not isinstance(value["text"], str) or not 1 <= len(value["text"]) <= 256:
            raise ContractError("INVALID_MESSAGE", "result text length is invalid")
    elif name == "world.get_snapshot":
        value = _require_exact_object(
            result,
            {"state_version", "observed_at_ms", "character"},
            set(),
            "payload.result",
        )
        if not isinstance(value["state_version"], int) or value["state_version"] < 0:
            raise ContractError("INVALID_MESSAGE", "result state version is invalid")
        if not isinstance(value["observed_at_ms"], int) or value["observed_at_ms"] < 0:
            raise ContractError("INVALID_MESSAGE", "result observation time is invalid")
        _validate_character(value["character"])


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
            "action_timeout_min_ms": ACTION_TIMEOUT_MIN_MS,
            "action_timeout_max_ms": ACTION_TIMEOUT_MAX_MS,
            "idempotency_retention_ms": IDEMPOTENCY_TTL_MS,
        }:
            raise ContractError("INVALID_MESSAGE", "capability limits do not match v1")
    elif message_type in {"world.snapshot", "world.changed"}:
        _validate_character(payload["character"])
    elif message_type == "world.resync.request":
        if payload["reason"] not in {"seq_gap", "state_version_gap", "apply_failed", "requested"}:
            raise ContractError("INVALID_MESSAGE", "invalid resync reason")
        if (
            not isinstance(payload["last_applied_state_version"], int)
            or payload["last_applied_state_version"] < 0
        ):
            raise ContractError("INVALID_MESSAGE", "invalid last applied state version")
    elif message_type == "user.text":
        if not isinstance(payload["text"], str) or not 1 <= len(payload["text"]) <= 1024:
            raise ContractError("INVALID_MESSAGE", "user text length is invalid")
        if payload["locale"] != "zh-CN" or payload["source"] not in {"touch", "voice", "simulator"}:
            raise ContractError("INVALID_MESSAGE", "user text locale or source is invalid")
    elif message_type == "action.request":
        validate_tool_call(payload["tool"], payload["arguments"])
        if (
            not isinstance(payload["timeout_ms"], int)
            or not ACTION_TIMEOUT_MIN_MS <= payload["timeout_ms"] <= ACTION_TIMEOUT_MAX_MS
        ):
            raise ContractError("INVALID_MESSAGE", "timeout is outside the v1 range")
        if payload["origin"] not in {"user", "agent", "autonomy", "test"}:
            raise ContractError("INVALID_MESSAGE", "invalid action origin")
    elif message_type == "action.accepted":
        if not isinstance(payload["queue_position"], int) or not 0 <= payload["queue_position"] < 8:
            raise ContractError("INVALID_MESSAGE", "queue position is outside v1 capacity")
    elif message_type == "action.completed":
        validate_tool_result(payload["tool"], payload["result"])
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
            "ACTION_ID_CONFLICT",
            "INTERNAL",
        }:
            raise ContractError("INVALID_MESSAGE", "unknown action error code")


@dataclass
class _Action:
    request_message_id: str
    tool: str
    arguments: dict[str, Any]
    expires_at_ms: int
    state: str
    latest_type: str
    latest_payload: dict[str, Any]
    terminal_at_ms: int | None = None


class FakeSequentialToolRunner:
    """Reference runtime policy: ordered calls, one active call, stop on error."""

    def __init__(self, calls: list[dict[str, Any]], max_calls: int = 4) -> None:
        if not 1 <= len(calls) <= max_calls:
            raise ContractError("INVALID_ARGUMENT", "tool batch size is outside the v1 limit")
        for call in calls:
            _require_exact_object(call, {"name", "arguments"}, set(), "tool call")
            validate_tool_call(call["name"], call["arguments"])
        self.calls = calls
        self.index = 0
        self.active = False
        self.stopped = False

    def start_next(self) -> dict[str, Any] | None:
        if self.active:
            raise ContractError("DEVICE_BUSY", "previous tool call is not terminal")
        if self.stopped or self.index >= len(self.calls):
            return None
        self.active = True
        return self.calls[self.index]

    def finish_active(self, *, success: bool) -> None:
        if not self.active:
            raise ContractError("INVALID_MESSAGE", "no active tool call")
        self.active = False
        if success:
            self.index += 1
        else:
            self.stopped = True


class FakeDeviceProtocolPeer:
    """Small deterministic P4-side peer used to verify protocol behavior."""

    def __init__(
        self,
        now_ms: Callable[[], int],
        queue_capacity: int = DEFAULT_QUEUE_CAPACITY,
        device_id: str = "p4home-fake",
        idempotency_ttl_ms: int = IDEMPOTENCY_TTL_MS,
    ) -> None:
        self.now_ms = now_ms
        self.queue_capacity = queue_capacity
        self.device_id = device_id
        self.idempotency_ttl_ms = idempotency_ttl_ms
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

    def _prune_idempotency_cache(self) -> None:
        cutoff = self.now_ms() - self.idempotency_ttl_ms
        expired_ids = [
            action_id
            for action_id, action in self.actions.items()
            if action.terminal_at_ms is not None and action.terminal_at_ms <= cutoff
        ]
        for action_id in expired_ids:
            del self.actions[action_id]

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
        if message["device_id"] != self.device_id:
            raise ContractError("DEVICE_ID_MISMATCH", "envelope device id does not match transport")
        if message["session_id"] != self.session_id:
            raise ContractError("SESSION_MISMATCH", "envelope session id does not match transport")
        if message["message_id"] in self.seen_message_ids:
            raise ContractError("DUPLICATE_MESSAGE", "message_id was already processed")
        if message["seq"] <= self.last_rx_seq:
            raise ContractError("SEQ_OUT_OF_ORDER", "sequence did not increase")
        if self.last_rx_seq >= 0 and message["seq"] != self.last_rx_seq + 1:
            raise ContractError("SEQ_GAP", "sequence has a gap and requires resync")
        self.seen_message_ids.add(message["message_id"])
        self.last_rx_seq = message["seq"]

        if message["type"] == "world.resync.request":
            return self._emit(
                "world.snapshot",
                {
                    "snapshot_id": f"snapshot-{self.session_number}-{self.tx_seq + 1}",
                    "reason": "resync",
                    "state_version": self.state_version,
                    "observed_at_ms": self.now_ms(),
                    "character": dict(self.character),
                },
                message["message_id"],
            )
        if message["type"] == "action.cancel":
            return self._cancel(message)
        if message["type"] != "action.request":
            raise ContractError("UNSUPPORTED_MESSAGE_TYPE", "fake peer accepts action messages only")

        payload = message["payload"]
        action_id = payload["action_id"]
        self._prune_idempotency_cache()
        existing = self.actions.get(action_id)
        if existing is not None:
            if existing.tool != payload["tool"] or existing.arguments != payload["arguments"]:
                return self._failure(
                    action_id,
                    "ACTION_ID_CONFLICT",
                    "action_id was already used with different tool arguments",
                    message["message_id"],
                )
            return self._emit(existing.latest_type, existing.latest_payload, message["message_id"])
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
            expires_at_ms=self.now_ms() + payload["timeout_ms"],
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

        self.character["active_action_id"] = None
        if action.tool == "character.go_to_room":
            self.character["room_id"] = action.arguments["room_id"]
            result = {"room_id": self.character["room_id"]}
            self.state_version += 1
        elif action.tool == "character.set_activity":
            self.character["activity"] = action.arguments["activity"]
            result = {"activity": self.character["activity"]}
            self.state_version += 1
        elif action.tool == "character.say":
            result = {"text": action.arguments["text"]}
            self.state_version += 1
        elif action.tool == "character.get_state":
            result = dict(self.character)
        elif action.tool == "world.get_snapshot":
            result = {
                "state_version": self.state_version,
                "observed_at_ms": self.now_ms(),
                "character": dict(self.character),
            }
        else:  # pragma: no cover - validate_tool_call prevents this path
            raise ContractError("UNSUPPORTED_TOOL", f"unknown tool {action.tool}")
        completed = {
            "action_id": action_id,
            "tool": action.tool,
            "completed_at_ms": self.now_ms(),
            "state_version": self.state_version,
            "result": result,
        }
        action.state = "completed"
        action.latest_type = "action.completed"
        action.latest_payload = completed
        action.terminal_at_ms = self.now_ms()
        return self._emit("action.completed", completed, action.request_message_id)

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
        action.terminal_at_ms = self.now_ms()
        self.character["active_action_id"] = None
        return self._emit("action.failed", payload, message["message_id"])

    def expire(self) -> list[dict[str, Any]]:
        expired: list[dict[str, Any]] = []
        for action_id, action in self.actions.items():
            if action.state in {"accepted", "started"} and action.expires_at_ms <= self.now_ms():
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
                action.terminal_at_ms = self.now_ms()
                self.character["active_action_id"] = None
                expired.append(self._emit("action.failed", payload, action.request_message_id))
        return expired

    def reconnect(self) -> list[dict[str, Any]]:
        self.session_number += 1
        self.session_id = f"fake-session-{self.session_number}"
        self.tx_seq = 0
        self.last_rx_seq = -1
        hello = self._emit(
            "device.hello",
            {
                "boot_id": "fake-boot-1",
                "firmware_version": "fake-v1",
                "protocol_versions": [1],
                "connection_reason": "reconnect",
            },
        )
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
                    "action_timeout_min_ms": ACTION_TIMEOUT_MIN_MS,
                    "action_timeout_max_ms": ACTION_TIMEOUT_MAX_MS,
                    "idempotency_retention_ms": IDEMPOTENCY_TTL_MS,
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
        return [hello, capabilities, snapshot]
