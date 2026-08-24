# Phase 6E Local Gate Evidence

> Date: 2026-08-24
> Environment: WSL2 / Linux x64
> Node: `v24.19.0`
> pnpm: `11.19.0`
> Scope: local deterministic gate only
> Result: `phase6_local_gate=passed`
> Product Memory strategy: `private`
> Real-environment evidence: `pending`

## Reproduction

The project runtime was selected with `.nvmrc`; no hardware, Home Assistant,
Ollama, STT/TTS, or other network service was started.

```bash
cd /root/workspace/p4home/agent
source /root/.nvm/nvm.sh
nvm use 24.19.0
pnpm gate:phase6
```

`pnpm gate:phase6` ran these fail-fast steps. Runtime preflight ran exactly
once, inside the gate script:

```text
node scripts/check-runtime.mjs
pnpm exec tsc --noEmit -p tsconfig.json
node --import tsx --test tests/runtime/phase-6b-memory-policy.test.ts tests/runtime/phase-6c-memory-recall.test.ts
node --import tsx --test tests/eval/memory-evaluator.test.ts
node --import tsx --test tests/storage/memory-store.test.ts tests/storage/phase-6c-memory-recall.test.ts tests/storage/sqlite-store.test.ts
node --import tsx apps/eval-cli/src/cli.ts phase6 --database :memory: --output ../evidence/agent-phase-6/.phase-6d-memory-eval.<uuid>.tmp.json
```

Any failed command or artifact verification exits the gate non-zero. The final
step first writes a same-directory temporary artifact. A verifier independent
of the evaluator's in-process gate pins report schema/suite, the canonical
dataset SHA-256 fingerprint, all three strategies' frozen retrieval/context/
mutation cases, role metrics, `gate.passed=true`, an empty failure list,
`product_runtime_strategy=private`, zero real model calls, mode `0600`, and
absence of Memory body/secret canaries. Only a verified temporary file is
atomically promoted to `phase-6d-memory-eval.json`, then verified again. The
promotion refuses to overwrite an SQLite database accidentally placed at the
fixed artifact path.

## Directed results

- Runtime preflight: Node `24.19.0`, passed.
- TypeScript typecheck: passed.
- Phase 6B/6C runtime tests: `20/20` passed.
- Memory evaluator tests: `15/15` passed, including external verifier
  regressions for permissive mode, wrong dataset fingerprint, and leaked body
  canary.
- Storage tests, including migration/reopen/FTS/expiry/deletion/recall:
  `43/43` passed.
- Deterministic evaluator: three strategy gates passed on one 22-record
  canonical dataset; deterministic retrieval `42/42`, role context budgets
  `9/9`, prompt-injection data-boundary cases `3/3`, mutation probes `6/6`.
- All strategies reported unauthorized cross-role leak count `0`, expired
  residue count `0`, deleted residue count `0`, budget violation count `0`,
  owner/source attribution `100%`, and conflict top-choice accuracy `100%`.
  Private non-applicable cross-role mutation rates remain `null`, not synthetic
  success values.
- The regenerated evaluator artifact is mode `0600` and contains identifiers,
  metrics, pending metadata, and gate results only; it contains no Memory body.

This establishes only the Phase 6 local deterministic gate. It does not establish
real-model answer quality, representative-home recall quality, hardware
end-to-end behavior, or production SQLite durability.

## Independent defect-first review and fixes

The 2026-08-24 Phase 6E review found and fixed these actionable issues:

1. `agent/package.json` and `gate-phase6.mjs` both ran runtime preflight.
   The package script now delegates directly to the gate, which owns the single
   fail-fast preflight.
2. The gate generated directly at the final evidence path and independently
   checked only mode plus a few top-level summaries. It now generates to a
   temporary file and independently binds the frozen schema, suite, dataset
   fingerprint, expected cases/mutations/context, private product boundary,
   zero model calls, gate, permissions, and body/secret canaries before atomic
   promotion.
3. Artifact output could replace an SQLite file if it was supplied as
   `--output`. The CLI and the independent gate promotion now detect and refuse
   an existing SQLite header; regression coverage proves the existing bytes
   remain unchanged. The gate still uses `:memory:`, and the optional
   file-database API accepts only new paths.
4. The Phase 6E evidence and visibility matrix were ignored by `.gitignore`.
   Phase 6 Markdown evidence is now explicitly versionable alongside the JSON
   artifact.
5. Agent/architecture documentation still described database schema v2, an
   obsolete Context order, and visibility as wholly undecided. It now records
   DB `user_version=4` versus Memory record `schema_version=1`, the implemented
   Context order, product-only `private`, and evaluator-only
   `shared_acl/hybrid`.
6. The deferred list now explicitly includes quota and retention. The
   production TODO continues to leave permissions, encryption, durability,
   backup/recovery, secure-delete, and identity work incomplete.

The SQL/runtime visibility predicates were checked against the matrix:
owner access is role-bound; cross-role access requires non-restricted data,
explicit requester ACL, the approved policy revision, and the selected
strategy/kind; old revisions fail closed only for cross-role access; expired
and deleted records are absent; Router has no Memory path. No visibility
implementation change or cross-role product enablement was needed.

