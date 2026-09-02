import assert from "node:assert/strict";
import test from "node:test";

import type { OllamaChatRequest, OllamaChatResult } from "@p4home/provider-ollama";
import { SqliteAuditStore, type AuditStore } from "@p4home/storage-sqlite";
import {
  HUMAN_AVATAR_ID,
  DeviceWebSocketActionAdapter,
  getHumanAvatarExecutorProfile,
  RoleScheduler,
  RoleSessionRegistry,
  UnifiedVoiceRoleDispatcher,
  routeInteraction,
  runHumanAvatarAction,
  runRoleInteraction,
  type DeviceActionSpec,
  type DeviceActionOutcome,
  type DeviceWebSocketConnection,
  type HumanAvatarDeviceRuntime,
  type RoutePlan,
  type UserTextInteraction,
  validateRoutePlan,
} from "@p4home/runtime";

class RacingHumanAvatarConnection implements DeviceWebSocketConnection {
  public is_open_base = true;
  public send_calls = 0;
  #armedFailureRead = 0;
  #readsAfterArm = 0;
  #frameListener: ((frame: string) => void) | null = null;
  #closeListeners = new Set<() => void>();

  public get is_open(): boolean {
    if (this.#armedFailureRead > 0 && ++this.#readsAfterArm === this.#armedFailureRead) {
      return false;
    }
    return this.is_open_base;
  }

  public armCloseCheck(readNumber: number): void {
    this.#armedFailureRead = readNumber;
    this.#readsAfterArm = 0;
  }

  public async send(_frame: string): Promise<void> {
    this.send_calls++;
  }

  public close(): void {
    this.is_open_base = false;
    for (const listener of this.#closeListeners) listener();
  }

  public onFrame(listener: (frame: string) => void): () => void {
    this.#frameListener = listener;
    return () => { this.#frameListener = null; };
  }

  public onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  public receive(seq: number, type: string, payload: Record<string, unknown>): void {
    this.#frameListener?.(JSON.stringify({
      protocol_version: 3,
      message_id: `race-device-${seq}`,
      correlation_id: null,
      device_id: "p4-human-avatar-race",
      session_id: "human-avatar-race-session",
      seq,
      sent_at_ms: 1_000 + seq,
      type,
      payload,
    }));
  }
}

function racingHumanAvatarAdapter(): {
  readonly connection: RacingHumanAvatarConnection;
  readonly adapter: DeviceWebSocketActionAdapter;
} {
  const connection = new RacingHumanAvatarConnection();
  const adapter = new DeviceWebSocketActionAdapter(connection, {
    device_id: "p4-human-avatar-race",
    protocol_version: 3,
    actor_id: HUMAN_AVATAR_ID,
  });
  connection.receive(0, "device.hello", {
    boot_id: "human-avatar-race-boot",
    firmware_version: "test",
    protocol_versions: [1, 2, 3],
    connection_reason: "test",
  });
  connection.receive(1, "device.capabilities", {
    actor_id: HUMAN_AVATAR_ID,
    selected_protocol_version: 3,
    rooms: ["primary_bedroom", "study", "guest_room", "entry", "living_room", "kitchen"],
    actions: [
      "character.get_state", "character.go_to_room", "character.set_activity",
      "character.say", "world.get_snapshot", "character.go_to", "character.sit",
      "character.look_at", "character.interact",
    ],
    objects: [
      { object_id: "living_room.sofa", room_id: "living_room", supported_actions: ["go_to", "sit", "look_at", "interact"], available: true },
      { object_id: "study.desk", room_id: "study", supported_actions: ["go_to", "look_at", "interact"], available: true },
      { object_id: "living_room.window", room_id: "living_room", supported_actions: ["go_to", "look_at", "interact"], available: true },
    ],
    limits: { max_json_frame_bytes: 16_384, action_queue_capacity: 8, say_text_max_chars: 256, action_timeout_min_ms: 100, action_timeout_max_ms: 120_000, idempotency_retention_ms: 600_000 },
  });
  connection.receive(2, "world.snapshot", {
    actor_id: HUMAN_AVATAR_ID,
    snapshot_id: "human-avatar-race-snapshot",
    reason: "connect",
    state_version: 1,
    observed_at_ms: 1_002,
    character: { room_id: "living_room", activity: "idle", speaking: false, active_action_id: null, target_object_id: null, pose: "standing" },
    objects: [
      { object_id: "living_room.sofa", room_id: "living_room", available: true, occupied: false },
      { object_id: "study.desk", room_id: "study", available: true, occupied: false },
      { object_id: "living_room.window", room_id: "living_room", available: true, occupied: false },
    ],
  });
  assert.equal(adapter.is_ready, true);
  return { connection, adapter };
}

