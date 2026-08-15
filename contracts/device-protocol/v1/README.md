# P4 Device Protocol v1

> Status: v1 review candidate; freeze after user review
> Protocol version: `1`
> Transport: WebSocket JSON text frames; binary audio is reserved for a later version

## 1. Purpose

This contract connects one P4 panel to the LAN Agent Runtime. It describes device
capabilities, authoritative world state, user text and asynchronous semantic actions.
Transport delivery is at-least-once; action execution is idempotent by `action_id`.

The schemas are split into:

- `transport-security.json`: authenticated WebSocket and physical pairing policy;
- `envelope.schema.json`: fields shared by every JSON message;
- `message.schema.json`: envelope plus message-type-to-payload dispatch;
- `messages/payloads.schema.json`: strict payload definitions;
- `examples/valid/messages.json`: coherent lifecycle fixtures covering every message type;
- `examples/invalid/messages.json`: negative fixtures and expected stable error codes.

## 2. Transport authentication and pairing

Normal deployments use `wss://<agent>/v1/device`. Plain `ws://` is allowed only
for loopback or the simulator test harness. Before the WebSocket upgrade, the panel
sends `Authorization: Bearer <device-token>` and `X-P4-Device-ID: <device-id>`.
The Runtime validates both values and rejects a failed request before returning HTTP
`101`; unauthenticated peers never enter the JSON protocol.

Each token is random with at least 256 bits of entropy and scoped to one provisioned
device. Initial pairing requires local physical confirmation on the panel and uses a
single-use pairing channel. Pairing also stores the Runtime TLS public-key (SPKI) pin;
certificate-key replacement requires a physically confirmed rotation or re-pairing.
Credential rotation and revocation are mandatory. Tokens must not
appear in JSON frames, fixtures, normal logs, URLs or query parameters. The
`device_id` in every accepted JSON envelope must match the authenticated upgrade.

## 3. Envelope rules

Every text frame is one UTF-8 JSON object with these fields:

| Field | Required | Rule |
|---|---:|---|
| `protocol_version` | yes | integer constant `1` |
| `message_id` | yes | sender-generated unique ID, never reused |
| `correlation_id` | yes | request `message_id`, or `null` for unsolicited events |
| `device_id` | yes | stable provisioned panel ID |
| `session_id` | yes | changes on each transport session |
| `seq` | yes | sender-local, gap-free and monotonically increasing within one session |
| `sent_at_ms` | yes | Unix epoch milliseconds |
| `type` | yes | one of the v1 message types |
| `payload` | yes | payload selected by `type` |

The maximum JSON frame is 16 KiB after UTF-8 encoding. Receivers reject larger
frames with `FRAME_TOO_LARGE`. Unknown top-level or payload fields are rejected.

Each sender owns its sequence counter; the two directions do not share one counter.
Changing `session_id` resets that sender's counter. Regressions produce
`SEQ_OUT_OF_ORDER`; a forward gap produces `SEQ_GAP` and enters resync handling.
An envelope whose `device_id` or `session_id` differs from the authenticated current
transport is rejected; a peer cannot reset sequence validation by changing IDs in-band.

## 4. Message flow

On first connect or reconnect:

```text
device.hello
→ device.capabilities
→ world.snapshot(reason = connect | reconnect | resync)
→ incremental world.changed / heartbeat / action messages
```

If a peer observes a sequence or `state_version` gap, or cannot apply an incremental
update, it sends `world.resync.request` with its last applied version. It then ignores
further `world.changed` messages until it receives a correlated
`world.snapshot(reason = resync)`. It must not infer missing state. If a resync request
cannot be delivered on the current transport, the peer reconnects and follows the
normal hello/capabilities/snapshot flow.

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

## 5. Idempotency, timeouts and backpressure

- `message_id` identifies delivery; `action_id` identifies execution.
- Retrying an action preserves `action_id` and uses a new `message_id`.
- A duplicate `action_id` returns the latest known lifecycle state without executing again.
- The cache key is `(device_id, action_id)`; reconnecting with a new `session_id` does
  not create a new execution namespace.
- Reusing an `action_id` with different tool arguments fails with `ACTION_ID_CONFLICT`.
- The initial P4 action queue capacity is 8. A full queue fails with `QUEUE_FULL`.
- `timeout_ms` is a relative duration in the inclusive range 100–120,000 ms. The
  receiver starts a monotonic timer when it first accepts a new `action_id`; wall-clock
  values such as `sent_at_ms` are diagnostic and never decide expiry.
- Accepted or started actions that exceed that timer terminate with `DEADLINE_EXCEEDED`.
- Terminal records remain in the device-scoped idempotency cache for at least 600,000 ms
  across WebSocket reconnects. A device reboot may clear this RAM cache; after a new
  `boot_id`, the Runtime must reconcile a snapshot instead of blindly replaying an old action.
- Reconnect does not replay expired animation actions; the full snapshot is authoritative.

## 6. Stable protocol errors

| Code | Meaning | Retryable |
|---|---|---:|
| `INVALID_MESSAGE` | malformed envelope or payload | no |
| `UNSUPPORTED_VERSION` | protocol version is not 1 | no |
| `UNSUPPORTED_MESSAGE_TYPE` | unknown message type | no |
| `FRAME_TOO_LARGE` | JSON frame exceeds 16 KiB | no |
| `DEVICE_ID_MISMATCH` | envelope device does not match authenticated transport | no |
| `SESSION_MISMATCH` | envelope session does not match current transport | reconnect |
| `SEQ_OUT_OF_ORDER` | sequence regressed within a session | reconnect |
| `SEQ_GAP` | forward sequence gap requires full-state resync | yes |
| `DUPLICATE_MESSAGE` | delivery ID was already processed | no |
| `ACTION_NOT_FOUND` | cancel/status target is unknown | no |
| `QUEUE_FULL` | device action queue has no capacity | yes |
| `DEADLINE_EXCEEDED` | action deadline elapsed | caller decides |
| `CANCELLED` | action cancellation was confirmed | no |
| `DEVICE_BUSY` | executor cannot start the action yet | yes |
| `INTERNAL` | unexpected device-side failure | yes |

Tool validation errors are defined separately in `contracts/tools/v1/README.md`.

## 7. Audio boundary

Protocol v1 does not carry audio. A later voice-phase extension may negotiate a
binary channel with an explicit header, codec, sample rate, channel count and stream
ID. Audio bytes must never be embedded as Base64 inside these JSON frames.
