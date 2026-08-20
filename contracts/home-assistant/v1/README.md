# Robot Home Assistant Contract v1

> Status: frozen for Phase 4A; Robot tool exposure remains disabled until Phase 4B

This contract defines the repository-safe shape of the Robot Home Assistant policy and the
model-facing tool namespace. A real policy file lives outside the repository and maps stable aliases
to real Home Assistant entity IDs.

Security invariants:

- the model selects only a stable alias, never an arbitrary `entity_id`, domain, service, or data body;
- `get_states`, arbitrary `call_service`, locks, alarms, door access, purchases, deletion, and
  temperature setting are outside this contract;
- only `light`, `switch`, `scene`, `climate`, `sensor`, and `binary_sensor` may be allowlisted;
- write actions are restricted by domain and are still unavailable to Robot in Phase 4A;
- projected attributes come from a closed, domain-checked list;
- real credentials and policies must not be committed.

The valid example uses fictional entity IDs and contains no credential.
