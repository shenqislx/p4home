#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define AGENT_TRANSPORT_URI_MAX_BYTES 256U
#define AGENT_TRANSPORT_DEVICE_ID_MAX_BYTES 128U
#define AGENT_TRANSPORT_TOKEN_MAX_BYTES 256U
#define AGENT_TRANSPORT_SPKI_SHA256_BYTES 32U
#define AGENT_TRANSPORT_MAX_JSON_FRAME_BYTES 16384U
#define AGENT_TRANSPORT_PROTOCOL_V1 1U
#define AGENT_TRANSPORT_PROTOCOL_V2 2U
#define AGENT_TRANSPORT_PROTOCOL_V3 3U
#define AGENT_TRANSPORT_HUMAN_AVATAR_ID "human_avatar"

typedef struct {
    const char *uri;
    const char *device_id;
    const char *device_token;
    uint8_t paired_spki_sha256[AGENT_TRANSPORT_SPKI_SHA256_BYTES];
    uint8_t protocol_version;
} agent_transport_config_t;

typedef struct {
    bool initialized;
    bool enabled;
    bool connected;
    bool handshake_sent;
    bool ever_connected;
    uint32_t reconnect_count;
    uint32_t received_frames;
    uint32_t sent_frames;
    uint32_t protocol_errors;
    uint32_t completed_actions;
    uint32_t failed_actions;
    uint32_t last_rx_seq;
    uint32_t last_state_version;
    uint32_t worker_stack_high_water_bytes;
    uint64_t disconnected_duration_ms;
    uint8_t protocol_version;
} agent_transport_snapshot_t;

/* A NULL config loads the build-time development configuration. */
esp_err_t agent_transport_init(const agent_transport_config_t *config);
esp_err_t agent_transport_start(void);
esp_err_t agent_transport_stop(void);
bool agent_transport_is_connected(void);
void agent_transport_get_snapshot(agent_transport_snapshot_t *snapshot);
