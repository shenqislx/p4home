# Phase 6 Real-environment Gate Evidence

> Date: 2026-08-24
> Status: `completed_with_accepted_deferrals`
> Plan: [Phase 6 real-environment gates](../../docs/archive/plans/agent/2026-08-24-agent-phase-6-real-environment-gates-plan.md)

## 6F real-model Memory gate — PASS

Environment:

- model: `qwen3.6:35b-mlx` (installed size reported by Ollama: 21 GB);
- Ollama: `0.32.15`;
- runtime: Node `v24.19.0`, macOS arm64;
- product projection: `private`;
- fixture: two synthetic, redacted representative records; no real household data.

Command:

```bash
pnpm eval:phase6-live -- --model qwen3.6:35b-mlx --timeout-ms 300000 \
  --output ../evidence/agent-phase-6/phase-6f-live-model-memory.json
```

Result:

- real model calls: `2`;
- grounded private recall: PASS, expected Memory selected, expected answer signal present;
- prompt-injection boundary: PASS, expected Memory selected, canary absent;
- Robot projection of Human Memory: `0`, PASS;
- cold/first latency: `7530.33 ms`; warm/second latency: `350.23 ms`;
- artifact contains only response hash/length and verdict fields, not response or Memory body.

Artifact:
[phase-6f-live-model-memory.json](./phase-6f-live-model-memory.json)

The real-model portion is passed. The consented representative-household dataset
is a separate pending gate and is not replaced by this redacted fixture.

## 6G real HA + Memory read gate — COMMIT-BOUND PASS

Environment and boundary:

- real Home Assistant with one allowlisted entity;
- repository-external Robot identity; non-admin and non-owner;
- real `qwen3.6:35b-mlx` call;
- read-only client view; no `call_service` is allowed or required;
- one stale Robot-private Memory deliberately conflicts with current HA truth.

Strong marker:

```text
VERIFY:phase6g:ha_memory_truth:PASS model=qwen3.6:35b-mlx memory_selected=1 tool_status=success service_calls=0
```

Result:

- Memory recall: `ok`, exactly one expected private Memory selected;
- HA tool result: `success`;
- deterministic final text contains the current HA projected state and excludes
  the stale Memory signal;
- outbound HA service calls: `0`;
- invalid outbound frames: `0`;
- token/entity id in model request or runtime result: all `false`.

Artifact:
[phase-6g-ha-memory-read.json](./phase-6g-ha-memory-read.json)

The result is labeled `evidence_scope=commit_bound`: it was produced from a clean
worktree and binds commit `7e9aa4d4b334b89c899007b13dddc745a6546dd8`.

## 6H real P4 Cat + Memory — COMMIT-BOUND PASS

- workflow run: `32819132030`, job `97713402242`, transport status `success`;
- manifest binds commit `9688887c7979e03bf11a1e640aac771736389a48`, profile
  `phase6h_cat_memory`, `/dev/cu.usbserial-210`, ESP32-P4 rev v1.0;
- app image: 1,487,424 bytes, SHA-256
  `e1582b55577f47b78125f7133caa06d6770c889fda6a88bfd9fe33293dffb40f`;
- harness status `0`, artifact audit `pass`, one POWERON reset and zero crash markers;
- stale private Memory was selected only as untrusted data; `go_to` and `sit` completed, and the
  final World remained the P4 Object snapshot (`sitting`, occupied, state version 6);
- committed evidence contains no Memory body, canary, credential, TLS private key or full serial log.

Strong markers:

```text
VERIFY:phase6h:cat_memory_recall:PASS memory_id=p6h-stale projection=private treatment=untrusted_data
VERIFY:phase6h:world_truth_wins:PASS target=living_room.sofa pose=sitting occupied=true state_version=6
VERIFY:phase6h:artifact_privacy:PASS memory_body=false db_mode=600
VERIFY:phase6h:artifact_audit:PASS memory_body=false credentials=false
```

Artifact: [phase-6h-p4-cat-memory.json](./phase-6h-p4-cat-memory.json)

The functional verdict is `pass`; it comes from manifest integrity plus raw markers, not the green
workflow alone. Voice + Memory is not covered and was explicitly deferred on 2026-08-25 because
the user is away and no microphone is available.

## 6I real SQLite filesystem subset — COMMIT-BOUND PASS

Command:

```bash
P4HOME_PHASE6I_RESULT_FILE=../evidence/agent-phase-6/phase-6i-sqlite-filesystem.json \
  pnpm gate:phase6-sqlite-live
```

Strong marker:

