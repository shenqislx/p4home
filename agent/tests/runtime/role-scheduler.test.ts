import assert from "node:assert/strict";
import test from "node:test";

import {
  RoleScheduler,
  RoleSchedulerError,
} from "@p4home/runtime";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("scheduler alternates Human and Robot while keeping Cat behind user work", async () => {
  const scheduler = new RoleScheduler();
  const gate = deferred();
  const order: string[] = [];
  const first = scheduler.schedule({
    role_id: "human",
    async execute() {
      order.push("human-1");
      await gate.promise;
      return "human-1";
    },
  });
  const cat = scheduler.schedule({
    role_id: "cat",
    async execute() {
      order.push("cat-1");
      return "cat-1";
    },
  });
  const human = scheduler.schedule({
    role_id: "human",
    async execute() {
      order.push("human-2");
      return "human-2";
    },
  });
  const robot = scheduler.schedule({
    role_id: "robot",
    async execute() {
      order.push("robot-1");
      return "robot-1";
    },
  });

  gate.resolve();
  assert.deepEqual(await Promise.all([first, cat, human, robot]), [
    "human-1",
    "cat-1",
    "human-2",
    "robot-1",
  ]);
  assert.deepEqual(order, ["human-1", "robot-1", "human-2", "cat-1"]);
  assert.equal(scheduler.pending, 0);
});

test("scheduler bounds pending work and removes a cancelled task before execution", async () => {
  const scheduler = new RoleScheduler(1);
  const gate = deferred();
  const running = scheduler.schedule({
    role_id: "human",
    async execute() {
      await gate.promise;
      return "done";
    },
  });
  const controller = new AbortController();
  const cancelled = scheduler.schedule({
    role_id: "cat",
    signal: controller.signal,
    async execute() {
      throw new Error("cancelled Cat task must not execute");
    },
  });
  await assert.rejects(
    scheduler.schedule({ role_id: "robot", async execute() { return "never"; } }),
    (error) => error instanceof RoleSchedulerError && error.code === "QUEUE_FULL",
  );
  controller.abort();
  await assert.rejects(
    cancelled,
    (error) => error instanceof RoleSchedulerError && error.code === "CANCELLED",
  );
  gate.resolve();
  assert.equal(await running, "done");
  assert.equal(scheduler.pending, 0);
});

test("closing the scheduler rejects queued and future tasks", async () => {
  const scheduler = new RoleScheduler();
  const gate = deferred();
  const running = scheduler.schedule({
    role_id: "human",
    async execute() {
      await gate.promise;
      return "done";
    },
  });
  const queued = scheduler.schedule({ role_id: "cat", async execute() { return "cat"; } });
  scheduler.close();
  await assert.rejects(
    queued,
    (error) => error instanceof RoleSchedulerError && error.code === "CLOSED",
  );
  await assert.rejects(
    scheduler.schedule({ role_id: "robot", async execute() { return "robot"; } }),
    (error) => error instanceof RoleSchedulerError && error.code === "CLOSED",
  );
  gate.resolve();
  assert.equal(await running, "done");
});
