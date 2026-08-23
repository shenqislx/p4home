#include "audio_service_lease.h"

#include <stddef.h>

static bool owner_is_valid(audio_service_owner_t owner)
{
    return owner > AUDIO_SERVICE_OWNER_NONE && owner <= AUDIO_SERVICE_OWNER_VOICE_PLAYBACK;
}

bool audio_service_lease_acquire(audio_service_lease_state_t *state,
                                 audio_service_owner_t owner,
                                 audio_service_lease_t *lease)
{
    if (state == NULL || lease == NULL || !owner_is_valid(owner) || state->active ||
        state->faulted) {
        return false;
    }
    if (state->generation == UINT32_MAX) {
        state->faulted = true;
        return false;
    }
    state->generation++;
    state->active = true;
    state->owner = owner;
    lease->owner = owner;
    lease->generation = state->generation;
    return true;
}

bool audio_service_lease_matches(const audio_service_lease_state_t *state,
                                 const audio_service_lease_t *lease)
{
    return state != NULL && lease != NULL && state->active &&
           lease->owner == state->owner && lease->generation != 0U &&
           lease->generation == state->generation;
}

bool audio_service_lease_release(audio_service_lease_state_t *state,
                                 audio_service_lease_t *lease)
{
    if (!audio_service_lease_matches(state, lease)) {
        return false;
    }
    state->active = false;
    state->owner = AUDIO_SERVICE_OWNER_NONE;
    lease->owner = AUDIO_SERVICE_OWNER_NONE;
    lease->generation = 0U;
    return true;
}

bool audio_service_lease_fault(audio_service_lease_state_t *state,
                               audio_service_lease_t *lease)
{
    if (!audio_service_lease_matches(state, lease)) {
        return false;
    }
    state->active = false;
    state->faulted = true;
    state->owner = AUDIO_SERVICE_OWNER_NONE;
    lease->owner = AUDIO_SERVICE_OWNER_NONE;
    lease->generation = 0U;
    return true;
}

const char *audio_service_owner_name(audio_service_owner_t owner)
{
    switch (owner) {
    case AUDIO_SERVICE_OWNER_NONE:
        return "none";
    case AUDIO_SERVICE_OWNER_STARTUP_SELFTEST:
        return "startup_selftest";
    case AUDIO_SERVICE_OWNER_SPEAKER_TEST:
        return "speaker_test";
    case AUDIO_SERVICE_OWNER_MICROPHONE_CAPTURE:
        return "microphone_capture";
    case AUDIO_SERVICE_OWNER_MICROPHONE_POLL:
        return "microphone_poll";
    case AUDIO_SERVICE_OWNER_SR_SELFTEST:
        return "sr_selftest";
    case AUDIO_SERVICE_OWNER_SR_RUNTIME:
        return "sr_runtime";
    case AUDIO_SERVICE_OWNER_VOICE_CAPTURE:
        return "voice_capture";
    case AUDIO_SERVICE_OWNER_VOICE_PLAYBACK:
        return "voice_playback";
    default:
        return "invalid";
    }
}
