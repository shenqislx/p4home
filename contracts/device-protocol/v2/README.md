# P4 Device Protocol v2

> Status: frozen after Phase 3C
> Protocol version: `2`
> Extends: Device Protocol v1 without changing v1 files

Protocol v2 adds the P4-authoritative object runtime. It preserves the v1 envelope lifecycle,
queue, deadline, idempotency, cancellation, resync and security rules while adding:

- `character.go_to`, `character.sit`, `character.look_at`, `character.interact`;
- object capabilities containing only stable ID, room, supported actions and live availability;
- world snapshots containing object availability/occupancy and character target/pose;
- stable `UNKNOWN_OBJECT`, `UNSUPPORTED_OBJECT_ACTION`, `OBJECT_UNAVAILABLE`,
  `OBJECT_OCCUPIED` and `OBJECT_NOT_REACHED` errors.

The schema fixes object order, room ownership and supported actions to World Object Registry v1.
Character target/room/pose combinations are validated, and the runtime boundary additionally
rejects snapshots whose target is unavailable or whose occupancy contradicts the character pose.
Transient object errors are retryable; permanent object contract errors are not.

Coordinates and animation bindings remain device-internal execution metadata and are forbidden in
protocol payloads. A deployment selects v2 explicitly; the existing v1 transport mode continues to
publish exactly the frozen five room-level actions and v1 snapshot shape.

Phase 3C verified the v2 lifecycle through the Cat-only normalized object-event boundary, including
ordered execution, device errors, cancellation, disconnect reconciliation and audit persistence.
The protocol is therefore frozen; future incompatible changes require a new protocol version.
