import json
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml"
AUDIT = ROOT / "scripts/audit-phase5e-artifacts.py"
DRIVER = ROOT / "scripts/drive-phase5e-mac-speaker.py"
NETWORK_COMPONENT = ROOT / "firmware/components/network_service/idf_component.yml"
SDKCONFIG_DEFAULTS = ROOT / "firmware/sdkconfig.defaults"
DEPENDENCY_LOCK = ROOT / "firmware/dependencies.lock"


class Phase5eProfileTests(unittest.TestCase):
    def test_esp_hosted_sdio_oom_hardening_is_pinned(self):
        component = NETWORK_COMPONENT.read_text(encoding="utf-8")
        defaults = SDKCONFIG_DEFAULTS.read_text(encoding="utf-8")
        dependency_lock = DEPENDENCY_LOCK.read_text(encoding="utf-8")

        self.assertIn('espressif/esp_hosted: "2.12.11"', component)
        self.assertIn("CONFIG_ESP_HOSTED_MEMPOOL_PREFER_SPIRAM=y", defaults)
        self.assertIn("CONFIG_CACHE_L2_CACHE_LINE_64B=y", defaults)
        self.assertIn("# CONFIG_CACHE_L2_CACHE_LINE_128B is not set", defaults)
        self.assertRegex(
            dependency_lock,
            r"(?s)  espressif/esp_hosted:.*?\n    version: 2\.12\.11\n",
        )

    def test_workflow_wires_e2e_harness_models_driver_and_audit(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        for marker in (
            "- phase5e_e2e",
            "apps/device-harness/src/voice-e2e-cli.ts",
            "drive-phase5e-mac-speaker.py",
            "audit-phase5e-artifacts.py",
            "VERIFY:phase5e:voice_e2e:PASS",
            "VERIFY:phase5e:artifact_audit:PASS",
            "P4HOME_TTS_MODEL_REVISION",
            "P4HOME_PHASE5E_PROMPT_FILE",
            "phase5e_poweron_count",
            "phase5e_reset_banner_count",
            "phase5e_crash_marker_count",
            "P4HOME_HARNESS_NODE_PID_FILE",
            "trap cleanup_background EXIT",
        ):
            self.assertIn(marker, workflow)
        driver = DRIVER.read_text(encoding="utf-8")
        self.assertIn('say", "-v", voice, text', driver)
        self.assertIn("write_attempt_not_completed_no_replay", driver)
        self.assertIn('speak_once_no_replay(args.monitor_log, args.progress_file, prompts["write"], 2)', driver)
        harness = (ROOT / "agent/apps/device-harness/src/voice-e2e-cli.ts").read_text(encoding="utf-8")
        finally_block = harness[harness.index("  } finally {"):]
        self.assertLess(finally_block.index("await runtime?.close()"), finally_block.index("restoreRobotState"))

    def test_artifact_audit_accepts_metadata_only_and_rejects_secret(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            secret = root / "secret"
            secret.write_text("top-secret-token-value", encoding="ascii")
            artifact = root / "monitor.log"
            artifact.write_text("VERIFY:phase5e:voice_e2e:PASS\n", encoding="utf-8")
            result = root / "result.json"
            result_payload = {
                "schema_version": 1, "profile": "phase5e_e2e", "passed": True,
                "interactions": [{
                    "kind": kind, "role_id": "robot" if kind in {"read", "write"} else "human",
                    "role_status": "completed", "voice_outcome": "completed",
                    "playback_statuses": ["completed"], "pcm_bytes": 640,
                } for kind in ("read", "write", "barge", "followup")],
                "stt_provider_version": "1", "stt_model_revision": "a" * 40,
                "stt_calls": 4, "stt_transcript_mismatches": 0, "stt_total_ms": 1,
                "tts_provider_version": "1", "tts_model_revision": "b" * 40,
                "tts_calls": 4, "tts_total_ms": 1, "audit_events": 8,
                "restored": True, "read_passed": True, "write_passed": True,
                "barge_in_passed": True, "followup_passed": True,
                "composition_audits_persisted": 4, "playback_segments": 4,
                "playback_bytes": 2560, "raw_audio_retained": False,
            }
            result.write_text(json.dumps(result_payload), encoding="utf-8")
            database = root / "audit.db"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE events (id TEXT, payload_json TEXT)")
                connection.execute("INSERT INTO events VALUES ('1', '{}')")
            status = root / "status"
            command = [
                "python3", str(AUDIT), "--artifact", str(artifact),
                "--secret-file", str(secret), "--audit-db", str(database),
                "--result", str(result), "--status-file", str(status),
            ]
            self.assertEqual(subprocess.run(command, check=False).returncode, 0)
            artifact.write_text("top-secret-token-value", encoding="ascii")
            self.assertNotEqual(subprocess.run(command, check=False).returncode, 0)
            artifact.write_bytes(b"prefix\x00raw-pcm")
            self.assertNotEqual(subprocess.run(command, check=False).returncode, 0)
            artifact.write_text('{"rawAudio":"present"}', encoding="utf-8")
            self.assertNotEqual(subprocess.run(command, check=False).returncode, 0)
            artifact.write_text("A" * 512, encoding="ascii")
            self.assertNotEqual(subprocess.run(command, check=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
