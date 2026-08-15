import {
  ToolExecutionError,
  type ToolDefinition,
  type ToolExecutionContext,
} from "@p4home/core";

export const ROOM_IDS = [
  "primary_bedroom",
  "study",
  "guest_room",
  "entry",
  "living_room",
  "kitchen",
] as const;

export type RoomId = (typeof ROOM_IDS)[number];
export type CharacterActivity = "idle" | "sleep";

export interface MockCharacterState {
  readonly room_id: RoomId;
  readonly activity: CharacterActivity;
  readonly speaking: boolean;
  readonly active_action_id: string | null;
}

export interface MockP4HomeDomain {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  getState(): MockCharacterState;
  getStateVersion(): number;
}

function exactArguments(
  argumentsValue: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(argumentsValue).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    throw new ToolExecutionError("INVALID_ARGUMENT", `expected arguments: ${wanted.join(", ") || "none"}`);
  }
}

function isRoomId(value: unknown): value is RoomId {
  return typeof value === "string" && (ROOM_IDS as readonly string[]).includes(value);
}

export function createMockP4HomeDomain(
  initial: Partial<Pick<MockCharacterState, "room_id" | "activity">> = {},
): MockP4HomeDomain {
  let state: MockCharacterState = {
    room_id: initial.room_id ?? "living_room",
    activity: initial.activity ?? "idle",
    speaking: false,
    active_action_id: null,
  };
  let stateVersion = 1;

  const definitions: ToolDefinition[] = [
    {
      name: "character.get_state",
      async execute(argumentsValue): Promise<Record<string, unknown>> {
        exactArguments(argumentsValue, []);
        return { ...state };
      },
    },
    {
      name: "character.go_to_room",
      async execute(argumentsValue): Promise<Record<string, unknown>> {
        exactArguments(argumentsValue, ["room_id"]);
        if (!isRoomId(argumentsValue.room_id)) {
          throw new ToolExecutionError("UNKNOWN_ROOM", "room_id is not registered in Tool Schema v1");
        }
        state = { ...state, room_id: argumentsValue.room_id };
        stateVersion += 1;
        return { room_id: state.room_id };
      },
    },
    {
      name: "character.set_activity",
      async execute(argumentsValue): Promise<Record<string, unknown>> {
        exactArguments(argumentsValue, ["activity"]);
        if (argumentsValue.activity !== "idle" && argumentsValue.activity !== "sleep") {
          throw new ToolExecutionError("INVALID_ARGUMENT", "activity must be idle or sleep");
        }
        state = { ...state, activity: argumentsValue.activity };
        stateVersion += 1;
        return { activity: state.activity };
      },
    },
    {
      name: "character.say",
      async execute(argumentsValue): Promise<Record<string, unknown>> {
        exactArguments(argumentsValue, ["text"]);
        if (
          typeof argumentsValue.text !== "string"
          || argumentsValue.text.length < 1
          || argumentsValue.text.length > 256
        ) {
          throw new ToolExecutionError("INVALID_ARGUMENT", "text must contain 1..256 characters");
        }
        stateVersion += 1;
        return { text: argumentsValue.text };
      },
    },
    {
      name: "world.get_snapshot",
      async execute(
        argumentsValue: Record<string, unknown>,
        _context: ToolExecutionContext,
      ): Promise<Record<string, unknown>> {
        exactArguments(argumentsValue, []);
        return {
          state_version: stateVersion,
          observed_at_ms: Date.now(),
          character: { ...state },
        };
      },
    },
  ];

  return {
    tools: new Map(definitions.map((definition) => [definition.name, definition])),
    getState: () => ({ ...state }),
    getStateVersion: () => stateVersion,
  };
}
