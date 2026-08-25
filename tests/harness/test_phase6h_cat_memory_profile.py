import json
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml"
AUDITOR = ROOT / "scripts/audit-phase6h-artifacts.py"


class Phase6hCatMemoryProfileTests(unittest.TestCase):
    def test_workflow_has_dedicated_protocol_v2_profile_and_private_audit(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("- phase6h_cat_memory", workflow)
        self.assertIn('profile == "phase6h_cat_memory" and seconds < 120', workflow)
        self.assertIn('"$VALIDATION_PROFILE" == "phase6h_cat_memory"', workflow)
        self.assertIn("P4HOME_PHASE6H_AUDIT_DB", workflow)
        self.assertIn("P4HOME_PHASE6H_RAW_MONITOR_LOG", workflow)
        self.assertIn("P4HOME_PHASE6H_MEMORY_CANARY_FILE", workflow)
        self.assertIn("Audit Phase 6H upload candidates", workflow)
        self.assertIn("scripts/audit-phase6h-artifacts.py", workflow)
        upload_condition = workflow.split("      - name: Upload serial artifact", 1)[1]
        self.assertIn("inputs.validation_profile != 'phase6h_cat_memory'", upload_condition)
        self.assertIn("|| success())", upload_condition)

    def test_auditor_accepts_ids_and_markers_but_rejects_memory_body(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            monitor = root / "monitor.log"
            result = root / "result.json"
            database = root / "memory.sqlite"
            secret = root / "device-token"
            canary = root / "memory-canary"
            status = root / "status"
            output = root / "published-monitor.log"
            monitor.write_text(
                "VERIFY:phase6h:cat_memory_recall:PASS memory_id=probe\n"
                "VERIFY:phase6h:world_truth_wins:PASS target=living_room.sofa\n",
                encoding="utf-8",
            )
            result.write_text(json.dumps({
                "schema_version": 1,
                "profile": "phase6h_cat_memory",
                "protocol_version": 2,
                "memory_status": "ok",
                "selected_memory_ids": ["probe"],
                "memory_body_in_artifact": False,
                "memory_database_mode": "600",
                "stale_claim_seen_as_untrusted_data": True,
                "world_authority": "p4_object_snapshot",
                "target_object_id": "living_room.sofa",
                "pose": "sitting",
                "occupied": True,
                "state_version": 4,
            }), encoding="utf-8")
            secret.write_text("private-token-canary", encoding="utf-8")
            canary.write_text("0123456789abcdef0123456789abcdef", encoding="utf-8")
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE memories(content TEXT NOT NULL)")
                connection.execute("INSERT INTO memories VALUES (?)", ("private-memory-canary",))
            command = [
                "python3", str(AUDITOR),
                "--monitor", str(monitor),
                "--output", str(output),
                "--result", str(result),
                "--memory-db", str(database),
                "--memory-canary-file", str(canary),
                "--secret-file", str(secret),
                "--status-file", str(status),
            ]
            accepted = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertEqual(status.read_text(encoding="utf-8"), "pass\n")
            self.assertIn(
                "VERIFY:phase6h:artifact_audit:PASS",
                output.read_text(encoding="utf-8"),
            )

            monitor.write_text("private-memory-canary\n", encoding="utf-8")
            rejected = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("Memory body leaked", rejected.stderr)
            self.assertFalse(output.exists())
            self.assertEqual(status.read_text(encoding="utf-8"), "fail\n")

    def test_auditor_rejects_truncated_and_encoded_private_material(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            monitor = root / "monitor.log"
            output = root / "published.log"
            database = root / "missing.sqlite"
            secret = root / "secret"
            canary = root / "canary"
            status = root / "status"
            secret.write_text("0123456789abcdef-private-token-tail", encoding="utf-8")
            canary.write_text("fedcba9876543210-memory-canary-tail", encoding="utf-8")
            command = [
                "python3", str(AUDITOR),
                "--monitor", str(monitor),
                "--output", str(output),
                "--memory-db", str(database),
                "--memory-canary-file", str(canary),
                "--secret-file", str(secret),
                "--status-file", str(status),
            ]
            for leaked in (
                "3456789abcdef-pri",
                "ZmVkY2JhOTg3NjU0MzIxMC1tZW1vcnktY2FuYXJ5LXRhaWw=",
            ):
                monitor.write_text(f"diagnostic={leaked}\n", encoding="utf-8")
                rejected = subprocess.run(command, check=False, capture_output=True, text=True)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertFalse(output.exists())

            monitor.write_text(
                "VERIFY:phase6h:hardware_harness:FAIL reason=world_timeout\n",
                encoding="utf-8",
            )
            safe_functional_failure = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertEqual(
                safe_functional_failure.returncode, 0, safe_functional_failure.stderr
            )
            self.assertIn(
                "VERIFY:phase6h:hardware_harness:FAIL",
                output.read_text(encoding="utf-8"),
            )


if __name__ == "__main__":
    unittest.main()
