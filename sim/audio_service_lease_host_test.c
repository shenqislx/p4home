#include <stdio.h>
#include <stdlib.h>

#include "audio_service_lease.h"

#define CHECK(condition)                                                        \
    do {                                                                        \
        if (!(condition)) {                                                     \
            fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, \
                    #condition);                                                \
            exit(1);                                                            \
        }                                                                       \
    } while (0)

int main(void)
{
    audio_service_lease_state_t state = {0};
    audio_service_lease_t sr = {0};
    audio_service_lease_t playback = {0};

    CHECK(!audio_service_lease_acquire(&state, AUDIO_SERVICE_OWNER_NONE, &sr));
    CHECK(audio_service_lease_acquire(&state, AUDIO_SERVICE_OWNER_SR_RUNTIME, &sr));
    CHECK(sr.generation == 1U);
    CHECK(audio_service_lease_matches(&state, &sr));
    CHECK(!audio_service_lease_acquire(&state, AUDIO_SERVICE_OWNER_VOICE_PLAYBACK, &playback));

    audio_service_lease_t forged = sr;
    forged.generation++;
    CHECK(!audio_service_lease_release(&state, &forged));
    CHECK(state.active);
    CHECK(audio_service_lease_release(&state, &sr));
    CHECK(!state.active && sr.generation == 0U);
    CHECK(!audio_service_lease_release(&state, &sr));

    CHECK(audio_service_lease_acquire(&state, AUDIO_SERVICE_OWNER_VOICE_PLAYBACK, &playback));
    CHECK(playback.generation == 2U);
    CHECK(audio_service_lease_release(&state, &playback));

    CHECK(audio_service_lease_acquire(&state, AUDIO_SERVICE_OWNER_SR_RUNTIME, &sr));
    CHECK(audio_service_lease_fault(&state, &sr));
    CHECK(state.faulted && !state.active);
    CHECK(!audio_service_lease_acquire(&state, AUDIO_SERVICE_OWNER_VOICE_CAPTURE, &playback));

    state = (audio_service_lease_state_t){0};
    state.generation = UINT32_MAX;
    CHECK(!audio_service_lease_acquire(&state, AUDIO_SERVICE_OWNER_MICROPHONE_CAPTURE, &sr));
    CHECK(state.faulted);

    printf("audio_service_lease_host_test: PASS generation=%u\n", state.generation);
    return 0;
}
