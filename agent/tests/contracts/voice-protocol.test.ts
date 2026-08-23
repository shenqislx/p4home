import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeVoiceFrameHeader,
  decodeVoiceFrame,
  encodeVoiceFrameHeader,
  validateVoiceControlMessage,
  VoiceFrameTracker,
  VoiceSessionFlowTracker,
  VOICE_BITS_PER_SAMPLE,
  VOICE_CHANNELS,
  VOICE_FLAG_DISCONTINUITY,
  VOICE_FLAG_END_OF_STREAM,
  VOICE_FRAME_PAYLOAD_BYTES,
  VOICE_FRAME_SAMPLES,
  VOICE_SAMPLE_RATE_HZ,
  type VoiceFrameHeader,
  VoiceProtocolError,
} from "@p4home/contracts";

function frame(sequence = 0, flags = 0): VoiceFrameHeader {
  const sessionId = new Uint8Array(16);
  sessionId[0] = 0x42;
  sessionId[15] = 0x24;
  return {
    kind: "capture_pcm", flags, sessionId, streamId: 7, epoch: 3, sequence,
    captureTimeUs: 1_000n + BigInt(sequence) * 20_000n,
    payloadBytes: VOICE_FRAME_PAYLOAD_BYTES, sampleRateHz: VOICE_SAMPLE_RATE_HZ,
    frameSamples: VOICE_FRAME_SAMPLES, channels: VOICE_CHANNELS,
    bitsPerSample: VOICE_BITS_PER_SAMPLE,
  };
}

test("Voice Protocol v1 encodes the fixed little-endian PCM header", () => {
  const expected = frame();
  const encoded = encodeVoiceFrameHeader(expected);
  assert.equal(encoded.byteLength, 56);
  assert.equal(Buffer.from(encoded.subarray(0, 4)).toString("ascii"), "P4V1");
  assert.deepEqual(decodeVoiceFrameHeader(encoded), expected);
  encoded[0] = 0;
  assert.throws(() => decodeVoiceFrameHeader(encoded), VoiceProtocolError);
});

test("Voice Protocol v1 validates the complete binary message length", () => {
  const header = encodeVoiceFrameHeader(frame());
  const complete = new Uint8Array(header.byteLength + VOICE_FRAME_PAYLOAD_BYTES);
  complete.set(header);
  complete.fill(0x5a, header.byteLength);
  assert.equal(decodeVoiceFrame(complete).payload.byteLength, VOICE_FRAME_PAYLOAD_BYTES);
  assert.throws(() => decodeVoiceFrame(complete.subarray(0, complete.byteLength - 1)), VoiceProtocolError);
  assert.throws(() => decodeVoiceFrame(header), VoiceProtocolError);
});

test("Voice Protocol v1 rejects geometry drift and payload mismatch", () => {
  assert.throws(() => encodeVoiceFrameHeader({ ...frame(), sampleRateHz: 48_000 }), VoiceProtocolError);
  assert.throws(() => encodeVoiceFrameHeader({ ...frame(), payloadBytes: 638 }), VoiceProtocolError);
  assert.throws(() => encodeVoiceFrameHeader({ ...frame(), frameSamples: 160, payloadBytes: 320 }), VoiceProtocolError);
  assert.doesNotThrow(() => encodeVoiceFrameHeader({
    ...frame(0, VOICE_FLAG_END_OF_STREAM), frameSamples: 160, payloadBytes: 320,
  }));
  assert.throws(() => encodeVoiceFrameHeader(frame(0xffff_ffff)), VoiceProtocolError);
  assert.doesNotThrow(() => encodeVoiceFrameHeader(frame(0xffff_ffff, VOICE_FLAG_END_OF_STREAM)));
  assert.throws(() => encodeVoiceFrameHeader({ ...frame(), flags: 0x1_0000_0000 }), VoiceProtocolError);
  assert.throws(() => encodeVoiceFrameHeader({ ...frame(), flags: Number.NaN }), VoiceProtocolError);
});

