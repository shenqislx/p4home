#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    AUDIO_SERVICE_OWNER_NONE = 0,
    AUDIO_SERVICE_OWNER_STARTUP_SELFTEST,
    AUDIO_SERVICE_OWNER_SPEAKER_TEST,
    AUDIO_SERVICE_OWNER_MICROPHONE_CAPTURE,
    AUDIO_SERVICE_OWNER_MICROPHONE_POLL,
    AUDIO_SERVICE_OWNER_SR_SELFTEST,
    AUDIO_SERVICE_OWNER_SR_RUNTIME,
    AUDIO_SERVICE_OWNER_VOICE_CAPTURE,
    AUDIO_SERVICE_OWNER_VOICE_PLAYBACK,
} audio_service_owner_t;

typedef struct {
    audio_service_owner_t owner;
    uint32_t generation;
} audio_service_lease_t;

typedef struct {
    bool active;
    bool faulted;
    audio_service_owner_t owner;
    uint32_t generation;
} audio_service_lease_state_t;

bool audio_service_lease_acquire(audio_service_lease_state_t *state,
                                 audio_service_owner_t owner,
                                 audio_service_lease_t *lease);
bool audio_service_lease_matches(const audio_service_lease_state_t *state,
                                 const audio_service_lease_t *lease);
bool audio_service_lease_release(audio_service_lease_state_t *state,
                                 audio_service_lease_t *lease);
bool audio_service_lease_fault(audio_service_lease_state_t *state,
                               audio_service_lease_t *lease);
const char *audio_service_owner_name(audio_service_owner_t owner);
