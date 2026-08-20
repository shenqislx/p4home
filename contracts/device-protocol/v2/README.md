# P4 Device Protocol v2

> Status: candidate for Phase 3B
> Protocol version: `2`
> Extends: Device Protocol v1 without changing v1 files

Protocol v2 adds the P4-authoritative object runtime. It preserves the v1 envelope lifecycle,
queue, deadline, idempotency, cancellation, resync and security rules while adding:

- `character.go_to`, `character.sit`, `character.look_at`, `character.interact`;
- object capabilities containing only stable ID, room, supported actions and live availability;
- world snapshots containing object availability/occupancy and character target/pose;
- stable `UNKNOWN_OBJECT`, `UNSUPPORTED_OBJECT_ACTION`, `OBJECT_UNAVAILABLE`,
  `OBJECT_OCCUPIED` and `OBJECT_NOT_REACHED` errors.

Coordinates and animation bindings remain device-internal execution metadata and are forbidden in
protocol payloads. A deployment selects v2 explicitly; the existing v1 transport mode continues to
publish exactly the frozen five room-level actions and v1 snapshot shape.
