#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define VOICE_PROTOCOL_VERSION 1U
#define VOICE_PROTOCOL_HEADER_BYTES 56U
#define VOICE_PROTOCOL_SAMPLE_RATE_HZ 16000U
#define VOICE_PROTOCOL_CHANNELS 1U
#define VOICE_PROTOCOL_BITS_PER_SAMPLE 16U
#define VOICE_PROTOCOL_FRAME_SAMPLES 320U
#define VOICE_PROTOCOL_FRAME_PAYLOAD_BYTES 640U

typedef enum {
    VOICE_PROTOCOL_OK = 0,
    VOICE_PROTOCOL_INVALID_ARGUMENT,
    VOICE_PROTOCOL_INVALID_MAGIC,
    VOICE_PROTOCOL_UNSUPPORTED_VERSION,
    VOICE_PROTOCOL_INVALID_HEADER,
    VOICE_PROTOCOL_INVALID_KIND,
    VOICE_PROTOCOL_INVALID_FLAGS,
    VOICE_PROTOCOL_INVALID_SESSION,
    VOICE_PROTOCOL_INVALID_STREAM,
    VOICE_PROTOCOL_INVALID_EPOCH,
    VOICE_PROTOCOL_INVALID_GEOMETRY,
    VOICE_PROTOCOL_INVALID_PAYLOAD,
    VOICE_PROTOCOL_STALE_FRAME,
    VOICE_PROTOCOL_SEQUENCE_GAP,
    VOICE_PROTOCOL_AFTER_EOS,
} voice_protocol_result_t;

typedef enum {
    VOICE_PROTOCOL_FRAME_CAPTURE_PCM = 1,
    VOICE_PROTOCOL_FRAME_PLAYBACK_PCM = 2,
} voice_protocol_frame_kind_t;

enum {
    VOICE_PROTOCOL_FLAG_END_OF_STREAM = 1U << 0,
    VOICE_PROTOCOL_FLAG_DISCONTINUITY = 1U << 1,
};

typedef struct {
    voice_protocol_frame_kind_t kind;
    uint8_t flags;
    uint8_t session_id[16];
    uint32_t stream_id;
    uint32_t epoch;
    uint32_t sequence;
    uint64_t capture_time_us;
    uint32_t payload_bytes;
    uint32_t sample_rate_hz;
    uint16_t frame_samples;
    uint8_t channels;
    uint8_t bits_per_sample;
} voice_protocol_frame_header_t;

typedef struct {
    bool active;
    bool ended;
    uint8_t session_id[16];
    uint32_t stream_id;
    uint32_t epoch;
    uint32_t next_sequence;
    uint32_t dropped_frames;
} voice_protocol_rx_tracker_t;

voice_protocol_result_t voice_protocol_encode_header(
    const voice_protocol_frame_header_t *header,
    uint8_t *output,
    size_t output_size);
voice_protocol_result_t voice_protocol_decode_header(
    const uint8_t *input,
    size_t input_size,
    voice_protocol_frame_header_t *header);
voice_protocol_result_t voice_protocol_decode_frame(
    const uint8_t *input,
    size_t input_size,
    voice_protocol_frame_header_t *header,
    const uint8_t **payload);
voice_protocol_result_t voice_protocol_validate_header(
    const voice_protocol_frame_header_t *header);
voice_protocol_result_t voice_protocol_rx_begin(
    voice_protocol_rx_tracker_t *tracker,
    const uint8_t session_id[16],
    uint32_t stream_id,
    uint32_t epoch);
voice_protocol_result_t voice_protocol_rx_accept(
    voice_protocol_rx_tracker_t *tracker,
    const voice_protocol_frame_header_t *header);
const char *voice_protocol_result_name(voice_protocol_result_t result);