function interaction(text: string): UserTextInteraction {
  return {
    schema_version: 1,
    interaction_id: "interaction:human-avatar",
    kind: "user_text",
    text,
    locale: "zh-CN",
    source: "voice",
    received_at_ms: 1_000,
  };
}

function response(
  toolCalls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[],
  content = "",
): OllamaChatResult {
  return {
    model: "fake",
    message: {
      role: "assistant",
      content,
      thinking: "",
      tool_calls: toolCalls.map((call) => ({
        type: "function" as const,
        function: call,
      })),
    },
  };
}

function avatarProvider(
  value: UserTextInteraction,
  toolCalls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[],
) {
  let calls = 0;
  return {
    async chat(): Promise<OllamaChatResult> {
      calls++;
      return calls === 1
        ? {
            model: "fake",
            message: {
              role: "assistant",
              content: JSON.stringify({ assignments: [{ role: "avatar", text: value.text }] }),
            },
          }
        : response(toolCalls);
    },
  };
}

class FakeHumanAvatarDevice implements HumanAvatarDeviceRuntime {
  public readonly is_ready = true;
  public readonly protocol_version = 3;
  public readonly room_capabilities = ["living_room", "study"] as const;
  public readonly action_capabilities = [
    "character.go_to_room",
    "character.go_to",
    "character.sit",
    "character.look_at",
    "character.interact",
  ] as const;
  public readonly object_capabilities = [{
    object_id: "living_room.sofa",
    room_id: "living_room",
    supported_actions: ["go_to", "sit", "look_at", "interact"],
    available: true,
  }] as const;
  public readonly last_snapshot = {
    snapshot_id: "snapshot:human-avatar",
    reason: "connect" as const,
    state_version: 1,
    observed_at_ms: 1_000,
    actor_id: HUMAN_AVATAR_ID,
    character: {
      room_id: "living_room" as const,
      activity: "idle" as const,
      speaking: false,
      active_action_id: null,
      target_object_id: null,
      pose: "standing" as const,
    },
    objects: [{
      object_id: "living_room.sofa" as const,
      room_id: "living_room" as const,
      available: true,
      occupied: false,
    }],
  };
  public readonly calls: DeviceActionSpec[] = [];
  public failAt = -1;

  public async executeAction(spec: DeviceActionSpec): Promise<DeviceActionOutcome> {
    spec.on_dispatched?.();
    this.calls.push(spec);
    if (this.calls.length - 1 === this.failAt) {
      return {
        status: "failed",
        action_id: spec.action_id,
        error: { code: "DEVICE_BUSY", message: "busy", retryable: true },
      };
    }
    const result = spec.tool === "character.go_to_room"
      ? { room_id: spec.arguments.room_id }
      : spec.tool === "character.sit"
        ? { object_id: spec.arguments.target_id, action: "sit", pose: "sitting" }
        : {
            object_id: spec.arguments.target_id,
            action: spec.tool.replace("character.", ""),
            pose: "standing",
          };
    return {
      status: "completed",
      action_id: spec.action_id,
      tool: spec.tool,
      state_version: this.calls.length + 1,
      result,
      source: "lifecycle",
    };
  }
}

test("Router creates one Human avatar assignment without creating a Cat role", async () => {
  const value = interaction("让屏幕上的 Human 去客厅沙发坐下");
  const routed = await routeInteraction({
    interaction: value,
    route_plan_id: "route:human-avatar",
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return {
          model: "fake",
          message: {
            role: "assistant",
            content: JSON.stringify({ assignments: [{ role: "avatar", text: value.text }] }),
          },
        };
      },
    },
    human_only: true,
    clock: () => 1_001,
  });
  assert.equal(routed.plan.reason, "model_human_avatar");
  assert.equal(routed.plan.schema_version, 3);
  assert.deepEqual(routed.plan.assignments, [{
    assignment_id: "route:human-avatar",
    role_id: "human",
    source_span: { start: 0, end: value.text.length },
    mode: "respond",
    capability: "avatar",
  }]);
  assert.equal(routed.plan.assignments.some((item) => item.role_id === ("cat" as never)), false);
});

test("Router contract accepts a direct avatar imperative with the Human subject omitted", async () => {
  const value = interaction("去客厅沙发坐下");
  const routed = await routeInteraction({
    interaction: value,
    route_plan_id: "route:human-avatar-imperative",
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        assert.match(request.messages[0]?.content ?? "", /省略 Human 主语/);
        return {
          model: "fake",
          message: {
            role: "assistant",
            content: JSON.stringify({ assignments: [{ role: "avatar", text: value.text }] }),
          },
        };
      },
    },
    human_only: true,
  });
  assert.equal(routed.plan.schema_version, 3);
  assert.equal(routed.plan.reason, "model_human_avatar");
});

