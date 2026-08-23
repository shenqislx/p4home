#include "voice_protocol.h"

#include <string.h>

static const uint8_t VOICE_PROTOCOL_MAGIC[4] = {'P', '4', 'V', '1'};

static void write_u16_le(uint8_t *output, uint16_t value)
{
    output[0] = (uint8_t)value;
    output[1] = (uint8_t)(value >> 8);
}

static void write_u32_le(uint8_t *output, uint32_t value)
{
    for (size_t i = 0; i < 4; ++i) {
        output[i] = (uint8_t)(value >> (i * 8));
    }
}

static void write_u64_le(uint8_t *output, uint64_t value)
{
    for (size_t i = 0; i < 8; ++i) {
        output[i] = (uint8_t)(value >> (i * 8));
    }
}

static uint16_t read_u16_le(const uint8_t *input)
{
    return (uint16_t)input[0] | ((uint16_t)input[1] << 8);
}

static uint32_t read_u32_le(const uint8_t *input)
{
    uint32_t value = 0;
    for (size_t i = 0; i < 4; ++i) {
        value |= (uint32_t)input[i] << (i * 8);
    }
    return value;
}

static uint64_t read_u64_le(const uint8_t *input)
{
    uint64_t value = 0;
    for (size_t i = 0; i < 8; ++i) {
        value |= (uint64_t)input[i] << (i * 8);
    }
    return value;
}

static bool session_id_is_zero(const uint8_t session_id[16])
{
    uint8_t combined = 0;
    for (size_t i = 0; i < 16; ++i) {
        combined |= session_id[i];
    }
    return combined == 0;
}

voice_protocol_result_t voice_protocol_validate_header(
    const voice_protocol_frame_header_t *header)
{
    if (header == NULL) {
        return VOICE_PROTOCOL_INVALID_ARGUMENT;
    }
    if (header->kind != VOICE_PROTOCOL_FRAME_CAPTURE_PCM &&
        header->kind != VOICE_PROTOCOL_FRAME_PLAYBACK_PCM) {
        return VOICE_PROTOCOL_INVALID_KIND;
    }
    if ((header->flags & ~(VOICE_PROTOCOL_FLAG_END_OF_STREAM |
                           VOICE_PROTOCOL_FLAG_DISCONTINUITY)) != 0U) {
        return VOICE_PROTOCOL_INVALID_FLAGS;
    }
    if (session_id_is_zero(header->session_id)) {
        return VOICE_PROTOCOL_INVALID_SESSION;
    }
    if (header->stream_id == 0U) {
        return VOICE_PROTOCOL_INVALID_STREAM;
    }
    if (header->epoch == 0U) {
        return VOICE_PROTOCOL_INVALID_EPOCH;
    }
    if (header->sample_rate_hz != VOICE_PROTOCOL_SAMPLE_RATE_HZ ||
        header->channels != VOICE_PROTOCOL_CHANNELS ||
        header->bits_per_sample != VOICE_PROTOCOL_BITS_PER_SAMPLE ||
        header->frame_samples == 0U ||
        header->frame_samples > VOICE_PROTOCOL_FRAME_SAMPLES) {
        return VOICE_PROTOCOL_INVALID_GEOMETRY;
    }
    if ((header->flags & VOICE_PROTOCOL_FLAG_END_OF_STREAM) == 0U &&
        header->frame_samples != VOICE_PROTOCOL_FRAME_SAMPLES) {
        return VOICE_PROTOCOL_INVALID_GEOMETRY;
    }
    if (header->sequence == UINT32_MAX &&
        (header->flags & VOICE_PROTOCOL_FLAG_END_OF_STREAM) == 0U) {
        return VOICE_PROTOCOL_INVALID_HEADER;
    }
    const uint32_t expected_payload =
        (uint32_t)header->frame_samples * header->channels *
        (header->bits_per_sample / 8U);
    if (header->payload_bytes != expected_payload) {
        return VOICE_PROTOCOL_INVALID_PAYLOAD;
    }
    return VOICE_PROTOCOL_OK;
}

voice_protocol_result_t voice_protocol_encode_header(
    const voice_protocol_frame_header_t *header,
    uint8_t *output,
    size_t output_size)
{
    if (output == NULL || output_size < VOICE_PROTOCOL_HEADER_BYTES) {
        return VOICE_PROTOCOL_INVALID_ARGUMENT;
    }
    voice_protocol_result_t result = voice_protocol_validate_header(header);
    if (result != VOICE_PROTOCOL_OK) {
        return result;
    }
    memcpy(output, VOICE_PROTOCOL_MAGIC, sizeof(VOICE_PROTOCOL_MAGIC));
    output[4] = VOICE_PROTOCOL_VERSION;
    output[5] = VOICE_PROTOCOL_HEADER_BYTES;
    output[6] = (uint8_t)header->kind;
    output[7] = header->flags;
    memcpy(output + 8, header->session_id, sizeof(header->session_id));
    write_u32_le(output + 24, header->stream_id);
    write_u32_le(output + 28, header->epoch);
    write_u32_le(output + 32, header->sequence);
    write_u64_le(output + 36, header->capture_time_us);
    write_u32_le(output + 44, header->payload_bytes);
    write_u32_le(output + 48, header->sample_rate_hz);
    write_u16_le(output + 52, header->frame_samples);
    output[54] = header->channels;
    output[55] = header->bits_per_sample;
    return VOICE_PROTOCOL_OK;
}

