# Agent Phase 6 — Real-environment Gates Plan

> Status: `in_progress`
> Started: 2026-08-24
> Parent: [Phase 6 — Memory](./2026-08-15-agent-phase-6-memory-plan.md)
> Current Gate: 6F real-model passed; 6G real HA read passed locally but remains
> `pending_commit_bound_rerun`; P4/Voice, representative household data, production
> SQLite and household identity remain pending

## 1. Boundaries

1. Real-model and HA read gates may run locally because they do not flash P4 or
   dispatch HA service calls.
2. HA write evidence is not required for Memory truth precedence: the dedicated
   6G gate is read-only and must prove `service_calls=0`.
3. P4/Voice gates use the self-hosted hardware workflow. Workflow green is only
   transport; the verdict requires a commit-bound manifest and raw `VERIFY:` markers.
4. Real household Memory requires a consented, redacted, labeled fixture. The
   synthetic redacted fixture cannot close that gate.
5. Crash/power-loss, encryption, backup, quota, retention and secure-delete are
   independent SQLite gates. A temporary-directory smoke cannot close media-level
   deletion or real power-loss.
6. No gate may emit Memory body, HA token, real entity id, raw audio or credential
   canaries into committed artifacts.

## 2. 6F — Real 35B grounded recall and injection boundary

- [x] Add `pnpm eval:phase6-live` using the product-selected
  `qwen3.6:35b-mlx`, real `private` Memory runtime and real SQLite Store.
- [x] Gate one grounded private recall and one prompt-injection record.
- [x] Prove Robot cannot project Human-owned Memory under the product strategy.
- [x] Persist only response SHA-256/length and booleans; do not persist Memory
  body, model response text or the injection canary.
- [x] Run on macOS arm64, Node `v24.19.0`, Ollama `0.32.15`, with two real model
  calls. Both cases passed; first/cold latency was `7530.33 ms`, warm latency was
  `350.23 ms`.
- [ ] Replace the synthetic redacted fixture with a separately approved,
  consented and labeled representative-household fixture.

Artifact:
[phase-6f-live-model-memory.json](../../evidence/agent-phase-6/phase-6f-live-model-memory.json)

## 3. 6G — Real HA truth precedence, read-only

- [x] Use the repository-external `0600` Robot token/policy/URL files.
- [x] Verify the Robot identity is non-admin and non-owner.
- [x] Seed one Robot-private stale Memory and verify the real model selects only
  `home.get_entity(alias)`.
- [x] Require the deterministic final text to contain the current HA projection
  and exclude the stale Memory signal.
- [x] Require `service_calls=0`, zero invalid outbound frames and zero token/entity
  id leakage in model request and runtime result.
- [x] Local pre-commit run passed with one real 35B call and one successful read.
- [ ] Rerun from a clean commit and bind the result to that commit before closing
  the gate. The current result is deliberately labeled `local_precommit`.

Artifact:
[phase-6g-ha-memory-read.json](../../evidence/agent-phase-6/phase-6g-ha-memory-read.json)

## 4. 6H — Real P4 Cat and Voice + Memory

- [ ] Add a dedicated Phase 6 hardware profile; do not reuse Phase 5E markers as
  Memory proof.
- [ ] Bind manifest `git_sha`, run id, profile, serial port, flash image hash and
  dependency lock to the commit under test.
- [ ] P4 Cat: inject a stale Cat-private world record, then prove the action and
  final snapshot follow the P4 World/Object runtime.
- [ ] Voice: prove real P4 microphone → STT → role runtime → private Memory recall
  → TTS/P4 playback, with no raw audio or Memory body in artifacts.
- [ ] Require explicit `VERIFY:phase6h:*:PASS` markers and reject crash/reset-loop,
  credential leakage or a workflow-only verdict.

This gate requires a reviewed workflow change, commit/push authorization and a
self-hosted hardware run. It has not started and no P4 was flashed in 6F/6G.

## 5. 6I — SQLite production filesystem and durability

- [ ] Directory and DB/WAL/SHM permissions are `0700`/`0600` on create and reopen.
- [ ] `integrity_check`, WAL checkpoint, consistent backup/restore and corruption
  fail-closed behavior have repeatable evidence.
- [ ] Approved `synchronous`/checkpoint policy survives controlled process kill;
  real power-loss remains a separate rig result.
- [ ] Database/WAL/index quota and per-class retention fail closed at their limits.
- [ ] Encryption/key rotation design and identity binding are approved.
- [ ] Secure-delete documentation and tests distinguish SQLite row deletion,
  WAL/backup remnants and SSD wear-leveling limits.

No production SQLite item is closed by the 6F/6G temporary `:memory:` stores.

## 6. Exit rule

Phase 6 remains `local_complete_pending_real_environment` until every required
real gate is either passed with its declared evidence or explicitly deferred by
user review. Passing 6F/6G does not authorize Phase 7.