test("frozen RoutePlan v2 rejects an injected avatar capability", () => {
  const value = interaction("让屏幕上的 Human 去客厅");
  const forged = {
    schema_version: 2,
    route_plan_id: "route:forged-v2-avatar",
    interaction_id: value.interaction_id,
    assignments: [{
      assignment_id: "assignment:forged-v2-avatar",
      role_id: "human",
      source_span: { start: 0, end: value.text.length },
      mode: "respond",
      capability: "avatar",
    }],
    reason: "model_human_avatar",
    created_at_ms: 1_001,
  } as unknown as RoutePlan;
  assert.throws(() => validateRoutePlan(forged, value), /RoutePlan v2|RoutePlan v3/);
});

test("Router fails mixed avatar prose closed to one Human clarification", async () => {
  const value = interaction("去沙发坐下，然后讲个故事");
  const routed = await routeInteraction({
    interaction: value,
    route_plan_id: "route:human-avatar-mixed",
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return {
          model: "fake",
          message: {
            role: "assistant",
            content: JSON.stringify({ assignments: [
              { role: "avatar", text: "去沙发坐下，" },
              { role: "human", text: "然后讲个故事" },
            ] }),
          },
        };
      },
    },
    human_only: true,
  });
  assert.equal(routed.model_output_accepted, false);
  assert.equal(routed.fallback_error_code, "INVALID_ROUTE_PLAN");
  assert.equal(routed.plan.assignments[0]?.mode, "clarify");
});

test("Human avatar runner fixes actor ownership and executes go_to then sit serially", async () => {
  const device = new FakeHumanAvatarDevice();
  const requests: OllamaChatRequest[] = [];
  const result = await runHumanAvatarAction({
    run_id: "run:human-avatar",
    assignment_id: "assignment:human-avatar",
    text: "去客厅沙发坐下",
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        requests.push(request);
        return response([
          { name: "character.go_to", arguments: { target_id: "living_room.sofa" } },
          { name: "character.sit", arguments: { target_id: "living_room.sofa" } },
        ]);
      },
    },
    device,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.final_text, "好的，Human 已在客厅沙发坐下。");
  assert.equal(result.tool_results.length, 2);
  assert.equal(result.tool_results.every((item) => item.schema_version === 3), true);
  assert.deepEqual(device.calls.map((call) => ({
    actor_id: call.actor_id,
    tool: call.tool,
    origin: call.origin,
  })), [
    { actor_id: "human_avatar", tool: "character.go_to", origin: "user" },
    { actor_id: "human_avatar", tool: "character.sit", origin: "user" },
  ]);
  assert.equal(requests[0]?.tools?.some((tool) =>
    JSON.stringify(tool).includes("actor_id")
  ), false);
  assert.equal(device.calls.some((call) => "actor_id" in call.arguments), false);
});

test("long run and assignment ids keep distinct hash-bound action identities", async () => {
  const prefix = "x".repeat(99);
  const ids: { action: string; tool: string }[] = [];
  for (const tail of ["a", "b"]) {
    const device = new FakeHumanAvatarDevice();
    const result = await runHumanAvatarAction({
      run_id: `${prefix}${tail}`,
      assignment_id: `${prefix}${tail}`,
      text: "去客厅",
      provider: {
        async chat(): Promise<OllamaChatResult> {
          return response([{
            name: "character.go_to_room",
            arguments: { room_id: "living_room" },
          }]);
        },
      },
      device,
    });
    assert.equal(result.status, "completed");
    ids.push({
      action: device.calls[0]!.action_id,
      tool: result.tool_results[0]!.tool_call_id,
    });
  }
  assert.notEqual(ids[0]?.action, ids[1]?.action);
  assert.notEqual(ids[0]?.tool, ids[1]?.tool);
  assert.equal(ids.every((item) => item.action.length <= 100 && item.tool.length <= 100), true);
});

test("go_to can replace a different current target before continuing on the new target", async () => {
  const base = new FakeHumanAvatarDevice();
  const device = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "last_snapshot") {
        return {
          ...target.last_snapshot,
          character: {
            ...target.last_snapshot.character,
            target_object_id: "study.desk",
          },
        } as HumanAvatarDeviceRuntime["last_snapshot"];
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const result = await runHumanAvatarAction({
    run_id: "run:human-avatar-change-target",
    assignment_id: "assignment:human-avatar-change-target",
    text: "改去客厅沙发坐下",
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return response([
          { name: "character.go_to", arguments: { target_id: "living_room.sofa" } },
          { name: "character.sit", arguments: { target_id: "living_room.sofa" } },
        ]);
      },
    },
    device,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(base.calls.map((call) => call.tool), ["character.go_to", "character.sit"]);
});

