# P4 Tool Schema v2

> Status: frozen after Phase 3C
> Tool schema version: `2`
> Extends: frozen Tool Schema v1

Tool Schema v2 preserves the five v1 room-level tools and adds four Cat-only object tools:

- `character.go_to(target_id)`
- `character.sit(target_id)`
- `character.look_at(target_id)`
- `character.interact(target_id)`

`target_id` is a stable room-qualified object ID. Availability and supported actions come from the
live v2 device capabilities; coordinates and animation names are never model-facing. Phase 3B
defines and validates execution. Per-tool result schemas reject impossible object/action/pose
combinations, exact registry state ordering is preserved, and object error retryability is part of
the contract. Phase 3C exposes these tools only to Cat behind a normalized event policy, validates
the model's exact bounded sequence, and terminalizes every audited call. The schema is now frozen;
future incompatible changes require a new Tool Schema version.
