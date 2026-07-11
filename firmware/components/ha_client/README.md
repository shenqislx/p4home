# ha_client

Home Assistant WebSocket client for the panel read path.

The client normalizes configured HA URLs to `/api/websocket`, authenticates with a
long-lived access token, subscribes to `state_changed`, and fetches the initial
state only for the configured dashboard entity filter. M6 adds a small
synchronous `call_service` writeback API for control cards and gateway actions.

Initial state uses HA REST `GET /api/states/<entity_id>` for each whitelisted
entity instead of WebSocket `get_states`. Full `get_states` can be hundreds of
kilobytes on real HA installations, which is too large and unnecessary for the
panel read path.

## TLS

`ws://` and `http://` are used as plain WebSocket connections. `wss://` and
`https://` are used as TLS WebSocket connections.

`settings_service_ha_verify_tls()` controls certificate verification only:

- `true`: attach the ESP-IDF certificate bundle.
- `false`: keep TLS transport but skip certificate common-name checks for local
  or self-signed HA installations.

## Time

HA `last_updated` and `last_changed` values are parsed as UTC epoch
milliseconds. If HA omits both fields, the client uses
`time_service_now_epoch_ms()` after SNTP sync, then falls back to the last SNTP
sync timestamp. A zero timestamp means downstream freshness remains `unknown`.

Tokens must never be logged in full.

## Writeback

`ha_client_call_service()` sends a Home Assistant WebSocket `call_service`
message and waits for the matching `result`. Calls are serialized with an
internal mutex so UI controls do not interleave responses.

`ha_client_call_entity_service()` is the convenience path for common
`entity_id` calls such as `switch.turn_on`, `light.turn_off`, and
`scene.turn_on`.
