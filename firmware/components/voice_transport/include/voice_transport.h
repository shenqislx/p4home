#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define VOICE_TRANSPORT_URI_MAX_BYTES 256U
#define VOICE_TRANSPORT_DEVICE_ID_MAX_BYTES 128U
#define VOICE_TRANSPORT_TOKEN_MAX_BYTES 256U
#define VOICE_TRANSPORT_SPKI_SHA256_BYTES 32U

typedef struct {
    const char *uri;
    const char *device_id;
    const char *device_token;
    uint8_t paired_spki_sha256[VOICE_TRANSPORT_SPKI_SHA256_BYTES];
} voice_transport_config_t;

typedef struct {
    bool initialized;
    bool enabled;
    bool connected;
    bool session_active;
    uint32_t reconnect_count;
    uint32_t sessions_started;
    uint32_t sessions_completed;
    uint32_t sessions_cancelled;
    uint32_t frames_sent;
    uint32_t bytes_sent;
    uint32_t dropped_frames;
    uint32_t protocol_errors;
    uint32_t queue_high_water;
    uint32_t available_credit;
    uint32_t last_epoch;
    uint32_t worker_stack_high_water_bytes;
} voice_transport_snapshot_t;

esp_err_t voice_transport_init(const voice_transport_config_t *config);
esp_err_t voice_transport_start(void);
esp_err_t voice_transport_stop(void);
bool voice_transport_is_connected(void);
void voice_transport_get_snapshot(voice_transport_snapshot_t *snapshot);