test("Human avatar runner clarifies model actor injection and does not dispatch", async () => {
  const device = new FakeHumanAvatarDevice();
  const result = await runHumanAvatarAction({
    run_id: "run:human-avatar-injection",
    assignment_id: "assignment:human-avatar-injection",
    text: "让 Cat 去沙发",
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return response([{
          name: "character.go_to",
          arguments: { target_id: "living_room.sofa", actor_id: "cat" },
        }]);
      },
    },
    device,
  });
  assert.equal(result.status, "clarify");
  assert.equal(device.calls.length, 0);
  assert.doesNotMatch(result.final_text, /已移动|已坐下|已互动/);
});

test("Human avatar runner stops after the first non-completed lifecycle", async () => {
  const device = new FakeHumanAvatarDevice();
  device.failAt = 0;
  const result = await runHumanAvatarAction({
    run_id: "run:human-avatar-stop",
    assignment_id: "assignment:human-avatar-stop",
    text: "去客厅沙发坐下",
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return response([
          { name: "character.go_to", arguments: { target_id: "living_room.sofa" } },
          { name: "character.sit", arguments: { target_id: "living_room.sofa" } },
        ]);
      },
    },
    device,
  });
  assert.equal(result.status, "failed");
  assert.equal(device.calls.length, 1);
  assert.doesNotMatch(result.final_text, /已移动|已坐下|已互动/);
});

test("Human avatar runner uses current capabilities and rejects unavailable targets", async () => {
  const device = new FakeHumanAvatarDevice();
  const result = await runHumanAvatarAction({
    run_id: "run:human-avatar-unknown",
    assignment_id: "assignment:human-avatar-unknown",
    text: "去书房桌边互动",
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return response([{
          name: "character.interact",
          arguments: { target_id: "study.desk" },
        }]);
      },
    },
    device,
  });
  assert.equal(result.status, "clarify");
  assert.equal(device.calls.length, 0);
});

test("voice Human avatar path bypasses streaming chat and keeps Cat and Robot sessions empty", async () => {
  const value = interaction("cat-canary-9f2e：让屏幕上的 Human 去客厅");
  const device = new FakeHumanAvatarDevice();
  const sessions = new RoleSessionRegistry({
    human: "session:avatar:human",
    robot: "session:avatar:robot",
    cat: "session:avatar:cat",
  });
  let calls = 0;
  let streamed = 0;
  const provider = {
    async chat(): Promise<OllamaChatResult> {
      calls++;
      if (calls === 1) {
        return {
          model: "fake",
          message: {
            role: "assistant",
            content: JSON.stringify({ assignments: [{ role: "avatar", text: value.text }] }),
          },
        };
      }
      return response([{
        name: "character.go_to_room",
        arguments: { room_id: "living_room" },
      }]);
    },
    async *chatStream(): AsyncIterable<never> {
      throw new Error("avatar actions must not use streaming Human chat");
    },
  };
  const scheduler = new RoleScheduler();
  try {
    const result = await runRoleInteraction({
      interaction: value,
      route_plan_id: "route:avatar:canary",
      run_id: "run:avatar:canary",
      provider,
      sessions,
      scheduler,
      human_only: true,
      human_avatar: device,
      on_human_speech_segment: () => { streamed++; },
    });
    assert.equal(result.response.text, "好的，Human 已移动到客厅。");
    assert.equal(streamed, 0);
    assert.deepEqual(sessions.get("human").history(), []);
    assert.deepEqual(sessions.get("cat").history(), []);
    assert.deepEqual(sessions.get("robot").history(), []);
    assert.equal(device.calls[0]?.actor_id, "human_avatar");
  } finally {
    scheduler.close();
  }
});

