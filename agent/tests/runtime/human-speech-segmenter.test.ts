import assert from "node:assert/strict";
import test from "node:test";

import {
  HUMAN_SPEECH_SEGMENT_MAX_CHARS,
  HumanSpeechSegmenter,
} from "../../apps/runtime/src/human-speech-segmenter.ts";

test("Human speech segmenter emits complete Chinese clauses across arbitrary deltas", () => {
  const segmenter = new HumanSpeechSegmenter();
  assert.deepEqual(segmenter.push("你好，今"), []);
  assert.deepEqual(segmenter.push("天天气不错。我们"), ["你好，今天天气不错。"]);
  assert.deepEqual(segmenter.push("出去走走吧！"), ["我们出去走走吧！"]);
  assert.deepEqual(segmenter.finish(), []);
});

test("Human speech segmenter uses a bounded hard split without cutting surrogate pairs", () => {
  const segmenter = new HumanSpeechSegmenter();
  const input = `😀${"长".repeat(HUMAN_SPEECH_SEGMENT_MAX_CHARS)}`;
  const segments = segmenter.push(input);
  assert.equal(segments.length, 1);
  assert.equal([...segments[0]!].length, HUMAN_SPEECH_SEGMENT_MAX_CHARS);
  assert.equal(segments[0]?.startsWith("😀"), true);
  assert.deepEqual(segmenter.finish(), ["长"]);
});

test("Human speech segmenter emits a long soft clause and flushes a short tail", () => {
  const segmenter = new HumanSpeechSegmenter();
  assert.deepEqual(segmenter.push(`${"内容".repeat(12)}，后半句`), [
    `${"内容".repeat(12)}，`,
  ]);
  assert.deepEqual(segmenter.finish(), ["后半句"]);
});

test("Human speech segmenter rejects controls and can discard retained text", () => {
  const segmenter = new HumanSpeechSegmenter();
  segmenter.push("尚未完成");
  segmenter.discard();
  assert.deepEqual(segmenter.finish(), []);
  assert.throws(() => segmenter.push("正常\u0000伪造"), /control-free/);
});
