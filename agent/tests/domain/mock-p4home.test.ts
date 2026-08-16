import assert from "node:assert/strict";
import test from "node:test";

import { runSequentialToolCalls } from "@p4home/core";
import { createMockP4HomeDomain } from "@p4home/domain-p4home";

test("mock character tools run a room move and speech without a real P4", async () => {
  const domain = createMockP4HomeDomain();
  const result = await runSequentialToolCalls({
    run_id: "run-domain-1",
    tools: domain.tools,
    calls: [
      {
        tool_call_id: "move-1",
        name: "character.go_to_room",
        arguments: { room_id: "study" },
      },
      {
        tool_call_id: "say-1",
        name: "character.say",
        arguments: { text: "我到了" },
      },
    ],
  });

  assert.equal(result.status, "completed");
  assert.equal(domain.getState().room_id, "study");
  assert.equal(domain.getStateVersion(), 3);
  assert.deepEqual(result.results[0]?.result, { room_id: "study" });
  assert.deepEqual(result.results[1]?.result, { text: "我到了" });
});

test("unknown room returns the frozen UNKNOWN_ROOM error", async () => {
  const domain = createMockP4HomeDomain();
  const result = await runSequentialToolCalls({
    run_id: "run-domain-2",
    tools: domain.tools,
    calls: [
      {
        tool_call_id: "move-invalid",
        name: "character.go_to_room",
        arguments: { room_id: "balcony" },
      },
    ],
  });
  assert.equal(result.status, "failed");
  assert.equal(result.results[0]?.error?.code, "UNKNOWN_ROOM");
  assert.equal(domain.getState().room_id, "living_room");
});

test("mock side-effect tools reject an aborted execution before mutating state", async () => {
  const domain = createMockP4HomeDomain();
  const tool = domain.tools.get("character.go_to_room");
  assert.ok(tool !== undefined);
  const controller = new AbortController();
  controller.abort(new Error("cancelled before execution"));

  await assert.rejects(
    tool.execute(
      { room_id: "study" },
      { run_id: "run-cancelled", tool_call_id: "move-cancelled", signal: controller.signal },
    ),
    /tool execution was cancelled/,
  );
  assert.equal(domain.getState().room_id, "living_room");
  assert.equal(domain.getStateVersion(), 1);
});