test("Voice frame tracker fences epochs and makes loss explicit", () => {
  const tracker = new VoiceFrameTracker(frame().sessionId, 7, 3);
  tracker.accept(frame(0));
  assert.throws(() => tracker.accept(frame(2)), (error) =>
    error instanceof VoiceProtocolError && error.code === "SEQUENCE_GAP");
  tracker.accept(frame(2, VOICE_FLAG_DISCONTINUITY));
  assert.equal(tracker.droppedFrames, 1);
  assert.throws(() => tracker.accept(frame(2)), VoiceProtocolError);
  assert.throws(() => tracker.accept({ ...frame(3), epoch: 4 }), VoiceProtocolError);
  tracker.accept({ ...frame(3, VOICE_FLAG_END_OF_STREAM), frameSamples: 160, payloadBytes: 320 });
  assert.equal(tracker.ended, true);
  assert.throws(() => tracker.accept(frame(4)), VoiceProtocolError);
});

test("Voice control schema accepts bounded sessions and rejects expanded formats", () => {
  const open = {
    protocol_version: 1, type: "session.open", session_id: "42".repeat(16),
    stream_id: 7, epoch: 3, direction: "capture",
    format: { encoding: "pcm_s16le", sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, frame_samples: 320 },
    max_inflight_frames: 8,
  };
  assert.deepEqual(validateVoiceControlMessage(open), open);
  assert.throws(() => validateVoiceControlMessage({
    ...open, format: { ...open.format, sample_rate_hz: 48000 },
  }), VoiceProtocolError);
  assert.throws(() => validateVoiceControlMessage({ ...open, max_inflight_frames: 65 }), VoiceProtocolError);
  assert.throws(() => validateVoiceControlMessage({ ...open, token: "must-not-be-here" }), VoiceProtocolError);
  assert.throws(() => validateVoiceControlMessage({ ...open, session_id: "0".repeat(32) }), VoiceProtocolError);
});

test("Voice session flow enforces lifecycle, epoch and negotiated credit", () => {
  const sessionId = `42${"00".repeat(14)}24`;
  const identity = { protocol_version: 1, session_id: sessionId, stream_id: 7, epoch: 3 } as const;
  const open = {
    ...identity, type: "session.open", direction: "capture",
    format: { encoding: "pcm_s16le", sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, frame_samples: 320 },
    max_inflight_frames: 2,
  };
  const ready = { ...identity, type: "session.ready", initial_credit_frames: 2 };
  const credit = (ackSequence: number, grantFrames: number) => ({
    ...identity, type: "credit", ack_sequence: ackSequence, grant_frames: grantFrames,
  });
  const flow = new VoiceSessionFlowTracker();
  assert.throws(() => flow.acceptControl(credit(0, 1)), VoiceProtocolError);
  flow.acceptControl(open);
  assert.throws(() => flow.acceptControl({ ...ready, initial_credit_frames: 3 }), VoiceProtocolError);
  flow.acceptControl(ready);
  flow.recordFrameSent(frame(0));
  flow.recordFrameSent(frame(1));
  assert.throws(() => flow.recordFrameSent(frame(2)), VoiceProtocolError);
  assert.throws(() => flow.acceptControl(credit(2, 1)), VoiceProtocolError);
  flow.acceptControl(credit(0, 1));
  assert.equal(flow.availableCredit, 1);
  assert.equal(flow.outstandingFrames, 1);
  flow.recordFrameSent({ ...frame(2, VOICE_FLAG_END_OF_STREAM), frameSamples: 160, payloadBytes: 320 });
  flow.acceptControl(credit(2, 2));
  flow.acceptControl({ ...identity, type: "session.eos", final_sequence: 2, reason: "vad_end" });
  assert.throws(() => flow.acceptControl(credit(2, 1)), VoiceProtocolError);
  flow.acceptControl({ ...identity, type: "session.closed", status: "completed", dropped_frames: 0 });
  assert.equal(flow.state, "closed");
});
