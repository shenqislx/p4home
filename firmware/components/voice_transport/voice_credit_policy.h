#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
    VOICE_SESSION_IDLE = 0,
    VOICE_SESSION_OPENING,
    VOICE_SESSION_READY,
    VOICE_SESSION_WAITING_CLOSE,
} voice_session_state_t;

typedef enum {
    VOICE_CREDIT_INVALID = 0,
    VOICE_CREDIT_ACTIVE,
    VOICE_CREDIT_TERMINAL,
} voice_credit_mode_t;

typedef struct {
    voice_credit_mode_t mode;
    uint32_t acknowledged;
} voice_credit_decision_t;

/* Pure state transition policy kept separate from the WebSocket callback so
 * host tests can exercise the same decision code used on the device. */
static inline voice_credit_decision_t voice_credit_decide(
    bool identity_matches, voice_session_state_t session_state,
    bool end_requested, bool eos_sent, uint32_t final_sequence,
    uint32_t available_credit, const uint32_t *outstanding_sequences,
    uint32_t outstanding_frames, int64_t last_ack_sequence,
    uint32_t ack, uint32_t grant, uint32_t max_inflight_frames)
{
    const voice_credit_decision_t invalid = {
        .mode = VOICE_CREDIT_INVALID,
        .acknowledged = 0U,
    };
    const bool active_credit = session_state == VOICE_SESSION_READY;
    const bool terminal_credit =
        (session_state == VOICE_SESSION_WAITING_CLOSE ||
         session_state == VOICE_SESSION_IDLE) &&
        end_requested && eos_sent;
    if (!identity_matches || (!active_credit && !terminal_credit) ||
        (eos_sent && ack >= final_sequence) || grant == 0U ||
        grant > max_inflight_frames || (int64_t)ack <= last_ack_sequence ||
        outstanding_sequences == NULL || outstanding_frames == 0U ||
        outstanding_frames > max_inflight_frames) {
        return invalid;
    }

    uint32_t ack_index = 0U;
    while (ack_index < outstanding_frames &&
           outstanding_sequences[ack_index] != ack) {
        ack_index++;
    }
    if (ack_index == outstanding_frames) return invalid;

    const uint32_t acknowledged = ack_index + 1U;
    if (active_credit) {
        const uint32_t remaining = outstanding_frames - acknowledged;
        if (available_credit > max_inflight_frames ||
            grant > max_inflight_frames - available_credit ||
            remaining > max_inflight_frames - available_credit - grant) {
            return invalid;
        }
    }
    return (voice_credit_decision_t){
        .mode = terminal_credit ? VOICE_CREDIT_TERMINAL : VOICE_CREDIT_ACTIVE,
        .acknowledged = acknowledged,
    };
}
