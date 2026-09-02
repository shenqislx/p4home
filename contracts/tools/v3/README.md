# P4 Human Avatar Tool Schema v3

> Status: Human avatar isolated contract
> Tool schema version: `3`
> Device actor: `human_avatar`

Tool Schema v3 is the model-facing action contract for the on-screen Human avatar. It exposes
exactly five bounded actions:

- `character.go_to_room(room_id)`
- `character.go_to(target_id)`
- `character.sit(target_id)`
- `character.look_at(target_id)`
- `character.interact(target_id)`

The Runtime narrows room, action, and object enums from the live Device Protocol v3 capabilities.
The model never supplies `actor_id`; the Runtime binds every device dispatch to `human_avatar`.
Calls execute sequentially, with one to four calls per turn, and stop after the first non-completed
device outcome. This contract is independent from frozen Tool Schema v2: Cat continues to use v2
and cannot receive the Human transcript or a v3 tool result.