test("Human avatar actions persist actor-scoped lifecycle audit without a Cat run", async () => {
  using store = new SqliteAuditStore(":memory:");
  const value = interaction("audit-cat-canary-72c1：让屏幕上的 Human 去客厅");
  const device = new FakeHumanAvatarDevice();
  const sessions = new RoleSessionRegistry({
    human: "session:audit-avatar:human",
    robot: "session:audit-avatar:robot",
    cat: "session:audit-avatar:cat",
  });
  let calls = 0;
  const scheduler = new RoleScheduler();
  try {
    const result = await runRoleInteraction({
      interaction: value,
      route_plan_id: "route:avatar:audit",
      run_id: "run:avatar:audit",
      provider: {
        async chat(): Promise<OllamaChatResult> {
          calls++;
          return calls === 1
            ? {
                model: "fake",
                message: {
                  role: "assistant",
                  content: JSON.stringify({ assignments: [{ role: "avatar", text: value.text }] }),
                },
              }
            : response([{
                name: "character.go_to_room",
                arguments: { room_id: "living_room" },
              }]);
        },
      },
      sessions,
      scheduler,
      human_only: true,
      human_avatar: device,
      audit: { store, clock: () => 2_000 },
    });
    const trace = await store.getRunTrace("run:avatar:audit");
    assert.equal(result.response.status, "completed");
    assert.equal(trace?.run.status, "completed");
    assert.deepEqual(trace?.actions.map((action) => action.status), ["completed"]);
    const lifecycle = trace?.events.filter((event) =>
      event.type.startsWith("role.avatar.action.")
    ) ?? [];
    assert.deepEqual(lifecycle.map((event) => event.type), [
      "role.avatar.action.requested",
      "role.avatar.action.completed",
    ]);
    assert.equal(lifecycle.every((event) => event.payload.actor_id === HUMAN_AVATAR_ID), true);
    assert.equal(lifecycle.every((event) => event.payload.role_id === "human"), true);
    assert.equal(sessions.get("cat").history().length, 0);
    assert.equal(trace?.messages.some((message) => message.metadata.role_id === "cat"), false);
    assert.equal(trace?.events[0]?.payload.role_profile_revision,
      getHumanAvatarExecutorProfile().revision);
  } finally {
    scheduler.close();
  }
});

test("synthetic early-failure audit retains the isolated avatar executor profile", async () => {
  using store = new SqliteAuditStore(":memory:");
  let failFirstBatch = true;
  const flakyStore = new Proxy(store as AuditStore, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "writeBatch" && typeof value === "function") {
        return async (...args: readonly unknown[]) => {
          if (failFirstBatch) {
            failFirstBatch = false;
            throw new Error("synthetic first audit batch failure");
          }
          return await Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AuditStore;
  const value = interaction("让屏幕上的 Human 去客厅");
  const scheduler = new RoleScheduler();
  try {
    const result = await runRoleInteraction({
      interaction: value,
      route_plan_id: "route:avatar:synthetic-profile",
      run_id: "run:avatar:synthetic-profile",
      provider: avatarProvider(value, [{
        name: "character.go_to_room", arguments: { room_id: "living_room" },
      }]),
      sessions: new RoleSessionRegistry({
        human: "session:synthetic:human", robot: "session:synthetic:robot", cat: "session:synthetic:cat",
      }),
      scheduler,
      human_only: true,
      human_avatar: new FakeHumanAvatarDevice(),
      audit: { store: flakyStore },
    });
    assert.equal(result.run.status, "failed");
    assert.equal(result.composition_audit_status, "persisted");
    const trace = await store.getRunTrace("run:avatar:synthetic-profile");
    assert.equal(trace?.events[0]?.payload.assignment_capability, "avatar");
    const profile = trace === null
      ? null
      : await store.getSessionAgentProfile(trace.run.session_id);
    assert.equal(profile?.agent_profile_id,
      `${getHumanAvatarExecutorProfile().revision.replace("/", "-")}:human`);
  } finally {
    scheduler.close();
  }
});

test("first dispatched avatar failure remains failed through voice result, composer and audit", async () => {
  using store = new SqliteAuditStore(":memory:");
  const value = interaction("让屏幕上的 Human 去沙发坐下");
  const device = new FakeHumanAvatarDevice();
  device.failAt = 0;
  const scheduler = new RoleScheduler();
  let observed: { run: string; response: string } | null = null;
  try {
    const dispatcher = new UnifiedVoiceRoleDispatcher({
      provider: avatarProvider(value, [
        { name: "character.go_to", arguments: { target_id: "living_room.sofa" } },
        { name: "character.sit", arguments: { target_id: "living_room.sofa" } },
      ]),
      sessions: new RoleSessionRegistry({
        human: "session:first-failure:human",
        robot: "session:first-failure:robot",
        cat: "session:first-failure:cat",
      }),
      scheduler,
      human_only: true,
      human_avatar: device,
      audit: { store },
      on_result: (result) => {
        observed = { run: result.run.status, response: result.response.status };
      },
    });
    const result = await dispatcher.dispatch(value, new AbortController().signal);
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.source, "tool");
    assert.equal(result.run.error?.code, "DEVICE_BUSY");
    assert.equal(result.response.status, "failed");
    assert.deepEqual(observed, { run: "failed", response: "failed" });
    const trace = await store.getRunTrace("run:interaction:human-avatar");
    assert.equal(trace?.run.status, "failed");
    assert.deepEqual(trace?.actions.map((action) => action.status), ["failed"]);
    assert.deepEqual(trace?.tool_calls.map((call) => call.status), ["error", "error"]);
  } finally {
    scheduler.close();
  }
});

test("second avatar failure preserves the completed first action and failed Role terminal", async () => {
  using store = new SqliteAuditStore(":memory:");
  const value = interaction("让屏幕上的 Human 去沙发坐下");
  const device = new FakeHumanAvatarDevice();
  device.failAt = 1;
  const scheduler = new RoleScheduler();
  try {
    const result = await runRoleInteraction({
      interaction: value,
      route_plan_id: "route:avatar:second-failure",
      run_id: "run:avatar:second-failure",
      provider: avatarProvider(value, [
        { name: "character.go_to", arguments: { target_id: "living_room.sofa" } },
        { name: "character.sit", arguments: { target_id: "living_room.sofa" } },
      ]),
      sessions: new RoleSessionRegistry({
        human: "session:second-failure:human",
        robot: "session:second-failure:robot",
        cat: "session:second-failure:cat",
      }),
      scheduler,
      human_only: true,
      human_avatar: device,
      audit: { store },
    });
    assert.equal(result.run.status, "failed");
    assert.equal(result.response.status, "failed");
    const trace = await store.getRunTrace("run:avatar:second-failure");
    assert.equal(trace?.run.status, "failed");
    assert.deepEqual(trace?.actions.map((action) => action.status), ["completed", "failed"]);
    assert.deepEqual(trace?.tool_calls.map((call) => call.status), ["success", "error"]);
  } finally {
    scheduler.close();
  }
});

test("unavailable avatar is a deterministic completed capability-unavailable product response", async () => {
  using store = new SqliteAuditStore(":memory:");
  const value = interaction("让屏幕上的 Human 去客厅");
  const base = new FakeHumanAvatarDevice();
  const device = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "is_ready") return false;
      return Reflect.get(target, property, receiver);
    },
  });
  const scheduler = new RoleScheduler();
  try {
    const result = await runRoleInteraction({
      interaction: value,
      route_plan_id: "route:avatar:unavailable",
      run_id: "run:avatar:unavailable",
      provider: avatarProvider(value, []),
      sessions: new RoleSessionRegistry({
        human: "session:unavailable:human",
        robot: "session:unavailable:robot",
        cat: "session:unavailable:cat",
      }),
      scheduler,
      human_only: true,
      human_avatar: device,
      audit: { store },
    });
    assert.equal(result.run.status, "completed");
    assert.equal(result.run.outcome, "capability_unavailable");
    assert.equal(result.run.capability_available, false);
    assert.equal(result.run.error, null);
    assert.equal(result.response.status, "completed");
    const trace = await store.getRunTrace("run:avatar:unavailable");
    assert.equal(trace?.run.status, "completed");
    assert.equal(trace?.actions.length, 0);
  } finally {
    scheduler.close();
  }
});