voice_protocol_result_t voice_protocol_decode_header(
    const uint8_t *input,
    size_t input_size,
    voice_protocol_frame_header_t *header)
{
    if (input == NULL || header == NULL || input_size < VOICE_PROTOCOL_HEADER_BYTES) {
        return VOICE_PROTOCOL_INVALID_ARGUMENT;
    }
    if (memcmp(input, VOICE_PROTOCOL_MAGIC, sizeof(VOICE_PROTOCOL_MAGIC)) != 0) {
        return VOICE_PROTOCOL_INVALID_MAGIC;
    }
    if (input[4] != VOICE_PROTOCOL_VERSION) {
        return VOICE_PROTOCOL_UNSUPPORTED_VERSION;
    }
    if (input[5] != VOICE_PROTOCOL_HEADER_BYTES) {
        return VOICE_PROTOCOL_INVALID_HEADER;
    }
    memset(header, 0, sizeof(*header));
    header->kind = (voice_protocol_frame_kind_t)input[6];
    header->flags = input[7];
    memcpy(header->session_id, input + 8, sizeof(header->session_id));
    header->stream_id = read_u32_le(input + 24);
    header->epoch = read_u32_le(input + 28);
    header->sequence = read_u32_le(input + 32);
    header->capture_time_us = read_u64_le(input + 36);
    header->payload_bytes = read_u32_le(input + 44);
    header->sample_rate_hz = read_u32_le(input + 48);
    header->frame_samples = read_u16_le(input + 52);
    header->channels = input[54];
    header->bits_per_sample = input[55];
    return voice_protocol_validate_header(header);
}

voice_protocol_result_t voice_protocol_decode_frame(
    const uint8_t *input,
    size_t input_size,
    voice_protocol_frame_header_t *header,
    const uint8_t **payload)
{
    if (payload == NULL) {
        return VOICE_PROTOCOL_INVALID_ARGUMENT;
    }
    voice_protocol_result_t result = voice_protocol_decode_header(input, input_size, header);
    if (result != VOICE_PROTOCOL_OK) {
        return result;
    }
    const size_t expected_size = VOICE_PROTOCOL_HEADER_BYTES + (size_t)header->payload_bytes;
    if (input_size != expected_size) {
        return VOICE_PROTOCOL_INVALID_PAYLOAD;
    }
    *payload = input + VOICE_PROTOCOL_HEADER_BYTES;
    return VOICE_PROTOCOL_OK;
}

voice_protocol_result_t voice_protocol_rx_begin(
    voice_protocol_rx_tracker_t *tracker,
    const uint8_t session_id[16],
    uint32_t stream_id,
    uint32_t epoch)
{
    if (tracker == NULL || session_id == NULL) {
        return VOICE_PROTOCOL_INVALID_ARGUMENT;
    }
    if (session_id_is_zero(session_id)) {
        return VOICE_PROTOCOL_INVALID_SESSION;
    }
    if (stream_id == 0U) {
        return VOICE_PROTOCOL_INVALID_STREAM;
    }
    if (epoch == 0U) {
        return VOICE_PROTOCOL_INVALID_EPOCH;
    }
    memset(tracker, 0, sizeof(*tracker));
    tracker->active = true;
    memcpy(tracker->session_id, session_id, sizeof(tracker->session_id));
    tracker->stream_id = stream_id;
    tracker->epoch = epoch;
    return VOICE_PROTOCOL_OK;
}

voice_protocol_result_t voice_protocol_rx_accept(
    voice_protocol_rx_tracker_t *tracker,
    const voice_protocol_frame_header_t *header)
{
    if (tracker == NULL || header == NULL || !tracker->active) {
        return VOICE_PROTOCOL_INVALID_ARGUMENT;
    }
    voice_protocol_result_t result = voice_protocol_validate_header(header);
    if (result != VOICE_PROTOCOL_OK) {
        return result;
    }
    if (memcmp(tracker->session_id, header->session_id, sizeof(tracker->session_id)) != 0 ||
        tracker->stream_id != header->stream_id || tracker->epoch != header->epoch) {
        return VOICE_PROTOCOL_STALE_FRAME;
    }
    if (tracker->ended) {
        return VOICE_PROTOCOL_AFTER_EOS;
    }
    if (header->sequence < tracker->next_sequence) {
        return VOICE_PROTOCOL_STALE_FRAME;
    }
    if (header->sequence > tracker->next_sequence) {
        if ((header->flags & VOICE_PROTOCOL_FLAG_DISCONTINUITY) == 0U) {
            return VOICE_PROTOCOL_SEQUENCE_GAP;
        }
        tracker->dropped_frames += header->sequence - tracker->next_sequence;
    } else if ((header->flags & VOICE_PROTOCOL_FLAG_DISCONTINUITY) != 0U) {
        return VOICE_PROTOCOL_INVALID_FLAGS;
    }
    tracker->next_sequence = header->sequence + 1U;
    if ((header->flags & VOICE_PROTOCOL_FLAG_END_OF_STREAM) != 0U) {
        tracker->ended = true;
    }
    return VOICE_PROTOCOL_OK;
}

const char *voice_protocol_result_name(voice_protocol_result_t result)
{
    static const char *const names[] = {
        "ok", "invalid_argument", "invalid_magic", "unsupported_version",
        "invalid_header", "invalid_kind", "invalid_flags", "invalid_session",
        "invalid_stream", "invalid_epoch", "invalid_geometry", "invalid_payload",
        "stale_frame", "sequence_gap", "after_eos",
    };
    const size_t count = sizeof(names) / sizeof(names[0]);
    return (size_t)result < count ? names[result] : "unknown";
}
