import importlib.util
import io
import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import tarfile
import unittest
from contextlib import closing, redirect_stdout
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml"
AUDIT = ROOT / "scripts/audit-phase5e-artifacts.py"
DRIVER = ROOT / "scripts/drive-phase5e-mac-speaker.py"
UI_DRIVER = ROOT / "scripts/drive-phase5e-ui-speakerless.py"
NETWORK_COMPONENT = ROOT / "firmware/components/network_service/idf_component.yml"
SDKCONFIG_DEFAULTS = ROOT / "firmware/sdkconfig.defaults"
DEPENDENCY_LOCK = ROOT / "firmware/dependencies.lock"


def phase5e_metrics(role_id: str, mode: str, outcome: str = "completed") -> dict:
    def stage(measurement: str, status: str, attempts: int | None = None) -> dict:
        attempted = measurement in {"agent", "status_only"}
        cancelled = status == "cancelled"
        return {
            "measurement": measurement,
            "status": status,
            "duration_ms": 1 if measurement == "agent" else None,
            "attempts": (1 if attempted else 0) if attempts is None else attempts,
            "dropped": 0,
            "cancelled": 1 if cancelled else 0,
        }

    speakerless = mode == "speakerless_ui"
    playback_status = "cancelled" if outcome == "cancelled" else "completed"
    stages = {
        "stt": stage("agent", "completed"),
        "router": stage("status_only", "completed"),
        "human": stage(
            "status_only" if role_id == "human" else "not_applicable",
            "completed" if role_id == "human" else "not_applicable",
        ),
        "robot": stage(
            "status_only" if role_id == "robot" else "not_applicable",
            "completed" if role_id == "robot" else "not_applicable",
        ),
        "composer": stage("status_only", "completed"),
        "tts": stage(
            "not_applicable" if speakerless else "agent",
            "not_applicable" if speakerless else "completed",
        ),
        "ui": stage(
            "agent" if speakerless else "not_applicable",
            "completed" if speakerless else "not_applicable",
            2 if speakerless else 0,
        ),
        "playback_transport": stage(
            "not_applicable" if speakerless else "agent",
            "not_applicable" if speakerless else playback_status,
        ),
        "p4_wake": stage("hardware_pending", "hardware_pending"),
        "p4_vad": stage("hardware_pending", "hardware_pending"),
        "p4_playback": stage("hardware_pending", "hardware_pending"),
    }
    return {
        "schema_version": 1,
        "stages": stages,
        "dropped_events": 0,
        "cancelled_stages": 1 if outcome == "cancelled" else 0,
        "interaction_cancelled": 1 if outcome == "cancelled" else 0,
    }


