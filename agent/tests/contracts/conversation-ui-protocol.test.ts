import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationUiProtocolError,
  validateConversationUiApplied,
  validateConversationUiUpdate,
} from "@p4home/contracts";

const identity = {
  ui_protocol_version: 1,
  session_id: "42".repeat(16),
  stream_id: 7,
  epoch: 9,
  revision: 1,
} as const;

test("Conversation UI v1 keeps presentation separate from Device and Voice Protocol v1", () => {
  const update = {
    ...identity,
    type: "ui.update",
    stage: "completed",
    user_text: "打开书房灯",
    response_text: "书房灯已打开。",
    response_role: "robot",
    execution_status: "completed",
  } as const;
  assert.deepEqual(validateConversationUiUpdate(update), update);
  assert.deepEqual(validateConversationUiApplied({ ...identity, type: "ui.applied" }), {
    ...identity, type: "ui.applied",
  });
  assert.throws(() => validateConversationUiUpdate({ ...update, tool_call: "home.turn_on" }),
    ConversationUiProtocolError);
  assert.throws(() => validateConversationUiUpdate({ ...update, protocol_version: 1 }),
    ConversationUiProtocolError);
});

test("Conversation UI v1 enforces stage truth instead of trusting display prose", () => {
  assert.throws(() => validateConversationUiUpdate({
    ...identity,
    type: "ui.update",
    stage: "completed",
    user_text: "打开书房灯",
    response_text: "已经打开",
    response_role: "human",
    execution_status: "pending",
  }), ConversationUiProtocolError);
  assert.throws(() => validateConversationUiUpdate({
    ...identity,
    type: "ui.update",
    stage: "listening",
    user_text: "不应存在",
    response_text: "",
    response_role: "none",
    execution_status: "not_applicable",
  }), ConversationUiProtocolError);
  assert.doesNotThrow(() => validateConversationUiUpdate({
    ...identity,
    type: "ui.update",
    stage: "failed",
    user_text: "打开书房灯",
    response_text: "设备操作结果尚不确定。",
    response_role: "system",
    execution_status: "unknown",
  }));
});

test("Conversation UI v1 bounds UTF-8 text and fences identity", () => {
  const thinking = {
    ...identity,
    type: "ui.update",
    stage: "thinking",
    user_text: "你好",
    response_text: "",
    response_role: "none",
    execution_status: "pending",
  } as const;
  assert.doesNotThrow(() => validateConversationUiUpdate(thinking));
  assert.throws(() => validateConversationUiUpdate({ ...thinking, revision: 0 }),
    ConversationUiProtocolError);
  assert.throws(() => validateConversationUiUpdate({ ...thinking, epoch: 0 }),
    ConversationUiProtocolError);
  assert.throws(() => validateConversationUiUpdate({ ...thinking, user_text: "你".repeat(257) }),
    ConversationUiProtocolError);
  assert.throws(() => validateConversationUiUpdate({ ...thinking, user_text: "hello\u0000world" }),
    ConversationUiProtocolError);
  assert.doesNotThrow(() => validateConversationUiUpdate({
    ...thinking, user_text: "你好，P4 😺",
  }));
  assert.throws(() => validateConversationUiUpdate({ ...thinking, user_text: "bad\ud800text" }),
    ConversationUiProtocolError);
  assert.throws(() => validateConversationUiUpdate({ ...thinking, user_text: "bad\udc00text" }),
    ConversationUiProtocolError);
});
