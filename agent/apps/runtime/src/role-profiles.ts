import type { OllamaChatMessage } from "@p4home/provider-ollama";
import { ROOM_IDS, type RoomId } from "@p4home/domain-p4home";
import type { WorldObjectCapability } from "@p4home/contracts";

import type { RoleId, SourceSpan } from "./role-contracts.ts";

export const CAT_ROOM_TOOLS = [
  "character.get_state",
  "character.go_to_room",
  "character.set_activity",
  "character.say",
  "world.get_snapshot",
] as const;

export const CAT_OBJECT_TOOLS = [
  "character.go_to",
  "character.sit",
  "character.look_at",
  "character.interact",
] as const;

export const CAT_WORLD_TOOLS = [...CAT_ROOM_TOOLS, ...CAT_OBJECT_TOOLS] as const;

export interface RoleProfile {
  readonly revision: "role-profile/v1" | "role-profile/v2";
  readonly role_id: RoleId;
  readonly accepts_user_text: boolean;
  readonly allowed_tools: readonly string[];
  readonly temperature: number;
  readonly num_ctx: number;
  readonly num_predict: number;
  readonly max_model_turns: number;
  readonly history_message_limit: number;
  readonly queue_priority: "user" | "background";
  readonly system_prompt: string;
}

export type RoleInput =
  | {
      readonly kind: "user_text";
      readonly text: string;
      readonly source_span: SourceSpan;
      readonly mode: "respond" | "clarify";
    }
  | {
      readonly kind: "normalized_event";
      readonly event_type: "test.room_target";
      readonly payload: Readonly<{ readonly room_target: RoomId }>;
    }
  | {
      readonly kind: "normalized_event";
      readonly event_type: "test.object_sit_target";
      readonly payload: Readonly<{
        readonly target_id: string;
        readonly objects: readonly WorldObjectCapability[];
      }>;
    };

const PROFILES: Readonly<Record<RoleId, RoleProfile>> = {
  robot: {
    revision: "role-profile/v1",
    role_id: "robot",
    accepts_user_text: true,
    // Real HA tools are intentionally absent until Phase 4.
    allowed_tools: [],
    temperature: 0,
    num_ctx: 8_192,
    num_predict: 128,
    max_model_turns: 1,
    history_message_limit: 12,
    queue_priority: "user",
    system_prompt: "你是 P4 Home 的 Robot。Phase 4 前没有 Home Assistant 执行能力；不得声称已执行设备动作。",
  },
  human: {
    revision: "role-profile/v1",
    role_id: "human",
    accepts_user_text: true,
    allowed_tools: [],
    temperature: 0.4,
    num_ctx: 8_192,
    num_predict: 256,
    max_model_turns: 1,
    history_message_limit: 12,
    queue_priority: "user",
    system_prompt: "你是 P4 Home 的 Human，只负责自然、简洁的中文对话。你没有任何执行工具，不得声称已控制设备。",
  },
  cat: {
    revision: "role-profile/v2",
    role_id: "cat",
    accepts_user_text: false,
    allowed_tools: CAT_WORLD_TOOLS,
    temperature: 0.2,
    num_ctx: 4_096,
    num_predict: 128,
    max_model_turns: 2,
    history_message_limit: 6,
    queue_priority: "background",
    system_prompt: "你是 P4 Home 的 Cat，只处理经过策略层归一化的世界事件，只能从给定的无坐标对象能力中选择最小 P4 World 工具，不得改写目标。",
  },
};

export function getRoleProfile(roleId: RoleId): RoleProfile {
  const profile = PROFILES[roleId];
  return { ...profile, allowed_tools: [...profile.allowed_tools] };
}

function assertCanonicalRoleProfile(profile: RoleProfile): RoleProfile {
  const canonical = PROFILES[profile.role_id];
  const fieldsMatch = canonical !== undefined
    && profile.revision === canonical.revision
    && profile.accepts_user_text === canonical.accepts_user_text
    && profile.temperature === canonical.temperature
    && profile.num_ctx === canonical.num_ctx
    && profile.num_predict === canonical.num_predict
    && profile.max_model_turns === canonical.max_model_turns
    && profile.history_message_limit === canonical.history_message_limit
    && profile.queue_priority === canonical.queue_priority
    && profile.system_prompt === canonical.system_prompt
    && profile.allowed_tools.length === canonical.allowed_tools.length
    && profile.allowed_tools.every((name, index) => name === canonical.allowed_tools[index]);
  if (!fieldsMatch) {
    throw new TypeError(`role profile ${profile.role_id} does not match its frozen revision`);
  }
  return canonical;
}

export function assertRoleToolAuthorization(
  profile: RoleProfile,
  toolNames: readonly string[],
): void {
  const allowed = new Set(assertCanonicalRoleProfile(profile).allowed_tools);
  for (const name of toolNames) {
    if (!allowed.has(name)) {
      throw new TypeError(`role ${profile.role_id} is not authorized for tool ${name}`);
    }
  }
}

export function buildRoleContext(
  profile: RoleProfile,
  input: RoleInput,
): readonly OllamaChatMessage[] {
  assertCanonicalRoleProfile(profile);
  if (input.kind === "user_text") {
    if (!profile.accepts_user_text || profile.role_id === "cat") {
      throw new TypeError(`role ${profile.role_id} cannot receive original user text`);
    }
    if (
      input.source_span.start !== 0
      || input.source_span.end !== input.text.length
      || input.text.trim().length === 0
    ) {
      throw new TypeError("role input span must cover non-empty user text exactly");
    }
    return [
      {
        role: "system",
        content: input.mode === "clarify"
          ? `${profile.system_prompt}当前输入只能请求用户澄清，不得推断目标或声称执行了动作。`
          : profile.system_prompt,
      },
      { role: "user", content: input.text },
    ];
  }

  if (profile.role_id !== "cat") {
    throw new TypeError("normalized Cat events cannot enter Human or Robot context");
  }
  const payloadKeys = Object.keys(input.payload).sort();
  if (input.event_type === "test.room_target") {
    if (
      payloadKeys.length !== 1
      || payloadKeys[0] !== "room_target"
      || !(ROOM_IDS as readonly string[]).includes(input.payload.room_target)
    ) {
      throw new TypeError("normalized Cat room event is not allowed by the contract");
    }
  } else {
    if (
      input.event_type !== "test.object_sit_target"
      || payloadKeys.length !== 2
      || payloadKeys[0] !== "objects"
      || payloadKeys[1] !== "target_id"
      || !Array.isArray(input.payload.objects)
      || input.payload.objects.length === 0
      || !input.payload.objects.some((object) =>
        object.object_id === input.payload.target_id
        && object.available
        && object.supported_actions.includes("go_to")
        && object.supported_actions.includes("sit")
      )
    ) {
      throw new TypeError("normalized Cat object event is not allowed by the Phase 3C contract");
    }
    const serialized = JSON.stringify(input.payload);
    for (const forbidden of ["anchor", "art_x", "floor_y", "facing", "animation"]) {
      if (serialized.includes(`\"${forbidden}\"`)) {
        throw new TypeError(`normalized Cat object event exposes forbidden ${forbidden}`);
      }
    }
  }
  return [
    { role: "system", content: profile.system_prompt },
    {
      role: "user",
      content: JSON.stringify({ event_type: input.event_type, payload: input.payload }),
    },
  ];
}
