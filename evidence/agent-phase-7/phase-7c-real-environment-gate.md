# Phase 7C Real Environment Gate

> Status: `completed`
> Date: 2026-08-27
> Final review: passed 2026-08-27
> Commit: `e8de907e0c776791835799826ea4d1b4c619f637`
> Workflow run: `33061620203`

## Verdict layers

1. **Workflow transport: PASS.** `Firmware Self-Hosted Flash Serial` completed successfully and uploaded
   artifact `9642220781` (`esp32-p4-monitor-log`) only after the Phase 7 privacy audit and completeness
   assertion passed.
2. **Artifact integrity: PASS.** The manifest binds run `33061620203`, attempt `1`, profile
   `phase7_autonomy`, `/dev/cu.usbserial-210`, the exact commit, firmware image SHA256 and dependency-lock
   SHA256. The profile declared a 1,235-second fail-safe capture ceiling; the harness terminal was observed
   and the required post-terminal window completed after 234 actual capture seconds. Both downloaded files
   were restored to mode `0600` before local verification.
3. **Functional gate: PASS.** Manifest `agent_harness_status` is `0` and the structured result is
   `passed=true`; all nine required Phase 7 `VERIFY:` markers occur exactly once, with no contradictory
   FAIL, crash or reset-loop marker.

## Hardware and firmware evidence

- Chip: `ESP32-P4 revision v1.0`; serial device: `/dev/cu.usbserial-210`.
- Flash: four `Hash of data verified.` records followed by `Hard resetting via RTS pin...`.
- Boot: one `rst:0x1 (POWERON)` banner; manifest reset count `1`, crash-marker count `0`.
- Firmware image: `p4home_firmware.bin`, 1,730,544 bytes,
  SHA256 `dc588e9a1261c9b83f363f20575be86737faafee843c7b7c4056c9c892fef06e`.
- Dependency lock SHA256:
  `7a9dd40763204be5a8385d837d31f1af1482a712766546245e10ebcc2cff9a95`.

## Phase 7 functional evidence

- Fixed real model: `qwen3.6:35b-mlx`; exactly 2 real model calls.
- Device Protocol v2; 2 completed P4 actions; reconnect snapshot passed at state version `6` without replay.
- Timer action and the isolated HA projection action both reached terminal completion. The projection was
  derived from a real allowlist snapshot but injected only inside the isolated gate; this does not claim a
  real household HA state transition.
- The Phase 7 Agent `RobotHaClient` was ready under a non-admin, non-owner identity and recorded
  `agent_service_calls=0`, `agent_invalid_frames=0` for its connection lifecycle.
- The built-in P4 HA client emitted a monotonic service-call metric. Every captured sample was zero, and two
  READY samples with `service_calls=0` occurred after the unique harness-terminal capture marker.
- Pause and disabled each held for 60 seconds with zero additional model calls.
- 1-second sampled peak RSS growth was 4,718,592 bytes against the 67,108,864-byte limit; heap sampled peak
  growth was 50,616 bytes; P4 remained ready at the resource checkpoint.
- Model requests contained neither the real HA token nor a real HA entity id.
- Artifact audit used the frozen Robot policy, the tracked panel entity catalog and the resolved hardware
  sdkconfig. It covered 36 unique entity values, redacted 43 occurrences and found no remaining credential,
  known entity fragment or unknown entity-shaped token.

Sanitized marker summary (`action_id` omitted):

```text
VERIFY:phase7:product_ready:PASS protocol=2 model=qwen3.6:35b-mlx ha_aliases=1
VERIFY:phase7:timer_action:PASS ... model_calls=1
VERIFY:phase7:ha_projection_action:PASS origin=isolated_transition_from_real_allowlist_snapshot
VERIFY:phase7:p4_reconnect:PASS state_version=6
VERIFY:phase7:pause_disable:PASS pause_seconds=60 disable_seconds=60 model_calls_while_blocked=0
VERIFY:phase7:resource_stability:PASS observation_seconds=120 rss_peak_growth_bytes=4718592 rss_limit_bytes=67108864 p4_ready=true
VERIFY:phase7:ha_read_only:PASS agent_service_calls=0 agent_invalid_frames=0
VERIFY:phase7:p4_ha_read_only:PASS service_calls=0 ready_samples=2
VERIFY:phase7:artifact_audit:PASS credentials=false entity_ids=false entity_values=36 entity_redactions=43
```

## Invalidated runs and closure review

- Run `33053183278` stopped before flashing because port `18443` was already owned by the persistent product
  Voice service (`EADDRINUSE`). That service was preserved; the gate moved to isolated port `28443`.
- Run `33054009328` completed build, flash, capture and harness execution, then correctly blocked upload when
  the first auditor detected HA entity ids in the upload candidate.
- Run `33056257943` / commit `194c02d` initially appeared successful, but independent review found six
  complete non-policy HA entity ids plus partial suffixes in its uploaded sanitized monitor. Its artifact
  `9640146129` was deleted and verified absent. The workflow result remains historical transport evidence
  only and is not a Phase 7 PASS artifact.
- Commit `e8de907` closes the discovered gaps: inventory union, global longest-first redaction, nested and
  non-canonical encoding checks, exact result schema/canonical scan, atomic private publication, post-terminal
  capture proof, and distinct Agent/P4 HA dispatch counters.
- The 7C1 runtime and security reviews closed their scoped product-wiring findings. A later C3 scope review
  exposed the P4-counter and artifact-privacy gaps documented above; commit `e8de907` fixed them. The final
  C3 firmware and security reviews each reported zero remaining high or medium findings.

## Local regression gates

- `pnpm gate:phase7`: 55 runtime/product/preemption tests + 2 deterministic evaluator tests passed.
- `pnpm test`: 436/436 passed under Node `24.19.0`.
- Python workflow/helper suite: 47/47 passed.
- `git diff --check`: passed; Phase 7 evaluator evidence remained `0600`.

## Boundary

This run closes the Phase 7 technical real-environment gate. It proves bounded Cat autonomy over the real
model, a real read-only HA allowlist snapshot and real P4 transport. The two zero dispatch counters cover the
Phase 7 Agent `RobotHaClient` and the built-in P4 HA client respectively; they do not prove zero writes by
other HA clients or globally at the HA server. The run does not prove a real household HA state change or
unrestricted production deployment. The user passed the final review on 2026-08-27, and Phase 7 is closed
and archived; the technical boundaries above remain unchanged. The public repository also tracks a 36-entry
panel entity catalog; whether those names are acceptable public configuration or require history remediation
is a separate governance decision. This gate neither rewrites repository history nor treats that
classification question as an artifact PASS claim.
