# ha_client

Home Assistant WebSocket client for the panel read path.

The client normalizes configured HA URLs to `/api/websocket`, authenticates with a
long-lived access token, subscribes to `state_changed`, and fetches the initial
state only for the configured dashboard entity filter. It does not implement
`call_service` writeback.

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
