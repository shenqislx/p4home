import json
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml"
AUDITOR = ROOT / "scripts/audit-phase7-artifacts.py"


def valid_result() -> dict[str, object]:
    return {
        "schema_version": 1,
        "profile": "phase7_autonomy",
        "passed": True,
        "model": "qwen3.6:35b-mlx",
        "real_model_calls": 2,
        "protocol_version": 2,
        "timer_action_completed": True,
        "ha_projected_action_completed": True,
        "ha_projection_origin": "isolated_transition_from_real_allowlist_snapshot",
        "p4_actions_completed": 2,
        "p4_reconnect_snapshot_verified": True,
        "p4_state_version": 7,
        "ha_client_ready": True,
        "ha_policy_aliases": 1,
        "ha_service_calls_dispatched": 0,
        "ha_invalid_outbound_frames": 0,
        "robot_non_admin": True,
        "robot_non_owner": True,
        "pause_blocked_model_calls": True,
        "disable_blocked_model_calls": True,
        "stability_observation_ms": 120000,
        "rss_peak_growth_bytes": 1024,
        "rss_growth_limit_bytes": 67108864,
        "heap_peak_growth_bytes": 512,
        "execution_terminal_records": 2,
        "request_contains_ha_token": False,
        "request_contains_entity_id": False,
        "reason": "ok",
    }


class Phase7AutonomyProfileTests(unittest.TestCase):
    def test_workflow_has_dedicated_real_environment_profile(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        harness = (
            ROOT / "agent/apps/device-harness/src/phase7-autonomy-cli.ts"
        ).read_text(encoding="utf-8")
        self.assertIn("- phase7_autonomy", workflow)
        self.assertIn('profile == "phase7_autonomy" and seconds < 300', workflow)
        self.assertIn("apps/device-harness/src/phase7-autonomy-cli.ts", workflow)
        self.assertIn('echo "OLLAMA_MODEL=qwen3.6:35b-mlx"', workflow)
        self.assertIn("harness_wait_attempts=9000", workflow)
        self.assertIn("Audit Phase 7 upload candidates", workflow)
        self.assertIn("scripts/audit-phase7-artifacts.py", workflow)
        self.assertIn("const HARNESS_DEADLINE_MS = 1_200_000", harness)
        self.assertIn("timer: 86_400_000", harness)
        self.assertIn("rss_peak_growth_bytes", harness)
        self.assertIn("pause_seconds=60 disable_seconds=60", harness)
        self.assertNotIn(
            "origin=isolated_transition_from_real_allowlist_snapshot service_calls=0",
            harness,
        )
        upload_condition = workflow.split("      - name: Upload serial artifact", 1)[1]
        self.assertIn("inputs.validation_profile != 'phase7_autonomy'", upload_condition)
        self.assertIn("|| success())", upload_condition)

    def test_auditor_accepts_bounded_result_and_rejects_credentials_and_entity_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            monitor = root / "monitor.log"
            result = root / "result.json"
            policy = root / "policy.json"
            token = root / "token"
            private_key = root / "key.pem"
            status = root / "status"
            output = root / "published.log"
            monitor.write_text(
                "VERIFY:phase7:timer_action:PASS action_id=cat7:probe\n"
                "VERIFY:phase7:ha_read_only:PASS service_calls=0\n",
                encoding="utf-8",
            )
            result.write_text(json.dumps(valid_result()), encoding="utf-8")
            result.chmod(0o600)
            policy.write_text(json.dumps({
                "entities": [{"entity_id": "light.private_phase7_test"}],
            }), encoding="utf-8")
            token.write_text("0123456789abcdef0123456789abcdef", encoding="utf-8")
            private_key.write_text(
                "-----BEGIN PRIVATE KEY-----\nprivate-phase7-key-body\n",
                encoding="utf-8",
            )
            command = [
                "python3", str(AUDITOR),
                "--monitor", str(monitor),
                "--output", str(output),
                "--result", str(result),
                "--ha-policy", str(policy),
                "--secret-file", str(token),
                "--secret-file", str(private_key),
                "--status-file", str(status),
            ]
            accepted = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertEqual(status.read_text(encoding="utf-8"), "pass\n")
            self.assertIn(
                "VERIFY:phase7:artifact_audit:PASS",
                output.read_text(encoding="utf-8"),
            )

            for leaked in (
                "456789abcdef0123",
                "light.private_phase7_test",
            ):
                monitor.write_text(f"diagnostic={leaked}\n", encoding="utf-8")
                rejected = subprocess.run(
                    command, check=False, capture_output=True, text=True
                )
                self.assertNotEqual(rejected.returncode, 0)
                self.assertFalse(output.exists())
                self.assertEqual(status.read_text(encoding="utf-8"), "fail\n")

    def test_auditor_preserves_safe_functional_failure_for_verdict_owner(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            monitor = root / "monitor.log"
            policy = root / "policy.json"
            token = root / "token"
            status = root / "status"
            output = root / "published.log"
            monitor.write_text(
                "VERIFY:phase7:hardware_harness:FAIL reason=model_timeout\n",
                encoding="utf-8",
            )
            policy.write_text(json.dumps({
                "entities": [{"entity_id": "light.private_phase7_test"}],
            }), encoding="utf-8")
            token.write_text("0123456789abcdef0123456789abcdef", encoding="utf-8")
            completed = subprocess.run([
                "python3", str(AUDITOR),
                "--monitor", str(monitor),
                "--output", str(output),
                "--ha-policy", str(policy),
                "--secret-file", str(token),
                "--status-file", str(status),
            ], check=False, capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn(
                "VERIFY:phase7:hardware_harness:FAIL",
                output.read_text(encoding="utf-8"),
            )


if __name__ == "__main__":
    unittest.main()
