# P4 Device Protocol v1

> Status: v1 review candidate; freeze after user review
> Protocol version: `1`
> Transport: WebSocket JSON text frames; binary audio is reserved for a later version

## 1. Purpose

This contract connects one P4 panel to the LAN Agent Runtime. It describes device
capabilities, authoritative world state, user text and asynchronous semantic actions.
Transport delivery is at-least-once; action execution is idempotent by `action_id`.

The schemas are split into:

- `envelope.schema.json`: fields shared by every JSON message;
- `message.schema.json`: envelope plus message-type-to-payload dispatch;
- `messages/payloads.schema.json`: strict payload definitions;
- `examples/valid/messages.json`: one valid fixture per message type;
- `examples/invalid/messages.json`: negative fixtures and expected stable error codes.

## 2. Envelope rules

Every text frame is one UTF-8 JSON object with these fields:

| Field | Required | Rule |
|---|---:|---|
| `protocol_version` | yes | integer constant `1` |
| `message_id` | yes | sender-generated unique ID, never reused |
| `correlation_id` | yes | request `message_id`, or `null` for unsolicited events |
| `device_id` | yes | stable provisioned panel ID |
| `session_id` | yes | changes on each transport session |
| `seq` | yes | monotonically increasing within one session |
| `sent_at_ms` | yes | Unix epoch milliseconds |
| `type` | yes | one of the v1 message types |
| `payload` | yes | payload selected by `type` |

The maximum JSON frame is 16 KiB after UTF-8 encoding. Receivers reject larger
frames with `FRAME_TOO_LARGE`. Unknown top-level or payload fields are rejected.

## 3. Message flow

On first connect or reconnect:

```text
device.hello
→ device.capabilities
→ world.snapshot(reason = connect | reconnect | resync)
→ incremental world.changed / heartbeat / action messages
```

If a peer observes a sequence gap or cannot apply an incremental update, it requests
reconnect/resync and trusts the next full snapshot. It must not infer missing state.

An action follows:

```text
action.request
→ action.accepted
→ action.started
→ action.completed | action.failed
```

`action.cancel` is a request. A confirmed cancellation terminates with
`action.failed` and error code `CANCELLED`; cancellation is not assumed until that
terminal message arrives.

## 4. Idempotency, deadlines and backpressure

- `message_id` identifies delivery; `action_id` identifies execution.
- Retrying an action preserves `action_id` and uses a new `message_id`.
- A duplicate `action_id` returns the latest known lifecycle state without executing again.
- An expired request fails with `DEADLINE_EXCEEDED` before enqueue.
- The initial P4 action queue capacity is 8. A full queue fails with `QUEUE_FULL`.
- Completed action records must remain in the session idempotency cache for at least 10 minutes.
- Reconnect does not replay expired animation actions; the full snapshot is authoritative.

## 5. Stable protocol errors

| Code | Meaning | Retryable |
|---|---|---:|
| `INVALID_MESSAGE` | malformed envelope or payload | no |
| `UNSUPPORTED_VERSION` | protocol version is not 1 | no |
| `UNSUPPORTED_MESSAGE_TYPE` | unknown message type | no |
| `FRAME_TOO_LARGE` | JSON frame exceeds 16 KiB | no |
| `SEQ_OUT_OF_ORDER` | sequence regressed within a session | reconnect |
| `DUPLICATE_MESSAGE` | delivery ID was already processed | no |
| `ACTION_NOT_FOUND` | cancel/status target is unknown | no |
| `QUEUE_FULL` | device action queue has no capacity | yes |
| `DEADLINE_EXCEEDED` | action deadline elapsed | caller decides |
| `CANCELLED` | action cancellation was confirmed | no |
| `DEVICE_BUSY` | executor cannot start the action yet | yes |
| `INTERNAL` | unexpected device-side failure | yes |

Tool validation errors are defined separately in `contracts/tools/v1/README.md`.

## 6. Audio boundary

Protocol v1 does not carry audio. A later voice-phase extension may negotiate a
binary channel with an explicit header, codec, sample rate, channel count and stream
ID. Audio bytes must never be embedded as Base64 inside these JSON frames.
