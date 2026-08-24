import type { OllamaChatMessage } from "@p4home/provider-ollama";

import { assertContractId, type RoleId } from "./role-contracts.ts";
import {
  buildRoleContextWithMemory,
  memoryContextTokenHeadroom,
} from "./role-context-builder.ts";
import type { MemoryContextResult } from "./role-memory.ts";
import {
  buildRoleContext,
  getRoleProfile,
  type RoleInput,
  type RoleProfile,
} from "./role-profiles.ts";

export interface RoleHistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export class RoleSession {
  public readonly session_id: string;
  public readonly role_id: RoleId;
  public readonly created_at_ms: number;
  readonly #profile: RoleProfile;
  readonly #history: RoleHistoryMessage[] = [];
  #exclusiveTail: Promise<void> = Promise.resolve();

  public constructor(roleId: RoleId, sessionId: string, createdAtMs = Date.now()) {
    assertContractId(sessionId, "session_id");
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
      throw new TypeError("created_at_ms must be a non-negative safe integer");
    }
    this.session_id = sessionId;
    this.role_id = roleId;
    this.created_at_ms = createdAtMs;
    this.#profile = getRoleProfile(roleId);
  }

  public get profile(): RoleProfile {
    return getRoleProfile(this.role_id);
  }

  public history(): readonly RoleHistoryMessage[] {
    return this.#history.map((message) => ({ ...message }));
  }

  public buildContext(
    input: RoleInput,
    memory?: MemoryContextResult,
  ): readonly OllamaChatMessage[] {
    const retained = this.#history.slice(-this.#profile.history_message_limit);
    return buildRoleContextWithMemory(this.#profile, input, retained, memory);
  }

  public memoryContextTokenHeadroom(input: RoleInput): number {
    const retained = this.#history.slice(-this.#profile.history_message_limit);
    return memoryContextTokenHeadroom(this.#profile, input, retained);
  }

  public commitExchange(input: RoleInput, assistantText: string): void {
    if (assistantText.trim().length === 0 || assistantText.length > 8_192) {
      throw new TypeError("assistant text must contain 1..8192 characters");
    }
    const context = buildRoleContext(this.#profile, input);
    const user = context[1];
    if (user === undefined) {
      throw new Error("role context builder returned no input message");
    }
    this.#history.push(
      { role: "user", content: user.content },
      { role: "assistant", content: assistantText },
    );
    const maximum = this.#profile.history_message_limit;
    if (this.#history.length > maximum) {
      this.#history.splice(0, this.#history.length - maximum);
    }
  }

  public async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#exclusiveTail;
    let release: (() => void) | undefined;
    this.#exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export interface RoleSessionIds {
  readonly robot: string;
  readonly human: string;
  readonly cat: string;
}

export class RoleSessionRegistry {
  readonly #sessions: Readonly<Record<RoleId, RoleSession>>;

  public constructor(ids: RoleSessionIds, clock: () => number = Date.now) {
    if (new Set(Object.values(ids)).size !== 3) {
      throw new TypeError("Robot, Human and Cat must use distinct session_id values");
    }
    const createdAtMs = clock();
    this.#sessions = {
      robot: new RoleSession("robot", ids.robot, createdAtMs),
      human: new RoleSession("human", ids.human, createdAtMs),
      cat: new RoleSession("cat", ids.cat, createdAtMs),
    };
  }

  public get(roleId: RoleId): RoleSession {
    return this.#sessions[roleId];
  }
}
