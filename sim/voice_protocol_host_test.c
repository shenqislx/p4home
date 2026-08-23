#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "voice_protocol.h"

#define CHECK(condition)                                                        \
    do {                                                                        \
        if (!(condition)) {                                                     \
            fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, \
                    #condition);                                                \
            exit(1);                                                            \
        }                                                                       \
    } while (0)

static voice_protocol_frame_header_t frame(uint32_t sequence, uint8_t flags)
{
    voice_protocol_frame_header_t value = {
        .kind = VOICE_PROTOCOL_FRAME_CAPTURE_PCM,
        .flags = flags,
        .stream_id = 7,
        .epoch = 3,
        .sequence = sequence,
        .capture_time_us = 1000U + sequence * 20000U,
        .payload_bytes = VOICE_PROTOCOL_FRAME_PAYLOAD_BYTES,
        .sample_rate_hz = VOICE_PROTOCOL_SAMPLE_RATE_HZ,
        .frame_samples = VOICE_PROTOCOL_FRAME_SAMPLES,
        .channels = VOICE_PROTOCOL_CHANNELS,
        .bits_per_sample = VOICE_PROTOCOL_BITS_PER_SAMPLE,
    };
    value.session_id[0] = 0x42;
    value.session_id[15] = 0x24;
    return value;
}

int main(void)
{
    uint8_t encoded[VOICE_PROTOCOL_HEADER_BYTES];
    voice_protocol_frame_header_t first = frame(0, 0);
    CHECK(voice_protocol_encode_header(&first, encoded, sizeof(encoded)) == VOICE_PROTOCOL_OK);
    CHECK(memcmp(encoded, "P4V1", 4) == 0);

    voice_protocol_frame_header_t decoded;
    CHECK(voice_protocol_decode_header(encoded, sizeof(encoded), &decoded) == VOICE_PROTOCOL_OK);
    CHECK(decoded.kind == first.kind);
    CHECK(decoded.flags == first.flags);
    CHECK(memcmp(decoded.session_id, first.session_id, sizeof(first.session_id)) == 0);
    CHECK(decoded.stream_id == first.stream_id);
    CHECK(decoded.epoch == first.epoch);
    CHECK(decoded.sequence == first.sequence);
    CHECK(decoded.capture_time_us == first.capture_time_us);
    CHECK(decoded.payload_bytes == first.payload_bytes);
    CHECK(decoded.sample_rate_hz == first.sample_rate_hz);
    CHECK(decoded.frame_samples == first.frame_samples);
    CHECK(decoded.channels == first.channels);
    CHECK(decoded.bits_per_sample == first.bits_per_sample);

    uint8_t complete_frame[VOICE_PROTOCOL_HEADER_BYTES + VOICE_PROTOCOL_FRAME_PAYLOAD_BYTES];
    memcpy(complete_frame, encoded, sizeof(encoded));
    memset(complete_frame + sizeof(encoded), 0x5a, VOICE_PROTOCOL_FRAME_PAYLOAD_BYTES);
    const uint8_t *payload = NULL;
    CHECK(voice_protocol_decode_frame(complete_frame, sizeof(complete_frame), &decoded, &payload) ==
          VOICE_PROTOCOL_OK);
    CHECK(payload == complete_frame + VOICE_PROTOCOL_HEADER_BYTES && payload[0] == 0x5a);
    CHECK(voice_protocol_decode_frame(complete_frame, sizeof(complete_frame) - 1U, &decoded, &payload) ==
          VOICE_PROTOCOL_INVALID_PAYLOAD);
    CHECK(voice_protocol_decode_frame(complete_frame, VOICE_PROTOCOL_HEADER_BYTES, &decoded, &payload) ==
          VOICE_PROTOCOL_INVALID_PAYLOAD);

    encoded[0] = 'X';
    CHECK(voice_protocol_decode_header(encoded, sizeof(encoded), &decoded) ==
          VOICE_PROTOCOL_INVALID_MAGIC);
    encoded[0] = 'P';
    encoded[4] = 2;
    CHECK(voice_protocol_decode_header(encoded, sizeof(encoded), &decoded) ==
          VOICE_PROTOCOL_UNSUPPORTED_VERSION);

    voice_protocol_frame_header_t invalid = first;
    invalid.payload_bytes--;
    CHECK(voice_protocol_validate_header(&invalid) == VOICE_PROTOCOL_INVALID_PAYLOAD);
    invalid = first;
    invalid.frame_samples--;
    invalid.payload_bytes -= 2;
    CHECK(voice_protocol_validate_header(&invalid) == VOICE_PROTOCOL_INVALID_GEOMETRY);
    invalid = first;
    invalid.sequence = UINT32_MAX;
    CHECK(voice_protocol_validate_header(&invalid) == VOICE_PROTOCOL_INVALID_HEADER);
    invalid.flags = VOICE_PROTOCOL_FLAG_END_OF_STREAM;
    CHECK(voice_protocol_validate_header(&invalid) == VOICE_PROTOCOL_OK);

    voice_protocol_rx_tracker_t tracker;
    CHECK(voice_protocol_rx_begin(&tracker, first.session_id, first.stream_id, first.epoch) ==
          VOICE_PROTOCOL_OK);
    CHECK(voice_protocol_rx_accept(&tracker, &first) == VOICE_PROTOCOL_OK);
    CHECK(tracker.next_sequence == 1 && tracker.dropped_frames == 0);

    voice_protocol_frame_header_t gap = frame(2, 0);
    CHECK(voice_protocol_rx_accept(&tracker, &gap) == VOICE_PROTOCOL_SEQUENCE_GAP);
    gap.flags = VOICE_PROTOCOL_FLAG_DISCONTINUITY;
    CHECK(voice_protocol_rx_accept(&tracker, &gap) == VOICE_PROTOCOL_OK);
    CHECK(tracker.next_sequence == 3 && tracker.dropped_frames == 1);

    voice_protocol_frame_header_t duplicate = frame(2, 0);
    CHECK(voice_protocol_rx_accept(&tracker, &duplicate) == VOICE_PROTOCOL_STALE_FRAME);
    voice_protocol_frame_header_t stale_epoch = frame(3, 0);
    stale_epoch.epoch++;
    CHECK(voice_protocol_rx_accept(&tracker, &stale_epoch) == VOICE_PROTOCOL_STALE_FRAME);

    voice_protocol_frame_header_t eos = frame(3, VOICE_PROTOCOL_FLAG_END_OF_STREAM);
    eos.frame_samples = 160;
    eos.payload_bytes = 320;
    CHECK(voice_protocol_rx_accept(&tracker, &eos) == VOICE_PROTOCOL_OK);
    CHECK(tracker.ended);
    voice_protocol_frame_header_t after = frame(4, 0);
    CHECK(voice_protocol_rx_accept(&tracker, &after) == VOICE_PROTOCOL_AFTER_EOS);

    printf("voice_protocol_host_test: PASS next_sequence=%u dropped=%u\n",
           tracker.next_sequence, tracker.dropped_frames);
    return 0;
}