test("barge-in after dispatch persists cancelled action and ToolResult before the cancelled Run", async () => {
  using store = new SqliteAuditStore(":memory:");
  const value = interaction("让屏幕上的 Human 去客厅");
  const device = new FakeHumanAvatarDevice();
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => { dispatched = resolve; });
  device.executeAction = async (spec: DeviceActionSpec): Promise<DeviceActionOutcome> => {
    spec.on_dispatched?.();
    device.calls.push(spec);
    dispatched();
    await new Promise<void>((resolve) => {
      if (spec.signal?.aborted === true) return resolve();
      spec.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("transport closed during barge-in");
  };
  const controller = new AbortController();
  const scheduler = new RoleScheduler();
  try {
    const pending = runRoleInteraction({
      interaction: value,
      route_plan_id: "route:avatar:audit-cancel",
      run_id: "run:avatar:audit-cancel",
      provider: avatarProvider(value, [{
        name: "character.go_to_room", arguments: { room_id: "living_room" },
      }]),
      sessions: new RoleSessionRegistry({
        human: "session:audit-cancel:human",
        robot: "session:audit-cancel:robot",
        cat: "session:audit-cancel:cat",
      }),
      scheduler,
      signal: controller.signal,
      human_only: true,
      human_avatar: device,
      audit: { store },
    });
    await started;
    controller.abort(new DOMException("barge_in", "AbortError"));
    const result = await pending;
    assert.equal(result.run.status, "cancelled");
    assert.equal(result.response.status, "failed");
    assert.equal(result.composition_audit_status, "persisted");
    const trace = await store.getRunTrace("run:avatar:audit-cancel");
    assert.equal(trace?.run.status, "cancelled");
    assert.deepEqual(trace?.actions.map((action) => action.status), ["cancelled"]);
    assert.equal(trace?.tool_calls[0]?.status, "error");
    assert.equal(trace?.tool_calls[0]?.error?.code, "CANCELLED");
    assert.deepEqual(trace?.events.filter((event) =>
      event.type.startsWith("role.avatar.action.")
    ).map((event) => event.type), [
      "role.avatar.action.requested",
      "role.avatar.action.cancelled",
    ]);
    assert.equal(trace?.events.some((event) => event.payload.recovered_terminal === true), false);
  } finally {
    scheduler.close();
  }
});

test("two-step avatar abort after step one terminalizes every audited ToolCall", async () => {
  using store = new SqliteAuditStore(":memory:");
  const value = interaction("让屏幕上的 Human 去沙发坐下");
  const device = new FakeHumanAvatarDevice();
  const controller = new AbortController();
  device.executeAction = async (spec: DeviceActionSpec): Promise<DeviceActionOutcome> => {
    spec.on_dispatched?.();
    device.calls.push(spec);
    controller.abort(new DOMException("barge_in", "AbortError"));
    return {
      status: "completed",
      action_id: spec.action_id,
      tool: spec.tool,
      state_version: 2,
      result: { object_id: spec.arguments.target_id, action: "go_to", pose: "standing" },
      source: "lifecycle",
    };
  };
  const scheduler = new RoleScheduler();
  try {
    const result = await runRoleInteraction({
      interaction: value,
      route_plan_id: "route:avatar:between-steps-cancel",
      run_id: "run:avatar:between-steps-cancel",
      provider: avatarProvider(value, [
        { name: "character.go_to", arguments: { target_id: "living_room.sofa" } },
        { name: "character.sit", arguments: { target_id: "living_room.sofa" } },
      ]),
      sessions: new RoleSessionRegistry({
        human: "session:between-steps:human",
        robot: "session:between-steps:robot",
        cat: "session:between-steps:cat",
      }),
      scheduler,
      signal: controller.signal,
      human_only: true,
      human_avatar: device,
      audit: { store },
    });
    assert.equal(result.run.status, "cancelled");
    const trace = await store.getRunTrace("run:avatar:between-steps-cancel");
    assert.equal(trace?.run.status, "cancelled");
    assert.deepEqual(trace?.tool_calls.map((call) => call.status), ["success", "error"]);
    assert.equal(trace?.tool_calls[1]?.error?.code, "CANCELLED");
    assert.deepEqual(trace?.actions.map((action) => action.status), ["completed"]);
    assert.equal(trace?.tool_calls.some((call) => call.status === "pending"), false);
  } finally {
    scheduler.close();
  }
});

test("unknown avatar outcome remains unknown with reconciliation evidence in SQLite", async () => {
  using store = new SqliteAuditStore(":memory:");
  const value = interaction("让屏幕上的 Human 去客厅");
  const device = new FakeHumanAvatarDevice();
  device.executeAction = async (spec: DeviceActionSpec): Promise<DeviceActionOutcome> => {
    spec.on_dispatched?.();
    device.calls.push(spec);
    return {
      status: "unknown",
      action_id: spec.action_id,
      reason: "disconnected",
      replay_allowed: false,
      reconciliation: {
        snapshot_id: "snapshot:after-disconnect",
        status: "state_not_satisfied",
        state_version: 2,
        observed_at_ms: 2_000,
      },
    };
  };
  const scheduler = new RoleScheduler();
  try {
    const result = await runRoleInteraction({
      interaction: value,
      route_plan_id: "route:avatar:unknown",
      run_id: "run:avatar:unknown",
      provider: avatarProvider(value, [{
        name: "character.go_to_room", arguments: { room_id: "living_room" },
      }]),
      sessions: new RoleSessionRegistry({
        human: "session:unknown:human", robot: "session:unknown:robot", cat: "session:unknown:cat",
      }),
      scheduler,
      human_only: true,
      human_avatar: device,
      audit: { store },
    });
    assert.equal(result.run.status, "failed");
    const trace = await store.getRunTrace("run:avatar:unknown");
    assert.deepEqual(trace?.actions.map((action) => action.status), ["unknown"]);
    const terminal = trace?.events.find((event) => event.type === "role.avatar.action.unknown");
    assert.equal(terminal?.payload.replay_allowed, false);
    assert.equal((terminal?.payload.reconciliation as { status?: unknown })?.status,
      "state_not_satisfied");
  } finally {
    scheduler.close();
  }
});

test("post-dispatch adapter throw audits unknown while Role and Tool remain failed", async () => {
  using store = new SqliteAuditStore(":memory:");
  const value = interaction("让屏幕上的 Human 去客厅");
  const device = new FakeHumanAvatarDevice();
  device.executeAction = async (spec: DeviceActionSpec): Promise<DeviceActionOutcome> => {
    spec.on_dispatched?.();
    device.calls.push(spec);
    throw new Error("ambiguous transport failure");
  };
  const scheduler = new RoleScheduler();
  try {
    const result = await runRoleInteraction({
      interaction: value,
      route_plan_id: "route:avatar:adapter-throw",
      run_id: "run:avatar:adapter-throw",
      provider: avatarProvider(value, [{
        name: "character.go_to_room", arguments: { room_id: "living_room" },
      }]),
      sessions: new RoleSessionRegistry({
        human: "session:throw:human", robot: "session:throw:robot", cat: "session:throw:cat",
      }),
      scheduler,
      human_only: true,
      human_avatar: device,
      audit: { store },
    });
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.tool_results[0]?.status, "error");
    const trace = await store.getRunTrace("run:avatar:adapter-throw");
    assert.deepEqual(trace?.actions.map((action) => action.status), ["unknown"]);
    const terminal = trace?.events.find((event) => event.type === "role.avatar.action.unknown");
    assert.equal(terminal?.payload.replay_allowed, false);
    assert.equal(terminal?.payload.reconciliation, null);
  } finally {
    scheduler.close();
  }
});