```text
VERIFY:phase6i:sqlite_filesystem:PASS mode=600 wal=600 shm=600 kill=SIGKILL integrity=ok online_backup=ok
```

Result on macOS/APFS with Node `v24.19.0`:

- directory/DB/WAL/SHM modes: `0700`/`0600`/`0600`/`0600`;
- permissive DB and sidecar reopen: rejected; symlink rejection is covered by regression tests;
- actual Store pragmas: `journal_mode=wal`, `synchronous=1` (`NORMAL`);
- clean reopen and `integrity_check=ok`;
- synthetic truncation corruption: rejected;
- controlled child-process `SIGKILL`: recovered `113` committed synthetic records,
  post-kill `integrity_check=ok`, checkpoint busy count `0`, and bounded reopen read passed;
- online backup while the Store remains open: atomically published mode `0600`,
  `integrity_check=ok`, expected pre-snapshot record restored, post-snapshot record absent;
- explicit-checkpoint cold backup: mode `0600`, `integrity_check=ok`, one expected
  synthetic record restored;
- artifact contains verdicts/counts only and is mode `0600`.

Quota/retention revision 1 refresh:

- the small boundary probes rejected DB growth at `483328/524288` bytes, a pinned-reader WAL write
  at `49472/527392` bytes, and index headroom growth at `147456/663552` bytes;
- the approved production policy opened a real APFS Store with DB/WAL/index limits
  `134217728/268435456/268435456` bytes (128/256/256 MiB);
- all 9 `kind × sensitivity` default expiry values matched retention revision 1; overlong expiry,
  violating legacy reopen and expired-row residue all failed closed;
- artifact fields are `quota_gate_validated=true`, `retention_gate_validated=true` and
  `production_policy_validated=true`.

Deletion-remnant boundary (commit-bound follow-up):

- logical cascade deletion removes the Memory from SQL/FTS/ACL and from a new
  online backup, while the deletion audit remains body-free;
- the same temporary APFS probe proves that the deletion canary remains readable
  from a pre-delete backup and prior WAL frames;
- the gate now records the actual `PRAGMA secure_delete` value (`0` on Node
  `v24.19.0`); this is evidence of the current limit, not a secure-erasure pass;
- [SQLite deletion and remnant boundary](../../docs/sqlite-deletion-remnants.md)
  records why APFS snapshots, backup copies and SSD wear leveling remain outside
  application-level SQLite deletion guarantees.

Regression:

- commit-bound baseline `pnpm typecheck`: PASS;
- commit-bound baseline storage plus Phase 6I tests: `49/49` PASS;
- commit-bound baseline `pnpm gate:phase6`: PASS;
- commit-bound baseline full Agent suite outside the filesystem/network sandbox:
  `399/399` PASS;
- the sandboxed attempt passed `376/399`; all 23 failures were localhost server
  `listen EPERM` restrictions. Re-running the identical command with local bind
  permission passed all WebSocket/HA/Voice and SQLite tests.
- deletion-remnant commit-bound follow-up: typecheck PASS, storage plus Phase 6I `50/50`
  PASS and `pnpm gate:phase6` PASS;
- follow-up full suite: `399/400`; the only failure was the pre-existing Phase 4C
  unavailable-socket timing classification (`transport_error` instead of
  `unsafe_initial_state`) under full parallel load. The exact localhost test passed
  `3/3` when isolated and does not execute the SQLite deletion path.

Artifact:
[phase-6i-sqlite-filesystem.json](./phase-6i-sqlite-filesystem.json)

The result is `commit_bound`, was produced from a clean worktree, and binds implementation commit
`899b7465174f8e555bb817785d220434cef786ab`. It does not claim real power-loss, encryption/key
rotation or media-level secure delete.

## Still pending

- consented, redacted, labeled representative household Memory dataset — deferred 2026-08-25;
- Voice + Memory artifact-first hardware profile and run — deferred 2026-08-25, no microphone and
  user away;
- SQLite real power-loss, encryption/key rotation and media-level secure-delete — deferred
  2026-08-25;
- household multi-user/subject identity model — deferred 2026-08-25.

Quota/retention revision 1 is approved, implemented and commit-bound. On 2026-08-25 the user passed
final review, accepted all deferred items listed above and closed Phase 6. Deferred items remain
unvalidated, not failed. Phase 7 remains unauthorized and has not started.

Closure regression on macOS arm64 / Node `v24.19.0`:

- `pnpm gate:phase6`: PASS;
- Phase 6B/6C runtime tests: `21/21` PASS;
- Memory evaluator tests: `15/15` PASS;
- storage tests: `48/48` PASS;
- deterministic Phase 6 report independently verified and atomically published.
