# Phase 7C2 Real Gate Coding and Review

> Date: 2026-08-27
> Scope: dedicated hardware profile, real-environment harness, artifact privacy
> Status: coding/review passed; real workflow not yet executed

## Verdict

The `phase7_autonomy` coding gate passed local verification and two independent bug reviews after fixes. This
does not claim that a real ESP32-P4, Home Assistant, or Ollama run passed. A commit-bound workflow artifact is
still required before the Phase 7 real-environment gate can close.

## Implemented evidence boundary

- Device Protocol v2 uses per-run TLS credentials and waits for an authoritative P4 snapshot;
- the selected model is pinned to `qwen3.6:35b-mlx` in both workflow and harness;
- one 60-second Timer admission and one isolated transition derived from a real HA allowlist snapshot each require
  a completed P4 action;
- the HA transition is explicitly labelled isolated and is not represented as a household entity event;
- real HA transport remains connected under a non-admin/non-owner identity while outbound frames prove
  `call_service=0`;
- P4 reconnect, pause and disable each have explicit checks; pause and disable each observe 60 seconds with zero
  additional model calls;
- Node RSS is sampled every second across model actions, reconnect and both control windows; the result is a
  sampled peak, not an instantaneous hard memory bound;
- upload candidates fail closed on P4 credentials, HA token, real entity ids, crash/reset-loop markers and result
  schema drift.

## Independent review and fixes

Runtime and workflow reviewers found six distinct issues (one shared high-severity finding):

- the legal harness timeout could exceed the workflow status wait and suppress the artifact;
- the recurring Timer could admit a third model call while a slow HA action was running;
- endpoint-only RSS sampling could miss an intermediate peak;
- disabled mode had no independent observation window;
- the HA projection marker hard-coded `service_calls=0` before checking transport truth;
- the runner could override the selected Ollama model.

Fixes add a 20-minute hard deadline plus a covering workflow wait, a 24-hour Timer source admission interval after
the first tick, one-second peak sampling, separate pause/disable windows, truth-derived HA read-only markers, and
dual workflow/harness model pinning. Both reviewers rechecked their findings and marked every item closed.

## Local verification

```bash
cd agent
pnpm typecheck
pnpm test:phase7
pnpm test
cd ..
python3 -m unittest discover -s tests/harness -p 'test_*.py' -v
```

- TypeScript: pass;
- Phase 7 gate: 55 runtime/product/preemption tests plus 2 evaluator tests pass after all review fixes;
- full Agent regression: 436/436 pass after all review fixes;
- hardware helper/workflow tests: 44/44 pass;
- workflow YAML parse and `git diff --check`: pass.

## Remaining gate

Commit and push the reviewed code, dispatch `phase7_autonomy` with `monitor_seconds>=300`, then verify manifest
identity, image/dependency integrity, harness result and every raw `VERIFY:phase7:*` marker. Phase 7 remains
`in_progress` until that artifact and the final user review pass.
