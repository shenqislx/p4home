# P4 Tool Schema v1

> Status: v1 review candidate; freeze after user review
> Tool schema version: `1`

## 1. Scope

The model sees only five room-level semantic tools:

- `character.get_state`
- `character.go_to_room`
- `character.set_activity`
- `character.say`
- `world.get_snapshot`

The stable room IDs are:

```text
primary_bedroom
study
guest_room
entry
living_room
kitchen
```

Display names may change; IDs may not change within v1.

Object-level actions `character.sit`, `character.look_at` and
`character.interact` are deliberately absent. Requests such as “去沙发坐一下”
must produce a clarification/unsupported response, never a fabricated tool call.

## 2. Invocation and result

Tool calls use the model-facing shape:

```json
{
  "tool_call_id": "tool-call-001",
  "name": "character.go_to_room",
  "arguments": { "room_id": "living_room" }
}
```

Execution results use `tool-result.schema.json`. Tool success means the device
reported the terminal action state; `action.accepted` alone is not success.

Each successful tool has an exact result object:

| Tool | Result |
|---|---|
| `character.get_state` | complete character state |
| `character.go_to_room` | `{ "room_id": <registered-room> }` |
| `character.set_activity` | `{ "activity": "idle" | "sleep" }` |
| `character.say` | `{ "text": <displayed-text> }` |
| `world.get_snapshot` | state version, observation time and complete character state |

Extra or missing result fields are contract violations; clients must not infer a
generic result shape.

When one model turn emits multiple tool calls, the Runtime executes them in array
order. It dispatches at most one call at a time and starts the next call only after
the previous call reaches terminal success. The first terminal error stops the
remaining calls. v1 allows at most four calls per turn; it does not support parallel
tool execution or automatic rollback.

## 3. Stable tool errors

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENT` | missing, extra or invalid argument |
| `UNSUPPORTED_TOOL` | tool is not in the v1 catalog |
| `UNKNOWN_ROOM` | room ID is not in the v1 registry |
| `DEVICE_OFFLINE` | P4 is not connected |
| `QUEUE_FULL` | P4 action queue is full |
| `DEADLINE_EXCEEDED` | relative action timeout elapsed before completion |
| `CANCELLED` | cancellation was confirmed |
| `DEVICE_BUSY` | executor temporarily cannot run the action |
| `ACTION_ID_CONFLICT` | action ID was reused with different tool arguments |
| `INTERNAL` | unexpected runtime/device failure |

Human-readable messages are diagnostic only. Runtime branching must use `code`.
No-tool intent outcomes are separate from execution errors and use
`NO_ACTION`, `CLARIFICATION_REQUIRED`, `OUT_OF_SCOPE`, `UNKNOWN_ROOM` or
`UNSUPPORTED_TOOL` in golden fixtures.

## 4. Golden intent fixtures

`fixtures/golden-intents.json` contains at least 32 Chinese scenarios covering every
room and tool, ordered multi-tool requests, negation, ambiguity and unsupported
capabilities. These are contract fixtures, not model prompts. Phase 1 evals must
report exact ordered tool-name and argument accuracy and preserve the `no_tool` cases.
