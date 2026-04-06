# Artifact Contract

## Expected Workflow

- Workflow name: `Firmware Self-Hosted Flash Serial`
- Runner labels:
  - `self-hosted`
  - `macOS`
  - `ARM64`
  - `esp32-p4`

## Expected Artifact

- Artifact name: `esp32-p4-monitor-log`

Expected files:

- `firmware/monitor.log`
- `firmware/hardware-validation-manifest.json`

## Manifest Fields

Expected manifest shape:

```json
{
  "schema_version": 1,
  "mode": "artifact-only",
  "verdict_owner": "cloud-codex",
  "git_sha": "<commit sha>",
  "run_id": "<github run id>",
  "run_attempt": "<github run attempt>",
  "job": "flash-and-monitor",
  "serial_port": "/dev/cu.usbserial-10",
  "monitor_seconds": 20,
  "log_file": "monitor.log"
}
```

Interpretation:

- `mode=artifact-only`: the workflow does not perform business-level PASS/FAIL checks
- `verdict_owner=cloud-codex`: Codex must interpret the artifact and decide whether the change worked

## Minimal Workflow Failure Model

The workflow should fail for:

- checkout/build/flash failure
- capture script failure
- missing or empty `monitor.log`
- artifact upload failure

The workflow should not fail purely because a feature-specific marker was absent.

## Verdict Model

Classify the result into one of four buckets:

- `infra-fail`: the hardware execution chain itself failed
- `pass`: the requested behavior is clearly present
- `fail`: the requested behavior is clearly absent or contradicted
- `inconclusive`: the board booted, but the log does not provide enough signal

## Preferred Log Markers

Best case:

```text
VERIFY:touch:init:PASS
VERIFY:wifi:connect:FAIL reason=timeout
VERIFY:settings:migration:PASS
```

Fallback evidence may use deterministic service or error lines, but generic boot lines alone are insufficient.
