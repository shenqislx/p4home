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

## 3. Stable tool errors

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENT` | missing, extra or invalid argument |
| `UNSUPPORTED_TOOL` | tool is not in the v1 catalog |
| `UNKNOWN_ROOM` | room ID is not in the v1 registry |
| `DEVICE_OFFLINE` | P4 is not connected |
| `QUEUE_FULL` | P4 action queue is full |
| `DEADLINE_EXCEEDED` | deadline elapsed before completion |
| `CANCELLED` | cancellation was confirmed |
| `DEVICE_BUSY` | executor temporarily cannot run the action |
| `INTERNAL` | unexpected runtime/device failure |

Human-readable messages are diagnostic only. Runtime branching must use `code`.

## 4. Golden intent fixtures

`fixtures/golden-intents.json` contains exactly 20 Chinese scenarios. These are
contract fixtures, not model prompts. Phase 1 evals must report exact tool-name and
argument accuracy against them and preserve the `no_tool` cases.
