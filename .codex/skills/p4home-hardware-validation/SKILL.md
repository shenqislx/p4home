---
name: p4home-hardware-validation
description: Validate firmware changes in the `p4home` repo through the self-hosted ESP32-P4 GitHub Actions workflow and its uploaded serial artifacts. Use when Codex needs to trigger or inspect the `Firmware Self-Hosted Flash Serial` workflow, read `esp32-p4-monitor-log`, interpret `hardware-validation-manifest.json` and `monitor.log`, or decide whether a hardware run proves a firmware change.
---

# P4Home Hardware Validation

Use this skill only in the `p4home` repository.

## Workflow

1. Read the local protocol first:
   - `docs/cloud-codex-hardware-validation.md`
   - `.github/workflows/firmware-self-hosted-flash-serial.yml`
2. Treat the workflow as transport only:
   - success means `build -> flash -> serial capture -> artifact upload` worked
   - success does not mean the firmware change passed functional validation
3. Obtain the artifact `esp32-p4-monitor-log`.
4. Read `hardware-validation-manifest.json` before `monitor.log`.
5. Use `verification_case` and `expected_markers` from manifest to scope the judgment.
6. Check that the artifact belongs to the commit under test.
7. Judge the firmware change from log evidence, not from the GitHub job color alone.

For the exact artifact contract and verdict model, read [references/artifact-contract.md](references/artifact-contract.md).

## Decision Rules

- Prefer explicit `VERIFY:` markers in the serial log.
- Treat generic boot success lines as infrastructure evidence, not feature evidence.
- Separate these conclusions in the final answer:
  - workflow status
  - artifact integrity
  - functional verdict
  - evidence lines
- Use `inconclusive` when the firmware booted but the requested behavior is not machine-discernible.
- When the log is ambiguous, recommend adding stable markers such as `VERIFY:<area>:PASS` or `VERIFY:<area>:FAIL`.

## Evidence Standard

- Strong evidence:
  - explicit `VERIFY:` markers
  - deterministic service-init lines tied to the requested behavior
  - deterministic failure lines tied to the requested behavior
- Weak evidence:
  - bootloader lines
  - generic app startup lines
  - board initialization lines unrelated to the requested change

Never claim feature success from weak evidence alone.

## Reporting

Report results in this order:

1. Commit or workflow run being evaluated
2. Whether the artifact is valid for that run
3. Functional verdict: `pass`, `fail`, or `inconclusive`
4. The specific log evidence that supports the verdict
5. The next action if more signal is needed
