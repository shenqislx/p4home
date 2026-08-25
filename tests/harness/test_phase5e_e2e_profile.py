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
UI_DRIVER = ROOT / "scripts/drive-phase5e-ui-speakerless.py"
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
        self.assertIn("VERIFY:phase5e:voice_e2e:PASS", harness)
        self.assertIn(
            "VERIFY:phase5e:artifact_audit:PASS",
            AUDIT.read_text(encoding="utf-8"),
        )
        finally_block = harness[harness.rindex("  } finally {"):]
        self.assertLess(finally_block.index("await runtime?.close()"), finally_block.index("restoreRobotState"))

    def test_workflow_wires_speakerless_real_model_ui_gate(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        for marker in (
            "- phase5e_ui",
            "phase5e_ui requires monitor_seconds>=900",
            "apps/device-harness/src/voice-ui-e2e-cli.ts",
            "drive-phase5e-ui-speakerless.py",
            "P4HOME_PHASE5E_UI_INPUT_STATUS_FILE",
            'profile in {"phase4c_ha", "phase5e_e2e", "phase5e_ui"}',
        ):
            self.assertIn(marker, workflow)
        driver = UI_DRIVER.read_text(encoding="utf-8")
        self.assertIn('say("Hi ESP", "Samantha")', driver)
        self.assertIn("write_attempt_not_completed_no_replay", driver)
        self.assertNotIn("PLAYBACK_MARKER", driver)
        harness = (
            ROOT / "agent/apps/device-harness/src/voice-ui-e2e-cli.ts"
        ).read_text(encoding="utf-8")
        for marker in (
            "new OllamaHttpProvider",
            "new PythonSttProvider",
            'ui_output: "required"',
            'audio_output: "disabled"',
            "createPrivateRoleMemoryRuntime",
            "validatePhase5eSpeakerlessUiGate",
            "VERIFY:phase5e:voice_ui_e2e:PASS",
        ):
            self.assertIn(marker, harness)
        ui_actor = (
            ROOT / "firmware/components/ui_pages/ui_home_actor.c"
        ).read_text(encoding="utf-8")
        voice_transport = (
            ROOT / "firmware/components/voice_transport/voice_transport.c"
        ).read_text(encoding="utf-8")
        self.assertIn("VERIFY:phase5e:ui_conversation:PASS", ui_actor)
        self.assertIn("VERIFY:phase5e:ui_applied:PASS", voice_transport)
        finally_block = harness[harness.rindex("  } finally {"):]
        self.assertLess(finally_block.index("await runtime?.close()"), finally_block.index("restoreRobotState"))

    def test_workflow_keeps_business_verdict_out_of_transport_assertion(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        assertion = workflow.split(
            "      - name: Assert transport artifact is complete", 1
        )[1].split("      - name: Write job summary", 1)[0]
        self.assertIn("test -s firmware/monitor.log", assertion)
        self.assertIn("test -s firmware/hardware-validation-manifest.json", assertion)
        self.assertIn('grep -qx "pass" "$P4HOME_PHASE5E_AUDIT_STATUS_FILE"', assertion)
        for business_gate in (
            "voice_stt_unified:PASS",
            "voice_e2e:PASS",
            "voice_ui_e2e:PASS",
            "ui_conversation:PASS",
            "ui_applied:PASS",
            'grep -qx "0" "$AGENT_HARNESS_STATUS_FILE"',
            'grep -qx "0" "$P4HOME_PHASE5E_UI_INPUT_STATUS_FILE"',
        ):
            self.assertNotIn(business_gate, assertion)
        self.assertIn(
            "if: failure() && inputs.validation_profile != 'phase5e_e2e' "
            "&& inputs.validation_profile != 'phase5e_ui'",
            workflow,
        )
        flash_step = workflow.split(
            "      - name: Flash firmware and capture serial", 1
        )[1].split("      - name: Append Agent harness evidence", 1)[0]
        self.assertIn("phase5e_artifact_only=yes", flash_step)
        self.assertIn("evidence_capture=continuing", flash_step)

    def test_artifact_audit_allows_missing_business_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            secret = root / "secret"
            secret.write_text("top-secret-token-value", encoding="ascii")
            artifact = root / "monitor.log"
            artifact.write_text(
                "VERIFY:phase5e:voice_ui_e2e:FAIL reason=model_unavailable\n",
                encoding="utf-8",
            )
            status = root / "status"
            command = [
                "python3", str(AUDIT), "--artifact", str(artifact),
                "--secret-file", str(secret), "--status-file", str(status),
            ]
            self.assertEqual(subprocess.run(command, check=False).returncode, 0)
            self.assertEqual(status.read_text(encoding="ascii"), "pass\n")

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

    def test_artifact_audit_checks_sqlite_storage_type_not_column_affinity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            secret = root / "secret"
            secret.write_text("top-secret-token-value", encoding="ascii")
            artifact = root / "monitor.log"
            artifact.write_text("VERIFY:phase5e:voice_ui_e2e:FAIL\n", encoding="utf-8")
            database = root / "audit.db"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE events (payload BLOB, flexible ANY)")
                connection.execute("INSERT INTO events VALUES ('{}', 'safe metadata')")
            status = root / "status"
            command = [
                "python3", str(AUDIT), "--artifact", str(artifact),
                "--secret-file", str(secret), "--audit-db", str(database),
                "--status-file", str(status),
            ]
            self.assertEqual(subprocess.run(command, check=False).returncode, 0)

            with sqlite3.connect(database) as connection:
                connection.execute(
                    "INSERT INTO events VALUES (?, 'safe metadata')",
                    (sqlite3.Binary(b"binary payload"),),
                )
            self.assertNotEqual(subprocess.run(command, check=False).returncode, 0)

            with sqlite3.connect(database) as connection:
                connection.execute("DELETE FROM events WHERE typeof(payload) = 'blob'")
                connection.execute(
                    "INSERT INTO events VALUES ('{}', ?)",
                    ("A" * 512,),
                )
            self.assertNotEqual(subprocess.run(command, check=False).returncode, 0)

    def test_artifact_audit_accepts_speakerless_ui_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            secret = root / "secret"
            secret.write_text("top-secret-token-value", encoding="ascii")
            artifact = root / "monitor.log"
            artifact.write_text("VERIFY:phase5e:voice_ui_e2e:PASS\n", encoding="utf-8")
            result = root / "result.json"
            result.write_text(json.dumps({
                "schema_version": 1, "profile": "phase5e_ui", "passed": True,
                "interaction_kinds": ["read", "write", "chat"],
                "role_ids": ["robot", "robot", "human"],
                "role_statuses": ["completed"] * 3,
                "voice_outcomes": ["completed"] * 3,
                "ui_delivery_statuses": ["completed"] * 3,
                "audio_delivery_statuses": ["deferred"] * 3,
                "stt_provider_version": "1", "stt_model_revision": "a" * 40,
                "stt_calls": 3, "stt_transcript_mismatches": 0, "stt_total_ms": 1,
                "real_model_calls": 7, "audit_events": 6, "restored": True,
                "read_passed": True, "write_passed": True, "chat_passed": True,
                "ui_deliveries_completed": 3, "audio_delivery_deferred": True,
                "composition_audits_persisted": 3, "raw_audio_retained": False,
            }), encoding="utf-8")
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
            payload = json.loads(result.read_text(encoding="utf-8"))
            payload["ui_delivery_statuses"][1] = "failed"
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(subprocess.run(command, check=False).returncode, 0)
            payload["unexpected"] = "field"
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(subprocess.run(command, check=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
