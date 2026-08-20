# P4 Tool Schema v2

> Status: candidate for Phase 3B
> Tool schema version: `2`
> Extends: frozen Tool Schema v1

Tool Schema v2 preserves the five v1 room-level tools and adds four Cat-only object tools:

- `character.go_to(target_id)`
- `character.sit(target_id)`
- `character.look_at(target_id)`
- `character.interact(target_id)`

`target_id` is a stable room-qualified object ID. Availability and supported actions come from the
live v2 device capabilities; coordinates and animation names are never model-facing. Phase 3B
defines and validates execution. Role exposure and Cat policy remain disabled until Phase 3C.
