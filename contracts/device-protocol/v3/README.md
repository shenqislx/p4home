# P4 Device Protocol v3 Human Avatar Runtime

> Status: initial product vertical slice
> Protocol version: `3`
> Extends: Device Protocol v2 without changing frozen v1/v2 files

Protocol v3 binds every advertised capability, world snapshot and action lifecycle message to the
single remotely controllable actor `human_avatar`. The actor identity is explicit and immutable:
the Agent adapter injects it and firmware rejects missing, unknown or Cat identities.

The v2 room/object tools and object registry remain unchanged. Coordinates and animation bindings
remain device-internal execution metadata. Cat is deliberately outside this remote protocol slice;
its local timer/decoration must not mutate the authoritative Human avatar state.

This version preserves queue, deadline, idempotency, cancellation, resync and TLS/SPKI security
rules. A future protocol that remotely controls more than one actor must introduce a new version
and independent actor state rather than widening `actor_id` in place.
