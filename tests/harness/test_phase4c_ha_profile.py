from __future__ import annotations

import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PREPARE = ROOT / "scripts" / "prepare-phase4c-ha-profile.py"
SANITIZE = ROOT / "scripts" / "sanitize-phase4c-monitor.py"


class Phase4CHaProfileTests(unittest.TestCase):
    def run_prepare(self, directory: Path, policy: dict[str, object]) -> subprocess.CompletedProcess[str]:
        sdkconfig = directory / "sdkconfig"
        sdkconfig.write_text(
            "CONFIG_EXAMPLE=y\n"
            "CONFIG_P4HOME_PHASE4C_VALIDATION=n\n"
            'CONFIG_P4HOME_PHASE4C_VALIDATION_ENTITY_ID="switch.stale"\n',
            encoding="utf-8",
        )
        policy_path = directory / "policy.json"
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        raw_entities = policy.get("entities")
        first = raw_entities[0] if isinstance(raw_entities, list) and raw_entities else {}
        entity_id = first.get("entity_id", "switch.invalid") if isinstance(first, dict) else "switch.invalid"
        panel_path = directory / "panel_entities.json"
        panel_path.write_text(
            json.dumps({"entities": [{"entity_id": entity_id, "kind": "binary"}]}),
            encoding="utf-8",
        )
        return subprocess.run(
            [
                sys.executable,
                str(PREPARE),
                "--sdkconfig",
                str(sdkconfig),
                "--policy",
                str(policy_path),
                "--panel-entities",
                str(panel_path),
                "--entity-output",
                str(directory / "entity"),
                "--binding-output",
                str(directory / "binding"),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_private_policy_is_the_only_source_for_the_firmware_target(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            directory = Path(value)
            result = self.run_prepare(
                directory,
                {
                    "entities": [
                        {
                            "alias": "study_ceiling_light",
                            "entity_id": "switch.private_fixture",
                            "domain": "switch",
                            "read": True,
                            "write_actions": ["turn_on", "turn_off"],
                        }
                    ]
                },
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            sdkconfig = (directory / "sdkconfig").read_text(encoding="utf-8")
            self.assertIn("CONFIG_P4HOME_PHASE4C_VALIDATION=y", sdkconfig)
            self.assertIn(
                'CONFIG_P4HOME_PHASE4C_VALIDATION_ENTITY_ID="switch.private_fixture"',
                sdkconfig,
            )
            self.assertNotIn("switch.stale", sdkconfig)
            self.assertIn("# CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED is not set", sdkconfig)
            self.assertEqual((directory / "entity").read_text().strip(), "switch.private_fixture")
            self.assertEqual((directory / "binding").read_text().strip(), "1")
            self.assertEqual(stat.S_IMODE((directory / "entity").stat().st_mode), 0o600)

    def test_unsafe_or_domain_mismatched_policy_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            directory = Path(value)
            result = self.run_prepare(
                directory,
                {
                    "entities": [
                        {
                            "alias": "study_ceiling_light",
                            "entity_id": "lock.front_door",
                            "domain": "switch",
                            "read": True,
                            "write_actions": ["turn_on", "turn_off"],
                        }
                    ]
                },
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((directory / "entity").exists())

    def test_serial_sanitizer_is_exact_length_and_marks_success(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            directory = Path(value)
            entity_id = "switch.private_fixture"
            entity = directory / "entity"
            entity.write_text(f"{entity_id}\n", encoding="utf-8")
            monitor = directory / "monitor.log"
            output = directory / "artifact-monitor.log"
            original = (
                "prefix switch.private_fix sensor.other_private suffix\n"
                "VERIFY:phase4c:p4_ha_state:PASS state=on\n"
            ).encode()
            monitor.write_bytes(original)
            status = directory / "status"
            result = subprocess.run(
                [
                    sys.executable,
                    str(SANITIZE),
                    "--log",
                    str(monitor),
                    "--output",
                    str(output),
                    "--entity-file",
                    str(entity),
                    "--status-file",
                    str(status),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            sanitized = output.read_bytes()
            self.assertEqual(monitor.read_bytes(), original)
            self.assertEqual(len(sanitized), len(original))
            self.assertNotIn(entity_id.encode(), sanitized)
            self.assertNotIn(b"switch.private_fix", sanitized)
            self.assertNotIn(b"sensor.other_private", sanitized)
            self.assertIn(b"VERIFY:phase4c:p4_ha_state:PASS state=on", sanitized)
            self.assertEqual(status.read_text().strip(), "1")
            self.assertEqual(stat.S_IMODE(status.stat().st_mode), 0o600)

    def test_serial_sanitizer_failure_removes_the_artifact_path(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            directory = Path(value)
            entity = directory / "entity"
            entity.write_text("not-an-entity\n", encoding="utf-8")
            monitor = directory / "raw.log"
            monitor.write_text("switch.private_fixture\n", encoding="utf-8")
            output = directory / "artifact.log"
            output.write_text("stale-sensitive-output\n", encoding="utf-8")
            status = directory / "status"
            result = subprocess.run(
                [
                    sys.executable,
                    str(SANITIZE),
                    "--log",
                    str(monitor),
                    "--output",
                    str(output),
                    "--entity-file",
                    str(entity),
                    "--status-file",
                    str(status),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())
            self.assertFalse(status.exists())

    def test_serial_sanitizer_redacts_short_entity_ids(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            directory = Path(value)
            entity = directory / "entity"
            entity.write_text("switch.a\n", encoding="utf-8")
            monitor = directory / "raw.log"
            original = b"target switch.a and light.ab\n"
            monitor.write_bytes(original)
            output = directory / "artifact.log"
            status = directory / "status"
            result = subprocess.run(
                [
                    sys.executable,
                    str(SANITIZE),
                    "--log",
                    str(monitor),
                    "--output",
                    str(output),
                    "--entity-file",
                    str(entity),
                    "--status-file",
                    str(status),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            sanitized = output.read_bytes()
            self.assertEqual(len(sanitized), len(original))
            self.assertNotIn(b"switch.a", sanitized)
            self.assertNotIn(b"light.ab", sanitized)
            self.assertEqual(status.read_text().strip(), "1")


if __name__ == "__main__":
    unittest.main()