test("pre-dispatch adapter rejection audits failed and does not latch a side effect", async () => {
  using store = new SqliteAuditStore(":memory:");
  const value = interaction("让屏幕上的 Human 去客厅");
  const { connection, adapter: device } = racingHumanAvatarAdapter();
  let sideEffects = 0;
  // runHumanAvatarAction reads is_ready once; executeAction then reads it once,
  // validates once, and the fourth read is #send's final connection check.
  connection.armCloseCheck(4);
  const direct = await runHumanAvatarAction({
    run_id: "run:avatar:predispatch-direct",
    assignment_id: "assignment:avatar:predispatch-direct",
    text: "去客厅",
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return response([{
          name: "character.go_to_room", arguments: { room_id: "living_room" },
        }]);
      },
    },
    device,
    on_side_effect_dispatched: () => { sideEffects++; },
  });
  assert.equal(direct.status, "failed");
  assert.equal(sideEffects, 0);
  assert.equal(connection.send_calls, 0);
  assert.equal(device.pending_waiters, 0);
  connection.armCloseCheck(4);
  const scheduler = new RoleScheduler();
  try {
    const result = await runRoleInteraction({
      interaction: value,
      route_plan_id: "route:avatar:predispatch-reject",
      run_id: "run:avatar:predispatch-reject",
      provider: avatarProvider(value, [{
        name: "character.go_to_room", arguments: { room_id: "living_room" },
      }]),
      sessions: new RoleSessionRegistry({
        human: "session:predispatch:human", robot: "session:predispatch:robot",
        cat: "session:predispatch:cat",
      }),
      scheduler,
      human_only: true,
      human_avatar: device,
      audit: { store },
    });
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.tool_results[0]?.schema_version, 3);
    assert.equal(connection.send_calls, 0);
    assert.equal(device.pending_waiters, 0);
    const trace = await store.getRunTrace("run:avatar:predispatch-reject");
    assert.deepEqual(trace?.actions.map((action) => action.status), ["failed"]);
    assert.equal(trace?.events.some((event) => event.type === "role.avatar.action.unknown"), false);
    assert.equal(trace?.events.some((event) => event.type === "role.avatar.action.failed"), true);
  } finally {
    scheduler.close();
  }
});

test("barge-in abort reaches the active Human avatar action and suppresses confirmation", async () => {
  const device = new FakeHumanAvatarDevice();
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => { dispatched = resolve; });
  device.executeAction = async (spec: DeviceActionSpec): Promise<DeviceActionOutcome> => {
    spec.on_dispatched?.();
    device.calls.push(spec);
    dispatched();
    await new Promise<void>((resolve) => {
      if (spec.signal?.aborted === true) return resolve();
      spec.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return {
      status: "failed",
      action_id: spec.action_id,
      error: { code: "CANCELLED", message: "barge-in", retryable: false },
    };
  };
  const controller = new AbortController();
  const pending = runHumanAvatarAction({
    run_id: "run:avatar:barge-in",
    assignment_id: "assignment:avatar:barge-in",
    text: "去客厅",
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return response([{
          name: "character.go_to_room",
          arguments: { room_id: "living_room" },
        }]);
      },
    },
    device,
    signal: controller.signal,
  });
  await started;
  controller.abort(new DOMException("barge_in", "AbortError"));
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.final_text, "");
  assert.equal(device.calls[0]?.signal, controller.signal);
});
