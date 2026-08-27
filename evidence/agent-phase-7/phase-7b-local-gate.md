# Phase 7B Cat Autonomy Local Gate

> Date: 2026-08-26
> Scope: deterministic local evaluation only
> Runtime: Node v24.19.0 / pnpm 11.19.0

## Verdict

`pnpm gate:phase7` passed. This closes the Phase 7B local deterministic gate; it does not prove product startup
wiring, real Home Assistant events, real ESP32-P4 actions, physical output, or long-running real model latency.
Those remain Phase 7C requirements.

## Reproduction

```bash
cd agent
pnpm gate:phase7
```

The gate performs the Node runtime preflight, TypeScript typecheck, Phase 7 runtime/preemption tests, the
deterministic evaluator tests, and a static scan of the Cat autonomy runtime for `while (true)`, `setInterval`,
and `ask_llm` polling loops. It then writes the machine-readable report with mode `0600`:

- [phase-7b-autonomy-eval.json](./phase-7b-autonomy-eval.json)

## Results

- Seven virtual days with one bounded Timer input per minute: 10,080 input events;
- admitted model calls: 168, exactly 24 per virtual day;
- model calls without a trigger: 0;
- maximum configured output-token ceiling: 21,504 across all admitted calls;
- 1,000-event allowlisted HA storm: 1 admission and 999 policy rejections;
- malformed extra-field, unknown HA mapping, autonomy feedback, and restart catch-up cases: 0 admissions;
- Human/Robot scheduling priority, queued cancellation, active Cat cancellation, pause/disable, ingress capacity,
  scheduler capacity, and bounded audit behavior are covered by the gate tests;
- runtime static scan: zero continuous polling-loop findings.

The exact rejection distribution and gate fields are in the JSON artifact. The evaluator stores counts and stable
error codes only; it does not retain user text, HA credentials, entity ids, Memory bodies, or audio.

## Remaining boundaries

- Timer/HA/P4/task-complete source bridge is now attached behind an explicit product opt-in and has passed the
  independent [Phase 7C1 local review](./phase-7c1-product-wiring-review.md);
- no real HA connection or HA service call was performed;
- no P4 was flashed or controlled;
- no real `qwen3.6:35b-mlx` latency/cost run was performed;
- real resource stability, household event distribution, and final product review remain unvalidated.
