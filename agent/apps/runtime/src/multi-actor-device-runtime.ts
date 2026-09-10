import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  MULTI_ACTOR_IDS, validateMultiActorDeviceMessage,
  type MultiActorDeviceMessage, type MultiActorId,
  type MultiActorState, type MultiActorObjectState,
} from "@p4home/contracts";
import { DeviceWebSocketActionAdapter, type DeviceWebSocketConnection } from "./device-action-adapter.ts";
import { decodeDeviceMessage, DEVICE_MAX_JSON_FRAME_BYTES,
  type DeviceMessage, type DeviceToolName } from "./device-protocol.ts";
import { DeviceWebSocketServer, type DeviceWebSocketServerOptions } from "./device-websocket-server.ts";

export const CAT_DEVICE_TOOLS: readonly DeviceToolName[] = [
  "character.get_state", "character.go_to_room", "character.set_activity", "character.say",
  "world.get_snapshot", "character.go_to", "character.sit", "character.look_at", "character.interact",
];
export const HUMAN_DEVICE_TOOLS = CAT_DEVICE_TOOLS.filter((tool) =>
  !["character.get_state", "character.set_activity", "character.say", "world.get_snapshot"].includes(tool));

/** An in-process projection, never a second network connection or wire protocol. */
class ActorProjection implements DeviceWebSocketConnection {
  readonly frames = new Set<(frame: string) => void>();
  readonly closes = new Set<() => void>();
  seq = 0;
  resyncId: string | null = null;
  constructor(readonly owner: MultiActorDeviceConnection, readonly actor: MultiActorId) {}
  get is_open(): boolean { return this.owner.is_open; }
  async send(frame: string): Promise<void> { await this.owner.send(this.actor, decodeDeviceMessage(frame)); }
  close(code: number, reason: string): void { this.owner.close(code, reason); }
  onFrame(listener: (frame: string) => void): () => void { this.frames.add(listener); return () => this.frames.delete(listener); }
  onClose(listener: () => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
  emit(message: MultiActorDeviceMessage, payload: Record<string, unknown>, type = message.type,
    correlationId = message.correlation_id): void {
    const projected = { ...message, protocol_version: this.actor === "cat" ? 2 : 3,
      seq: this.seq++, type, payload, correlation_id: correlationId } as DeviceMessage;
    const frame = JSON.stringify(projected);
    for (const listener of this.frames) listener(frame);
  }
  reset(): void { this.seq = 0; this.resyncId = null; for (const listener of this.closes) listener(); }
}

interface RetainedAction { actor: MultiActorId; tool: unknown; fingerprint: string; terminalAt: number | null }

/** Owns authentication-bound identity, sequence, full-world validation and global action IDs. */
export class MultiActorDeviceConnection {
  readonly #channels: Record<MultiActorId, ActorProjection>;
  readonly #adapters: Record<MultiActorId, DeviceWebSocketActionAdapter>;
  readonly #actions = new Map<string, RetainedAction>();
  #session: string | null = null;
  #nextIncoming = 0;
  #nextOutgoing = 0;
  #capabilities = false;
  #world: MultiActorDeviceMessage | null = null;
  #resyncId: string | null = null;
  #failed = false;
  last_error: Error | null = null;
  constructor(readonly deviceId: string, readonly connection: DeviceWebSocketConnection) {
    this.#channels = { human_avatar: new ActorProjection(this, "human_avatar"), cat: new ActorProjection(this, "cat") };
    this.#adapters = {
      human_avatar: new DeviceWebSocketActionAdapter(this.#channels.human_avatar,
        { device_id: deviceId, protocol_version: 3, actor_id: "human_avatar", allowed_tools: HUMAN_DEVICE_TOOLS, decode_projection: (frame) => JSON.parse(frame) as DeviceMessage }),
      cat: new DeviceWebSocketActionAdapter(this.#channels.cat,
        { device_id: deviceId, protocol_version: 2, allowed_tools: CAT_DEVICE_TOOLS, decode_projection: (frame) => JSON.parse(frame) as DeviceMessage }),
    };
    connection.onFrame((frame) => {
      try { this.#receive(frame); }
      catch (error) { this.last_error = error instanceof Error ? error : new Error(String(error)); this.close(1002, "invalid multi actor protocol"); }
    });
    connection.onClose(() => this.#reset());
  }
  get is_open(): boolean { return this.connection.is_open && !this.#failed; }
  get is_ready(): boolean { return MULTI_ACTOR_IDS.every((actor) => this.#adapters[actor].is_ready); }
  getAdapter(actor: MultiActorId): DeviceWebSocketActionAdapter { return this.#adapters[actor]; }
  close(code: number, reason: string): void {
    this.#reset(); this.#failed = true; this.connection.close(code, reason);
  }
  #reset(): void {
    this.#session = null; this.#nextIncoming = 0; this.#nextOutgoing = 0;
    this.#capabilities = false; this.#world = null; this.#resyncId = null; this.#failed = false;
    for (const action of this.#actions.values()) if (action.terminalAt === null) action.terminalAt = Date.now();
    for (const actor of MULTI_ACTOR_IDS) this.#channels[actor].reset();
  }
  async send(actor: MultiActorId, projected: DeviceMessage): Promise<void> {
    if (!this.is_open || this.#session === null) throw new Error("multi actor connection is closed");
    const p = structuredClone(projected.payload);
    if (projected.type === "world.resync.request") {
      this.#channels[actor].resyncId = projected.message_id;
      if (this.#resyncId !== null) return;
      this.#resyncId = `resync-${randomUUID()}`;
      await this.#sendWire(projected.type, { ...p, last_applied_state_version: this.#world?.payload.world_version ?? 0 }, this.#resyncId);
      return;
    }
    if (projected.type !== "action.request" && projected.type !== "action.cancel") {
      throw new TypeError("actor projection cannot send connection level messages");
    }
    p.actor_id = actor;
    const actionId = String(p.action_id);
    const existing = this.#actions.get(actionId);
    if (projected.type === "action.request") {
      const fingerprint = JSON.stringify([actor, p.tool, p.arguments, p.timeout_ms, p.origin]);
      if (existing && (existing.actor !== actor || existing.fingerprint !== fingerprint)) {
        throw new TypeError("global action_id conflict");
      }
      if (!this.is_ready) throw new Error("multi actor world is not ready");
      for (const [id, action] of this.#actions) {
        if (action.terminalAt !== null && Date.now() - action.terminalAt >= 600_000) this.#actions.delete(id);
      }
      if (!existing && this.#actions.size >= 4096) throw new Error("global action record capacity exceeded");
      // Validate before retaining or sending any action.
      this.#wire(projected.type, p, projected.correlation_id);
      this.#actions.set(actionId, existing ?? { actor, tool: p.tool, fingerprint, terminalAt: null });
    } else if (!existing || existing.actor !== actor) {
      throw new TypeError("cancel actor does not own action_id");
    }
    await this.#sendWire(projected.type, p, projected.correlation_id);
  }
  #wire(type: string, payload: Record<string, unknown>, correlation_id: string | null): MultiActorDeviceMessage {
    return validateMultiActorDeviceMessage({ protocol_version: 4, message_id: `multi-${randomUUID()}`,
      correlation_id, device_id: this.deviceId, session_id: this.#session,
      seq: this.#nextOutgoing, sent_at_ms: Date.now(), type, payload });
  }
  async #sendWire(type: string, payload: Record<string, unknown>, correlation: string | null): Promise<void> {
    const message = this.#wire(type, payload, correlation);
    // Resync responses correlate to the envelope message_id, not correlation_id.
    if (type === "world.resync.request") Object.assign(message, { message_id: this.#resyncId });
    const frame = JSON.stringify(message);
    if (Buffer.byteLength(frame) > DEVICE_MAX_JSON_FRAME_BYTES) throw new RangeError("v4 frame exceeds 16 KiB");
    this.#nextOutgoing++;
    await this.connection.send(frame);
  }
  #resync(message: MultiActorDeviceMessage): void {
    if (this.#resyncId !== null) return;
    for (const actor of MULTI_ACTOR_IDS) {
      const channel = this.#channels[actor];
      channel.seq++;
      channel.emit(message, { uptime_ms: 0, last_rx_seq: 0, state_version: 0 }, "heartbeat", null);
    }
  }
  #receive(frame: string): void {
    if (Buffer.byteLength(frame) > DEVICE_MAX_JSON_FRAME_BYTES) throw new RangeError("v4 frame exceeds 16 KiB");
    const message = validateMultiActorDeviceMessage(JSON.parse(frame));
    const p = message.payload;
    if (message.device_id !== this.deviceId) throw new TypeError("v4 authenticated device mismatch");
    if (message.type === "device.hello") {
      if (this.#session !== null || message.seq !== 0) throw new TypeError("v4 in-band session reset");
      this.#failed = false; this.#session = message.session_id; this.#nextIncoming = 1;
      for (const actor of MULTI_ACTOR_IDS) this.#channels[actor].emit(message,
        { ...p, protocol_versions: actor === "cat" ? [1, 2] : [1, 2, 3] });
      return;
    }
    if (this.#session === null || message.session_id !== this.#session) throw new TypeError("v4 session mismatch");
    if (message.seq < this.#nextIncoming) throw new TypeError("v4 sequence regressed");
    const gap = message.seq !== this.#nextIncoming;
    this.#nextIncoming = message.seq + 1;
    if (gap) { this.#resync(message); return; }
    if (message.type === "device.capabilities") {
      if (this.#capabilities || this.#world !== null) throw new TypeError("v4 duplicate capabilities");
      this.#capabilities = true;
      const limits = { ...(p.limits as Record<string, unknown>) };
      delete limits.actor_capacity; delete limits.cat_queue_capacity;
      for (const actor of MULTI_ACTOR_IDS) this.#channels[actor].emit(message,
        { selected_protocol_version: actor === "cat" ? 2 : 3,
          ...(actor === "human_avatar" ? { actor_id: actor } : {}), rooms: p.rooms,
          actions: actor === "cat" ? CAT_DEVICE_TOOLS : HUMAN_DEVICE_TOOLS, objects: p.objects, limits });
      return;
    }
    if (message.type === "world.snapshot" || message.type === "world.changed") {
      if (!this.#capabilities) throw new TypeError("v4 world before capabilities");
      if (this.#resyncId !== null && (message.type !== "world.snapshot" || p.reason !== "resync"
        || message.correlation_id !== this.#resyncId)) return;
      const actors = p.actors as readonly MultiActorState[];
      const previous = this.#world;
      if (message.type === "world.changed" && previous === null) throw new TypeError("v4 changed before initial snapshot");
      if (previous !== null) {
        const oldActors = previous.payload.actors as readonly MultiActorState[];
        if (Number(p.world_version) < Number(previous.payload.world_version)
          || (message.type === "world.changed" && Number(p.world_version) > Number(previous.payload.world_version) + 1)
          || actors.some((a, i) => a.state_version < oldActors[i]!.state_version)) {
          if (this.#resyncId !== null) throw new TypeError("v4 resync cannot regress world or actor versions");
          this.#resync(message); return;
        }
        if (p.world_version === previous.payload.world_version
          && !isDeepStrictEqual([p.actors, p.objects], [previous.payload.actors, previous.payload.objects])) throw new TypeError("v4 changed state without world version");
        for (let i = 0; i < actors.length; i++) {
          if (actors[i]!.state_version === oldActors[i]!.state_version
            && !isDeepStrictEqual(actors[i], oldActors[i])) throw new TypeError("v4 changed actor without state version");
        }
      }
      this.#world = message;
      for (const actor of MULTI_ACTOR_IDS) {
        const state = actors.find((a) => a.actor_id === actor)!;
        const { actor_id: ignoredActor, state_version, ...character } = state;
        const channel = this.#channels[actor];
        const oldVersion = this.#adapters[actor].last_snapshot?.state_version;
        const changed = message.type === "world.changed" && state_version === (oldVersion ?? -1) + 1;
        const payload = { ...(actor === "human_avatar" ? { actor_id: actor } : {}),
          state_version, observed_at_ms: p.observed_at_ms, character,
          objects: (p.objects as readonly MultiActorObjectState[]).map(({ occupied_by_actor_id, ...object }) =>
            ({ ...object, occupied: occupied_by_actor_id !== null })),
          ...(changed ? {} : { snapshot_id: p.snapshot_id ?? `world-${p.world_version}`, reason: p.reason ?? "requested" }),
        };
        channel.emit(message, payload, changed ? "world.changed" : "world.snapshot", channel.resyncId ?? message.correlation_id);
        channel.resyncId = null;
      }
      this.#resyncId = null;
      return;
    }
    if (message.type.startsWith("action.")) {
      const actor = p.actor_id as MultiActorId;
      const record = this.#actions.get(String(p.action_id));
      if (!record || record.actor !== actor) throw new TypeError("v4 lifecycle actor does not own action_id");
      if (!["action.accepted", "action.started", "action.completed", "action.failed"].includes(message.type)) throw new TypeError("v4 unexpected device action message");
      if (message.type === "action.completed" && p.tool !== record.tool) throw new TypeError("v4 terminal tool mismatch");
      const payload = structuredClone(p);
      if (actor === "cat") delete payload.actor_id;
      if (message.type === "action.completed") {
        payload.state_version = payload.actor_state_version;
        delete payload.actor_state_version; delete payload.world_version;
        if (p.tool === "character.get_state" || p.tool === "world.get_snapshot") {
          const result = payload.result as Record<string, unknown>;
          if (actor === "cat" || p.tool === "character.get_state") delete result.actor_id;
          if (Array.isArray(result.objects)) result.objects = (result.objects as MultiActorObjectState[])
            .map(({ occupied_by_actor_id, ...object }) => ({ ...object, occupied: occupied_by_actor_id !== null }));
        }
      }
      if (message.type === "action.completed" || message.type === "action.failed") record.terminalAt = Date.now();
      this.#channels[actor].emit(message, payload);
      return;
    }
    if (message.type !== "heartbeat" && message.type !== "error" && message.type !== "user.text") throw new TypeError("unexpected v4 device message");
  }
}

export class MultiActorDeviceRuntimeHub {
  readonly server: DeviceWebSocketServer;
  readonly #devices = new Map<string, MultiActorDeviceConnection>();
  readonly #listeners = new Set<(deviceId: string) => void>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(options: DeviceWebSocketServerOptions) {
    this.server = new DeviceWebSocketServer(options);
    this.server.onDeviceConnection((deviceId, connection) => {
      let device = this.#devices.get(deviceId);
      if (!device) { device = new MultiActorDeviceConnection(deviceId, connection); this.#devices.set(deviceId, device); }
      const timer = setTimeout(() => { this.#timers.delete(timer); if (!device!.is_ready) device!.close(1008, "v4 handshake timeout"); }, 5000);
      this.#timers.add(timer); timer.unref();
      let removeFrame = (): void => {};
      let removeClose = (): void => {};
      const cleanup = (): void => { clearTimeout(timer); this.#timers.delete(timer); removeFrame(); removeClose(); };
      removeFrame = connection.onFrame(() => {
        if (!device!.is_ready) return;
        cleanup();
        for (const listener of this.#listeners) { try { listener(deviceId); } catch { /* observers do not own transport */ } }
      });
      removeClose = connection.onClose(cleanup);
    });
  }
  getActorAdapter(deviceId: string, actor: MultiActorId): DeviceWebSocketActionAdapter | undefined { return this.#devices.get(deviceId)?.getAdapter(actor); }
  forActor(actor: MultiActorId): {
    getAdapter: (deviceId: string) => DeviceWebSocketActionAdapter | undefined;
    onAdapterReady: (listener: (deviceId: string, adapter: DeviceWebSocketActionAdapter) => void) => () => void;
  } {
    return {
      getAdapter: (deviceId) => this.getActorAdapter(deviceId, actor),
      onAdapterReady: (listener) => {
        const handler = (id: string): void => listener(id, this.getActorAdapter(id, actor)!);
        this.#listeners.add(handler);
        for (const [id, device] of this.#devices) if (device.is_ready) handler(id);
        return () => this.#listeners.delete(handler);
      },
    };
  }
  async start() { return await this.server.start(); }
  async close(): Promise<void> { for (const timer of this.#timers) clearTimeout(timer); this.#timers.clear(); await this.server.close(); }
}