class Phase5eProfileTests(unittest.TestCase):
    @staticmethod
    def write_secret(path: pathlib.Path, value: str = "top-secret-token-value"):
        path.write_text(value, encoding="ascii")
        path.chmod(0o600)

    @staticmethod
    def init_repo(root: pathlib.Path):
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(
            ["git", "hash-object", "-w", "--stdin"], cwd=root,
            input=b"bounded synthetic source object", check=True,
            stdout=subprocess.DEVNULL,
        )

    @staticmethod
    def write_source_archive(path: pathlib.Path, payload: bytes):
        with tarfile.open(path, "w:gz") as archive:
            member = tarfile.TarInfo("p4home/source.txt")
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))

    def audit_command(
        self,
        root: pathlib.Path,
        artifact: pathlib.Path,
        secret: pathlib.Path,
        status: pathlib.Path,
        *extra: str,
    ) -> list[str]:
        return [
            "python3", str(AUDIT), "--repo", str(root),
            "--artifact", str(artifact), "--secret-file", str(secret),
            *extra, "--status-file", str(status),
        ]

    def run_audit(self, command: list[str], *, process_match: bool = False) -> int:
        audit = self.load_driver(AUDIT, "phase5e_artifact_audit_test")
        with (
            mock.patch.object(
                audit.PHASE4_AUDIT,
                "process_contains_secret",
                return_value=process_match,
            ),
            mock.patch.object(sys, "argv", [str(AUDIT), *command[2:]]),
        ):
            return audit.main()

    @staticmethod
    def load_driver(path: pathlib.Path, name: str):
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise AssertionError(f"could not load {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

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
            "trap cleanup_and_record_transport_exit EXIT",
            "P4HOME_SOURCE_ARCHIVE",
            '--source-archive "$P4HOME_SOURCE_ARCHIVE"',
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

    def test_source_archive_path_is_initialized_inside_checkout_step(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        job_env = workflow.split("    env:", 1)[1].split("    steps:", 1)[0]
        checkout = workflow.split(
            "      - name: Checkout repository archive", 1
        )[1].split("      - name: Validate runner and inputs", 1)[0]
        self.assertNotIn("runner.temp", job_env)
        assignment = 'P4HOME_SOURCE_ARCHIVE="$RUNNER_TEMP/p4home-$GITHUB_SHA.tar.gz"'
        export = 'echo "P4HOME_SOURCE_ARCHIVE=$P4HOME_SOURCE_ARCHIVE" >> "$GITHUB_ENV"'
        self.assertIn(assignment, checkout)
        self.assertIn(export, checkout)
        self.assertLess(checkout.index(assignment), checkout.index(export))
        self.assertLess(checkout.index(export), checkout.index("curl \\"))
        self.assertIn('--output "$P4HOME_SOURCE_ARCHIVE"', checkout)
        self.assertEqual(
            workflow.count('--source-archive "$P4HOME_SOURCE_ARCHIVE"'),
            3,
            "all Phase 5E and product-human audits must scan the pinned source archive",
        )

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

    def test_voice_drivers_retry_wake_without_replaying_prompt(self):
        for index, path in enumerate((DRIVER, UI_DRIVER)):
            with self.subTest(driver=path.name):
                driver = self.load_driver(path, f"phase5e_driver_{index}")
                with (
                    mock.patch.object(driver, "count_marker", return_value=0),
                    mock.patch.object(driver, "say") as say_mock,
                    mock.patch.object(
                        driver,
                        "wait_until",
                        side_effect=[
                            RuntimeError("wake_capture_timeout"),
                            RuntimeError("wake_capture_timeout"),
                            None,
                        ],
                    ),
                    mock.patch.object(driver.time, "sleep"),
                ):
                    driver.open_capture(pathlib.Path("monitor.log"))
                self.assertEqual(
                    say_mock.call_args_list,
                    [mock.call("Hi ESP", "Samantha")] * 3,
                )

                with (
                    mock.patch.object(driver, "open_capture") as open_capture_mock,
                    mock.patch.object(driver, "say") as prompt_mock,
                ):
                    driver.speak_interaction(pathlib.Path("monitor.log"), "prompt")
                open_capture_mock.assert_called_once()
                prompt_mock.assert_called_once_with("prompt", "Tingting")

    def test_voice_drivers_wait_for_terminal_interaction_after_stt_progress(self):
        for index, path in enumerate((DRIVER, UI_DRIVER)):
            with self.subTest(driver=path.name):
                driver = self.load_driver(path, f"phase5e_wait_driver_{index}")
                with (
                    mock.patch.object(
                        driver,
                        "progress_state",
                        side_effect=[(0, 1), (1, 1)],
                    ),
                    mock.patch.object(driver.time, "sleep"),
                ):
                    self.assertTrue(
                        driver.wait_attempt(pathlib.Path("progress.json"), 1, timeout=1)
                    )

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
        self.assertIn("id: flash_capture", flash_step)
        self.assertIn("phase5e_artifact_only=yes", flash_step)
        self.assertIn("evidence_capture=continuing", flash_step)
        self.assertIn("trap record_transport_exit EXIT", flash_step)
        self.assertIn("trap cleanup_and_record_transport_exit EXIT", flash_step)
        self.assertIn("VERIFY:transport:flash_capture:FAIL exit_code=%d", flash_step)
        self.assertIn('> "$TRANSPORT_STATUS_FILE"', flash_step)
        self.assertNotIn("continue-on-error", flash_step)

    def test_phase5e_final_audit_runs_after_manifest_and_before_upload(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        preflight = workflow.index("      - name: Preflight Phase 5E upload candidates")
        manifest = workflow.index("      - name: Write hardware validation manifest")
        final_audit = workflow.index("      - name: Audit final Phase 5E upload candidates")
        assertion = workflow.index("      - name: Assert transport artifact is complete")
        upload = workflow.index("      - name: Upload serial artifact")
        self.assertLess(preflight, manifest)
        self.assertLess(manifest, final_audit)
        self.assertLess(final_audit, assertion)
        self.assertLess(assertion, upload)
        final_block = workflow[final_audit:assertion]
        preflight_block = workflow[preflight:manifest]
        self.assertIn('--repo "$GITHUB_WORKSPACE"', final_block)
        self.assertIn("--artifact firmware/monitor.log", final_block)
        self.assertIn("--artifact firmware/hardware-validation-manifest.json", final_block)
        self.assertIn('--secret-file "$AGENT_TMP_DIR/agent-key.pem"', preflight_block)
        self.assertIn('--secret-file "$AGENT_TMP_DIR/agent-key.pem"', final_block)
        self.assertIn('--artifact-sensitive-file "$PHASE4C_ENTITY_FILE"', final_block)
        self.assertNotIn("tee -a firmware/monitor.log", final_block)
        self.assertIn("id: phase5e_final_audit", final_block)
        upload_block = workflow[upload:]
        self.assertIn("steps.phase5e_final_audit.outcome == 'success'", upload_block)
        self.assertIn("firmware/monitor.log", upload_block)
        self.assertIn("firmware/hardware-validation-manifest.json", upload_block)
        self.assertNotIn("PHASE4C_RAW_MONITOR_LOG", upload_block)
        self.assertNotIn("AGENT_HARNESS_LOG", upload_block)

    def test_workflow_manifest_reports_transport_failure_without_feature_pass(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        manifest_block = workflow.split(
            "      - name: Write hardware validation manifest", 1
        )[1].split("      - name: Audit final Phase 5E upload candidates", 1)[0]
        self.assertIn('"transport_exit_code"', manifest_block)
        self.assertIn('"transport_status"', manifest_block)
        self.assertIn('else "failed" if transport_status_path.is_file()', manifest_block)
        self.assertNotIn('"passed": True', manifest_block)

    def test_artifact_audit_allows_missing_business_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.init_repo(root)
            secret = root / "secret"
            self.write_secret(secret)
            artifact = root / "monitor.log"
            artifact.write_text(
                "VERIFY:phase5e:voice_ui_e2e:FAIL reason=model_unavailable\n",
                encoding="utf-8",
            )
            status = root / "status"
            command = self.audit_command(root, artifact, secret, status)
            self.assertEqual(self.run_audit(command), 0)
            self.assertEqual(status.read_text(encoding="ascii"), "pass\n")

    def test_artifact_audit_scans_gitless_archive_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            secret = root / "secret"
            self.write_secret(secret)
            artifact = root / "monitor.log"
            artifact.write_text("safe metadata\n", encoding="utf-8")
            archive = root / "source.tar.gz"
            self.write_source_archive(archive, b"bounded source metadata")
            status = root / "status"
            command = self.audit_command(
                root, artifact, secret, status, "--source-archive", str(archive),
            )
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(self.run_audit(command), 0)
            self.assertIn("source_mode=archive", output.getvalue())
            self.assertNotIn("git_objects=clean", output.getvalue())

            self.write_source_archive(archive, b"top-secret-token-value")
            self.assertNotEqual(self.run_audit(command), 0)

            self.write_source_archive(archive, b"bounded source metadata")
            (root / ".git").mkdir()
            self.assertNotEqual(
                self.run_audit(command), 0,
                "present but broken Git metadata must not silently fall back to the archive",
            )

            empty_repo = root / "empty-repo"
            empty_repo.mkdir()
            subprocess.run(["git", "init", "-q", str(empty_repo)], check=True)
            empty_command = self.audit_command(
                empty_repo, artifact, secret, status,
                "--source-archive", str(archive),
            )
            self.assertNotEqual(
                self.run_audit(empty_command), 0,
                "an empty Git object database is not auditable source evidence",
            )

    def test_artifact_audit_accepts_metadata_only_and_rejects_secret(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.init_repo(root)
            secret = root / "secret"
            self.write_secret(secret)
            artifact = root / "monitor.log"
            artifact.write_text("VERIFY:phase5e:voice_e2e:PASS\n", encoding="utf-8")
            result = root / "result.json"
            result_payload = {
                "schema_version": 2, "profile": "phase5e_e2e", "passed": True,
                "interactions": [{
                    "kind": kind, "role_id": "robot" if kind in {"read", "write"} else "human",
                    "role_status": "completed",
                    "voice_outcome": "cancelled" if kind == "barge" else "completed",
                    "playback_statuses": [
                        "cancelled" if kind == "barge" else "completed"
                    ],
                    "pcm_bytes": 640,
                    "metrics": phase5e_metrics(
                        "robot" if kind in {"read", "write"} else "human",
                        "audio",
                        "cancelled" if kind == "barge" else "completed",
                    ),
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
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("CREATE TABLE events (id TEXT, payload_json TEXT)")
                connection.execute("INSERT INTO events VALUES ('1', '{}')")
            status = root / "status"
            command = self.audit_command(
                root, artifact, secret, status,
                "--audit-db", str(database), "--result", str(result),
            )
            self.assertEqual(self.run_audit(command), 0)
            result_payload["interactions"][0]["metrics"]["stages"]["stt"]["attempts"] = 0
            result.write_text(json.dumps(result_payload), encoding="utf-8")
            self.assertNotEqual(self.run_audit(command), 0)
            result_payload["interactions"][0]["metrics"]["stages"]["stt"]["attempts"] = 1
            result.write_text(json.dumps(result_payload), encoding="utf-8")
            artifact.write_text("top-secret-token-value", encoding="ascii")
            self.assertNotEqual(self.run_audit(command), 0)
            artifact.write_bytes(b"prefix\x00raw-pcm")
            self.assertNotEqual(self.run_audit(command), 0)
            artifact.write_text('{"rawAudio":"present"}', encoding="utf-8")
            self.assertNotEqual(self.run_audit(command), 0)
            artifact.write_text("A" * 512, encoding="ascii")
            self.assertNotEqual(self.run_audit(command), 0)

    def test_artifact_audit_checks_sqlite_storage_type_not_column_affinity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.init_repo(root)
            secret = root / "secret"
            self.write_secret(secret)
            artifact = root / "monitor.log"
            artifact.write_text("VERIFY:phase5e:voice_ui_e2e:FAIL\n", encoding="utf-8")
            database = root / "audit.db"
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("CREATE TABLE events (payload BLOB, flexible ANY)")
                connection.execute("INSERT INTO events VALUES ('{}', 'safe metadata')")
            status = root / "status"
            command = self.audit_command(
                root, artifact, secret, status, "--audit-db", str(database),
            )
            self.assertEqual(self.run_audit(command), 0)

            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute(
                    "INSERT INTO events VALUES (?, 'safe metadata')",
                    (sqlite3.Binary(b"binary payload"),),
                )
            self.assertNotEqual(self.run_audit(command), 0)

            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("DELETE FROM events WHERE typeof(payload) = 'blob'")
                connection.execute(
                    "INSERT INTO events VALUES ('{}', ?)",
                    ("A" * 512,),
                )
            self.assertNotEqual(self.run_audit(command), 0)

    def test_artifact_audit_ignores_fts_shadow_storage_blobs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.init_repo(root)
            secret = root / "secret"
            self.write_secret(secret)
            artifact = root / "monitor.log"
            artifact.write_text("VERIFY:phase5e:voice_ui_e2e:FAIL\n", encoding="utf-8")
            database = root / "audit.db"
            with closing(sqlite3.connect(database)) as connection, connection:
                try:
                    connection.execute(
                        "CREATE VIRTUAL TABLE searchable USING fts5(content)"
                    )
                except sqlite3.OperationalError as error:
                    self.skipTest(f"SQLite FTS5 is unavailable: {error}")
                connection.execute(
                    "INSERT INTO searchable(content) VALUES ('safe metadata')"
                )
            status = root / "status"
            command = self.audit_command(
                root, artifact, secret, status, "--audit-db", str(database),
            )
            self.assertEqual(self.run_audit(command), 0)
            self.assertEqual(status.read_text(encoding="ascii"), "pass\n")

    def test_artifact_audit_accepts_speakerless_ui_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.init_repo(root)
            secret = root / "secret"
            self.write_secret(secret)
            artifact = root / "monitor.log"
            artifact.write_text("VERIFY:phase5e:voice_ui_e2e:PASS\n", encoding="utf-8")
            result = root / "result.json"
            result.write_text(json.dumps({
                "schema_version": 2, "profile": "phase5e_ui", "passed": True,
                "interaction_kinds": ["read", "write", "chat"],
                "role_ids": ["robot", "robot", "human"],
                "role_statuses": ["completed"] * 3,
                "voice_outcomes": ["completed"] * 3,
                "ui_delivery_statuses": ["completed"] * 3,
                "audio_delivery_statuses": ["deferred"] * 3,
                "interaction_metrics": [{
                    "kind": kind,
                    "metrics": phase5e_metrics(role_id, "speakerless_ui"),
                } for kind, role_id in (
                    ("read", "robot"), ("write", "robot"), ("chat", "human"),
                )],
                "stt_provider_version": "1", "stt_model_revision": "a" * 40,
                "stt_calls": 3, "stt_transcript_mismatches": 0, "stt_total_ms": 1,
                "real_model_calls": 7, "audit_events": 6, "restored": True,
                "read_passed": True, "write_passed": True, "chat_passed": True,
                "ui_deliveries_completed": 3, "audio_delivery_deferred": True,
                "composition_audits_persisted": 3, "raw_audio_retained": False,
            }), encoding="utf-8")
            database = root / "audit.db"
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("CREATE TABLE events (id TEXT, payload_json TEXT)")
                connection.execute("INSERT INTO events VALUES ('1', '{}')")
            status = root / "status"
            command = self.audit_command(
                root, artifact, secret, status,
                "--audit-db", str(database), "--result", str(result),
            )
            self.assertEqual(self.run_audit(command), 0)
            payload = json.loads(result.read_text(encoding="utf-8"))
            payload["interaction_metrics"][0]["metrics"]["stages"]["p4_wake"][
                "duration_ms"
            ] = 0
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(self.run_audit(command), 0)
            payload["interaction_metrics"][0]["metrics"]["stages"]["p4_wake"][
                "duration_ms"
            ] = None
            payload["ui_delivery_statuses"][1] = "failed"
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(self.run_audit(command), 0)
            payload["ui_delivery_statuses"][1] = "completed"
            payload["unexpected"] = "field"
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(self.run_audit(command), 0)

    def test_artifact_audit_rejects_loose_and_symlinked_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.init_repo(root)
            artifact = root / "monitor.log"
            artifact.write_text("safe metadata\n", encoding="utf-8")
            secret = root / "secret"
            self.write_secret(secret)
            status = root / "status"
            command = self.audit_command(root, artifact, secret, status)
            self.assertEqual(self.run_audit(command), 0)

            secret.chmod(0o400)
            self.assertEqual(self.run_audit(command), 0)
            secret.chmod(0o644)
            self.assertNotEqual(self.run_audit(command), 0)
            self.assertEqual(status.read_text(encoding="ascii"), "fail\n")

            secret.chmod(0o600)
            link = root / "secret-link"
            link.symlink_to(secret)
            link_command = self.audit_command(root, artifact, link, status)
            self.assertNotEqual(self.run_audit(link_command), 0)
            self.assertEqual(status.read_text(encoding="ascii"), "fail\n")

            artifact_link = root / "artifact-link"
            artifact_link.symlink_to(artifact)
            artifact_command = self.audit_command(root, artifact_link, secret, status)
            self.assertNotEqual(self.run_audit(artifact_command), 0)
            self.assertEqual(status.read_text(encoding="ascii"), "fail\n")

    def test_artifact_audit_reuses_git_object_and_process_argv_scans(self):
        audit_source = AUDIT.read_text(encoding="utf-8")
        self.assertIn("PHASE4_AUDIT.scan_git_objects", audit_source)
        self.assertIn("PHASE4_AUDIT.process_contains_secret", audit_source)
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.init_repo(root)
            artifact = root / "monitor.log"
            artifact.write_text("safe metadata\n", encoding="utf-8")
            secret = root / "secret"
            canary = "synthetic-phase5e-secret-canary"
            self.write_secret(secret, canary)
            status = root / "status"
            command = self.audit_command(root, artifact, secret, status)
            self.assertEqual(self.run_audit(command), 0)

            subprocess.run(
                ["git", "hash-object", "-w", "--stdin"], cwd=root,
                input=canary.encode("ascii"), check=True, stdout=subprocess.DEVNULL,
            )
            self.assertNotEqual(self.run_audit(command), 0)

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.init_repo(root)
            artifact = root / "monitor.log"
            artifact.write_text("safe metadata\n", encoding="utf-8")
            secret = root / "secret"
            canary = "synthetic-phase5e-process-canary"
            self.write_secret(secret, canary)
            status = root / "status"
            command = self.audit_command(root, artifact, secret, status)
            self.assertNotEqual(self.run_audit(command, process_match=True), 0)

    def test_artifact_only_sensitive_value_can_exist_in_git_but_not_uploads(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.init_repo(root)
            artifact = root / "monitor.log"
            artifact.write_text("safe metadata\n", encoding="utf-8")
            credential = root / "credential"
            self.write_secret(credential, "synthetic-phase5e-credential")
            entity = root / "entity"
            entity_canary = "switch.synthetic_tracked_entity"
            self.write_secret(entity, entity_canary)
            subprocess.run(
                ["git", "hash-object", "-w", "--stdin"], cwd=root,
                input=entity_canary.encode("ascii"), check=True,
                stdout=subprocess.DEVNULL,
            )
            status = root / "status"
            command = self.audit_command(
                root, artifact, credential, status,
                "--artifact-sensitive-file", str(entity),
            )
            self.assertEqual(self.run_audit(command), 0)
            artifact.write_text(entity_canary, encoding="ascii")
            self.assertNotEqual(self.run_audit(command), 0)


if __name__ == "__main__":
    unittest.main()
