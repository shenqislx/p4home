import type {
  MemoryOwnerRole,
  MemoryProjectionStrategy,
} from "@p4home/storage-sqlite";

export const MEMORY_EVAL_STRATEGIES = [
  "private",
  "shared_acl",
  "hybrid",
] as const satisfies readonly MemoryProjectionStrategy[];

export interface MemoryEvalScenario {
  readonly id: string;
  readonly requester_role: MemoryOwnerRole;
  readonly query: string;
  readonly k: number;
  readonly expected_memory_ids: Readonly<Record<
    MemoryProjectionStrategy,
    readonly string[]
  >>;
  readonly checks_conflict_top_choice?: boolean;
}

function expected(
  privateIds: readonly string[],
  sharedAclIds = privateIds,
  hybridIds = sharedAclIds,
): Readonly<Record<MemoryProjectionStrategy, readonly string[]>> {
  return {
    private: privateIds,
    shared_acl: sharedAclIds,
    hybrid: hybridIds,
  };
}

/**
 * Frozen, reviewable expectations. Memory bodies and fixture construction live
 * in memory-eval-dataset.ts so expected results cannot be derived from fixtures.
 */
export const MEMORY_EVAL_SCENARIOS: readonly MemoryEvalScenario[] = [
  {
    id: "human-owner-user-fact",
    requester_role: "human",
    query: "human owner fact",
    k: 3,
    expected_memory_ids: expected(["mem-human-owner-fact"]),
  },
  {
    id: "robot-owner-summary",
    requester_role: "robot",
    query: "robot owner summary",
    k: 3,
    expected_memory_ids: expected(["mem-robot-owner-summary"]),
  },
  {
    id: "cat-owner-task",
    requester_role: "cat",
    query: "cat owner task",
    k: 3,
    expected_memory_ids: expected(["mem-cat-owner-task"]),
  },
  {
    id: "human-reads-robot-fact",
    requester_role: "human",
    query: "robot shared fact",
    k: 3,
    expected_memory_ids: expected(
      [],
      ["mem-robot-shared-fact"],
      ["mem-robot-shared-fact"],
    ),
  },
  {
    id: "human-reads-robot-summary",
    requester_role: "human",
    query: "robot shared summary",
    k: 3,
    expected_memory_ids: expected([], ["mem-robot-shared-summary"], []),
  },
  {
    id: "human-reads-robot-task",
    requester_role: "human",
    query: "robot shared task",
    k: 3,
    expected_memory_ids: expected([], ["mem-robot-shared-task"], []),
  },
  {
    id: "robot-reads-human-fact",
    requester_role: "robot",
    query: "human shared fact",
    k: 3,
    expected_memory_ids: expected(
      [],
      ["mem-human-shared-fact"],
      ["mem-human-shared-fact"],
    ),
  },
  {
    id: "cat-reads-robot-fact",
    requester_role: "cat",
    query: "robot cat fact",
    k: 3,
    expected_memory_ids: expected(
      [],
      ["mem-robot-cat-fact"],
      ["mem-robot-cat-fact"],
    ),
  },
  {
    id: "restricted-never-cross-role",
    requester_role: "human",
    query: "robot restricted datum",
    k: 3,
    expected_memory_ids: expected([]),
  },
  {
    id: "restricted-remains-visible-to-owner",
    requester_role: "robot",
    query: "robot restricted datum",
    k: 3,
    expected_memory_ids: expected(["mem-robot-restricted"]),
  },
  {
    id: "old-policy-never-cross-role",
    requester_role: "human",
    query: "robot legacy policy",
    k: 3,
    expected_memory_ids: expected([]),
  },
  {
    id: "expired-never-recalled",
    requester_role: "human",
    query: "robot expired datum",
    k: 3,
    expected_memory_ids: expected([]),
  },
  {
    id: "prompt-injection-is-data",
    requester_role: "human",
    query: "human injection datum",
    k: 3,
    expected_memory_ids: expected(["mem-human-prompt-injection"]),
  },
  {
    id: "conflict-current-first",
    requester_role: "robot",
    query: "robot conflict preference",
    k: 2,
    expected_memory_ids: expected([
      "mem-robot-conflict-current",
      "mem-robot-conflict-old",
    ]),
    checks_conflict_top_choice: true,
  },
] as const;

export const MEMORY_EVAL_MUTATION_CASES = {
  acl_revocation: {
    id: "acl-revocation-propagates",
    requester_role: "human",
    query: "robot revoked fact",
    memory_id: "mem-robot-revoked-fact",
    expected_before: {
      private: [],
      shared_acl: ["mem-robot-revoked-fact"],
      hybrid: ["mem-robot-revoked-fact"],
    },
  },
  deletion: {
    id: "deletion-propagates",
    requester_role: "human",
    query: "robot deleted fact",
    memory_id: "mem-robot-deleted-fact",
    expected_before: {
      private: [],
      shared_acl: ["mem-robot-deleted-fact"],
      hybrid: ["mem-robot-deleted-fact"],
    },
  },
} as const;

export const MEMORY_EVAL_CONTEXT_CASES = [
  {
    id: "human-budget",
    role: "human",
    query: "human budget datum",
    expected_memory_ids: ["mem-human-budget-small"],
    oversized_memory_id: "mem-human-budget-oversized",
  },
  {
    id: "robot-budget",
    role: "robot",
    query: "robot budget datum",
    expected_memory_ids: ["mem-robot-budget-small"],
    oversized_memory_id: "mem-robot-budget-oversized",
  },
  {
    id: "cat-budget",
    role: "cat",
    query: "cat budget datum",
    expected_memory_ids: ["mem-cat-budget-small"],
    oversized_memory_id: "mem-cat-budget-oversized",
  },
] as const satisfies readonly {
  readonly id: string;
  readonly role: MemoryOwnerRole;
  readonly query: string;
  readonly expected_memory_ids: readonly string[];
  readonly oversized_memory_id: string;
}[];