## Complete test run and isolated reruns

Actual complete-suite command:

```bash
pnpm test
```

Result: `383/389` passed, `6` failed. This complete repository test run did not
pass and is not represented as a Phase 6 or repository-wide pass:

- five pre-existing Phase 4 timing/socket cases failed under the concurrent
  complete run (one Phase 4C unavailable-socket classification and four Phase 4D
  deadline/audit timing cases);
- one pre-existing Phase 5B Voice WebSocket case failed with `socket hang up`.

Actual Phase 4 isolation:

```bash
node --import tsx --test tests/runtime/phase-4c-ha-gate.test.ts tests/runtime/phase-4d-multi-assignment.test.ts
```

The first isolated run was `42/43` because the Phase 4C unavailable-socket case
still produced a timing-dependent classification. An immediate identical
isolation was `43/43`; all four Phase 4D cases that failed in the complete run
passed in both isolated runs. No Phase 4 code was changed for Phase 6E.

Actual Voice isolation:

```bash
node --import tsx --test tests/runtime/phase-5b-voice-channel.test.ts
```

Result: `14/15`; the independent Voice channel case again failed with
`socket hang up`. This is a known WSL Voice failure and remains a real failure in
the complete repository result. It is not swallowed or relabeled as a Phase 6
pass, and unrelated Voice code was not modified.

## Deferred real-environment checklist

Only real-environment items are listed below. Progress after the local gate is
tracked in [phase-6-real-environment-gates.md](./phase-6-real-environment-gates.md).

1. **Real `qwen3.6:35b-mlx` grounded-answer and prompt-injection evaluation**
   - status: `completed_redacted_fixture`
   - required environment: real Ollama with the current product-default model revision and a
     representative local-home evaluation fixture.
   - reproduction entry: `pnpm eval:phase6-live -- --model qwen3.6:35b-mlx
     --timeout-ms 300000 --output ../evidence/agent-phase-6/phase-6f-live-model-memory.json`.
2. **Representative household recall/precision/conflict selection**
   - status: `pending`
   - required environment: consented, redacted representative household Memory
     dataset with labeled relevance, ownership, conflicts, expiry, and deletions.
   - reproduction entry: a new dataset-governance and live-evaluation plan is
     required; deterministic fixture metrics are not a substitute.
3. **Real HA Robot + Memory end to end, with HA remaining truth**
   - status: `completed_commit_bound_read_gate`
   - required environment: real HA, dedicated low-privilege Robot identity,
     representative entities, real Ollama, and Agent Runtime.
   - reproduction entry: use `pnpm gate:phase6-ha-live` with the repository-external
     Phase 6G URL/token/policy/result-file environment variables; the clean-worktree
     result binds commit `7e9aa4d` and proves `service_calls=0`.
4. **Real P4 Cat + Memory end to end, with World remaining truth**
   - status: `pending`
   - required environment: real ESP32-P4, Device WebSocket, Cat World/Object
     runtime, real Ollama, and Agent Runtime.
   - reproduction entry: extend the Phase 2/3 hardware harness in a new reviewed
     plan; assert that Memory cannot override P4 snapshot/action terminal state.
5. **Long-running SQLite/WAL/crash/power-loss/backup/quota/retention/permissions/encryption/secure-delete**
   - status: `pending`
   - required environment: production-like persistent filesystem, controlled
     process kill and power-loss rig, backup target, deployment user/permissions,
     and an approved key-management/retention design.
   - reproduction entry: requires a new SQLite production-hardening plan covering
     total DB quota, retention, directory and sidecar permissions, encryption,
     backup/restore, WAL/checkpoint durability, corruption recovery, and
     media-level deletion.
6. **Multi-user and subject identity model**
   - status: `pending`
   - required environment: approved household identity/authorization model,
     multiple test users, subject ownership rules, and migration fixtures.
   - reproduction entry: requires a new identity/ACL plan; current `subject_key`
     is bounded metadata, not a verified multi-user identity model.
7. **Voice + Memory end to end**
   - status: `pending`
   - required environment: Phase 5E hardware/real-environment prerequisites,
     real P4 microphone and speaker path, STT/TTS, Ollama, and Agent Runtime.
   - reproduction entry: resume the Phase 5E real-environment gate first, then add
     Memory recall/write assertions in a reviewed Phase 6 extension.

## Completed user decision

- status: `completed`
- decision date: 2026-08-24
- decision: the user approved visibility matrix v1 and selected the recommended
  `private` strategy.
- boundary: `conversation_summary`, `user_fact`, and `task_outcome` all remain
  private to their `owner_role`; cross-role product recall remains disabled.
- future change control: `shared_acl` and `hybrid` remain evaluator-only. Any
  future relaxation requires a new versioned matrix and explicit user review.

## Current gate

`Phase 6 = local_complete_pending_real_environment`.

Local coding and review are complete. The deferred real-environment work above
remains pending. Phase 5 remains `pending_real_environment`; Phase 7 is awaiting
separate explicit authorization and has not started.
