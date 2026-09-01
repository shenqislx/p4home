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


def model_call_timing(seed: int) -> dict:
    return {
        "schema_version": 1,
        "status": "completed",
        "request_duration_ms": 10 + seed,
        "ollama": {
            "total_duration_ns": 1_000_000 + seed,
            "load_duration_ns": 100_000 + seed,
            "prompt_eval_count": 20 + seed,
            "prompt_eval_duration_ns": 200_000 + seed,
            "eval_count": 5 + seed,
            "eval_duration_ns": 300_000 + seed,
        },
    }


def model_timing_summary(calls: list[dict]) -> dict:
    usage_keys = (
        "total_duration_ns", "load_duration_ns", "prompt_eval_count",
        "prompt_eval_duration_ns", "eval_count", "eval_duration_ns",
    )
    complete = sum(
        all(call["ollama"][key] is not None for key in usage_keys)
        for call in calls
    )
    return {
        "schema_version": 1,
        "calls": len(calls),
        "completed_calls": sum(call["status"] == "completed" for call in calls),
        "failed_calls": sum(call["status"] == "failed" for call in calls),
        "cancelled_calls": sum(call["status"] == "cancelled" for call in calls),
        "timed_out_calls": sum(call["status"] == "timed_out" for call in calls),
        "usage_complete_calls": complete,
        "usage_missing_calls": len(calls) - complete,
        "request_total_ms": sum(call["request_duration_ms"] for call in calls),
        "ollama_totals": {
            key: sum(call["ollama"][key] or 0 for call in calls)
            for key in usage_keys
        },
        "call_details": calls,
        "content_retained": False,
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
            'requiredEnvironment(\n    "P4HOME_PHASE5E_AUDIO_STATUS_FILE",',
            harness,
        )
        self.assertIn('throw new Error("voice_e2e_audio_driver_failed")', harness)
        self.assertIn("你好，请继续介绍一下你自己", harness)
        failure_mapping = harness.split(
            "function boundedSttFailureCode", 1
        )[1].split("async function atomicJson", 1)[0]
        self.assertIn("HARNESS:phase5e:stt_attempt_failed", harness)
        self.assertIn("expected=${expectedKind}", harness)
        self.assertIn("const failureCode = boundedSttFailureCode(error)", harness)
        self.assertIn("code=${failureCode}", harness)
        self.assertIn("settledProgressSnapshot(runtime).completed_interactions", harness)
        self.assertNotIn("acceptedTranscripts", harness)
        self.assertNotIn(".message", failure_mapping)
        self.assertNotIn("String(error)", failure_mapping)
        e2e_harness = workflow.split(
            'if [[ "$VALIDATION_PROFILE" == "phase5e_e2e" ]]', 1
        )[1].split("HARNESS_ENTRYPOINT=apps/device-harness/src/voice-e2e-cli.ts", 1)[0]
        self.assertIn("export P4HOME_PHASE5E_AUDIO_STATUS_FILE", e2e_harness)
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
        self.assertIn("HA_INITIAL_SYNC_READY_MARKER", driver)
        self.assertIn("wait_for_ha_readiness(args.monitor_log)", driver)
        self.assertNotIn("time.sleep(25)", driver)
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
            'requiredEnvironment("P4HOME_PHASE5E_UI_INPUT_STATUS_FILE")',
            'throw new Error("voice_ui_input_driver_failed")',
        ):
            self.assertIn(marker, harness)
        phase5e_ui_harness = workflow.split(
            'elif [[ "$VALIDATION_PROFILE" == "phase5e_ui" ]]', 1
        )[1].split("HARNESS_ENTRYPOINT=apps/device-harness/src/voice-ui-e2e-cli.ts", 1)[0]
        self.assertIn("export P4HOME_PHASE5E_UI_INPUT_STATUS_FILE", phase5e_ui_harness)
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

    def test_ui_driver_waits_for_exact_ha_readiness_before_three_rounds(self):
        driver = self.load_driver(UI_DRIVER, "phase5e_ui_readiness_driver")
        ha_client = (
            ROOT / "firmware/components/ha_client/ha_client.c"
        ).read_text(encoding="utf-8")
        marker = 'ESP_LOGW(TAG, "VERIFY:ha:initial_sync_ready:PASS")'
        self.assertIn(marker, ha_client)
        self.assertIn(
            "snapshot_succeeded && current_connection_ready && ha_client_initial_sync_ready()",
            ha_client,
        )
        for condition in (
            "!s_ctx.stop_requested",
            "s_ctx.ws_connected",
            "s_ctx.authenticated",
            "s_ctx.subscription_ready",
            "s_ctx.state == HA_CLIENT_STATE_READY",
        ):
            self.assertIn(condition, ha_client)
        self.assertIn("ha_client_mark_initial_sync_done(false);", ha_client)
        self.assertIn(
            "ha_client_mark_initial_sync_done(count > 0U && ok_count == (uint32_t)count);",
            ha_client,
        )

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            prompt_file = root / "prompts.json"
            progress_file = root / "progress.json"
            monitor_log = root / "monitor.log"
            status_file = root / "status"
            prompts = {
                "read": "private read",
                "write": "private write",
                "barge": "private barge",
                "followup": "private followup",
            }
            prompt_file.write_text(
                json.dumps({"schema_version": 1, "prompts": prompts}),
                encoding="utf-8",
            )
            events: list[str] = []

            def readiness(_monitor: pathlib.Path) -> None:
                events.append("ready")

            def repeatable(
                _monitor: pathlib.Path,
                _progress: pathlib.Path,
                prompt: str,
                target: int,
            ) -> None:
                events.append(f"round:{target}:{prompt}")

            def write_once(_monitor: pathlib.Path, prompt: str) -> None:
                events.append(f"round:2:{prompt}")

            argv = [
                str(UI_DRIVER),
                "--prompt-file", str(prompt_file),
                "--progress-file", str(progress_file),
                "--monitor-log", str(monitor_log),
                "--status-file", str(status_file),
            ]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(driver, "wait_for_ha_readiness", side_effect=readiness),
                mock.patch.object(driver, "speak_until_progress", side_effect=repeatable),
                mock.patch.object(driver, "speak_interaction", side_effect=write_once),
                mock.patch.object(driver, "progress_state", return_value=(1, 1)),
                mock.patch.object(driver, "wait_attempt", return_value=driver.ATTEMPT_COMPLETED),
            ):
                self.assertEqual(driver.main(), 0)

            self.assertEqual(
                events,
                [
                    "ready",
                    "round:1:private read",
                    "round:2:private write",
                    "round:3:private barge",
                ],
            )
            self.assertEqual(status_file.read_text(encoding="ascii"), "0\n")

    def test_ha_initial_snapshot_success_is_strict_and_fail_closed(self):
        ha_client = (
            ROOT / "firmware/components/ha_client/ha_client.c"
        ).read_text(encoding="utf-8")
        fetch = ha_client.split(
            "static esp_err_t ha_client_fetch_one_initial_state", 1
        )[1].split("static void ha_client_fetch_initial_states", 1)[0]
        fetch_all = ha_client.split(
            "static void ha_client_fetch_initial_states", 1
        )[1].split("static esp_err_t ha_client_start_socket", 1)[0]
        get_states = ha_client.split(
            "if (pending_type == HA_PENDING_GET_STATES)", 1
        )[1].split("if (pending_type == HA_PENDING_CALL_SERVICE)", 1)[0]

        self.assertIn("if (err == ESP_OK && total <= 0)", fetch)
        self.assertIn("cJSON_ParseWithLengthOpts", fetch)
        self.assertIn("cJSON_IsObject(root)", fetch)
        self.assertIn("cJSON_IsString(response_entity_id)", fetch)
        self.assertIn("strcmp(response_entity_id->valuestring, entity_id) == 0", fetch)
        self.assertIn("cJSON_IsString(response_state)", fetch)
        self.assertIn("response_state->valuestring[0] != '\\0'", fetch)
        self.assertIn("if (response_valid)", fetch)
        self.assertIn("err = ESP_FAIL", fetch)
        self.assertLess(fetch.index("if (response_valid)"), fetch.index(
            "ha_client_dispatch_state_change_from_result(root)"
        ))

        self.assertIn("ha_client_mark_initial_sync_done(false);", fetch_all)
        self.assertIn("count > 0U && ok_count == (uint32_t)count", fetch_all)
        self.assertIn("ha_client_mark_initial_sync_done(false);", get_states)
        self.assertNotIn("ha_client_mark_initial_sync_done(true);", get_states)

    def test_phase5e_voice_memory_and_ha_auth_hardening_contract(self):
        voice = (
            ROOT / "firmware/components/voice_transport/voice_transport.c"
        ).read_text(encoding="utf-8")
        playback = (
            ROOT / "firmware/components/voice_transport/voice_playback_receiver.c"
        ).read_text(encoding="utf-8")
        ha_client = (
            ROOT / "firmware/components/ha_client/ha_client.c"
        ).read_text(encoding="utf-8")

        for source, queue in ((voice, "s_voice.frame_queue"),
                              (playback, "s_playback.queue")):
            self.assertIn(f"{queue} = xQueueCreateWithCaps(", source)
            self.assertIn("MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT", source)
            self.assertIn(f"vQueueDeleteWithCaps({queue})", source)
            self.assertNotIn(f"vQueueDelete({queue})", source)

        auth = ha_client.split(
            'if (strcmp(type->valuestring, "auth_required") == 0)', 1
        )[1].split('} else if (strcmp(type->valuestring, "auth_ok") == 0)', 1)[0]
        failed, succeeded = auth.split("} else {", 1)
        self.assertIn("if (sent != (int)auth_len)", failed)
        self.assertIn('"auth_send_failed", "auth_send_failed"', failed)
        self.assertNotIn("HA_CLIENT_STATE_AUTHENTICATING", failed)
        self.assertIn("HA_CLIENT_STATE_AUTHENTICATING", succeeded)
        self.assertNotIn("portMAX_DELAY", auth)
        self.assertIn("pdMS_TO_TICKS(HA_CLIENT_AUTH_SEND_TIMEOUT_MS)", auth)
        self.assertIn("mbedtls_platform_zeroize(auth_json, sizeof(auth_json))", auth)
        self.assertIn("mbedtls_platform_zeroize(token, sizeof(token))", auth)
        self.assertIn("auth_token_unavailable", auth)

        auth_ok = ha_client.split(
            '} else if (strcmp(type->valuestring, "auth_ok") == 0)', 1
        )[1].split('} else if (strcmp(type->valuestring, "auth_invalid") == 0)', 1)[0]
        self.assertIn("source_client == s_ctx.ws", auth_ok)
        self.assertIn("s_ctx.auth_sent", auth_ok)
        self.assertIn("s_ctx.state == HA_CLIENT_STATE_AUTHENTICATING", auth_ok)
        self.assertIn("HA_CLIENT_HANDSHAKE_FAILED_BIT) == 0U", auth_ok)
        self.assertIn("if (accept_auth_ok)", auth_ok)

        worker = ha_client.split(
            "static void ha_client_worker", 1
        )[1].split("static esp_err_t ha_client_delete_worker_task", 1)[0]
        self.assertLess(
            worker.index("if ((bits & HA_CLIENT_FAILURE_BITS) != 0U)"),
            worker.index("else if ((bits & HA_CLIENT_READY_BIT) != 0U)"),
        )
        failure_mask = ha_client.split(
            "#define HA_CLIENT_FAILURE_BITS", 1
        )[1].split("#define HA_CLIENT_MAX_INITIAL_ENTITIES", 1)[0]
        for failure_bit in ("HA_CLIENT_AUTH_FAIL_BIT", "HA_CLIENT_FATAL_ERROR_BIT",
                            "HA_CLIENT_HANDSHAKE_FAILED_BIT"):
            self.assertIn(failure_bit, failure_mask)

        wait_ready = ha_client.split(
            "esp_err_t ha_client_wait_ready", 1
        )[1].split("bool ha_client_ready", 1)[0]
        self.assertLess(
            wait_ready.index("if ((bits & HA_CLIENT_FAILURE_BITS) != 0U)"),
            wait_ready.index("if ((bits & HA_CLIENT_READY_BIT) != 0U)"),
        )
        self.assertIn("HA_CLIENT_READY_BIT | HA_CLIENT_FAILURE_BITS", wait_ready)

        stop = playback.split(
            "esp_err_t voice_playback_receiver_stop", 1
        )[1].split("bool voice_playback_receiver_matches", 1)[0]
        deinit = playback.split(
            "esp_err_t voice_playback_receiver_deinit", 1
        )[1].split("esp_err_t voice_playback_receiver_start", 1)[0]
        self.assertNotIn("if (!s_playback.running) return ESP_OK;", stop)
        self.assertIn("if (s_playback.task == NULL) return ESP_OK;", stop)
        self.assertIn("s_playback.task != NULL", deinit)
        self.assertIn("s_playback.state != PLAYBACK_IDLE", deinit)
        self.assertIn("internal_free=%u internal_largest=%u internal_min=%u", ha_client)
        self.assertIn("error type=%d errno=%d handshake_status=%d", ha_client)

    def test_phase5e_drivers_require_device_readiness_marker_with_bounded_wait(self):
        for index, path in enumerate((DRIVER, UI_DRIVER)):
            with self.subTest(driver=path.name):
                source = path.read_text(encoding="utf-8")
                self.assertNotIn("time.sleep(25)", source)
                driver = self.load_driver(path, f"phase5e_readiness_marker_{index}")
                with tempfile.TemporaryDirectory() as temporary:
                    monitor = pathlib.Path(temporary) / "monitor.log"
                    monitor.write_text(
                        "VERIFY:ha:initial_sync_ready:FAIL\n",
                        encoding="utf-8",
                    )
                    with mock.patch.object(driver, "wait_until") as wait_mock:
                        driver.wait_for_ha_readiness(monitor)
                    predicate, timeout, reason = wait_mock.call_args.args
                    self.assertFalse(predicate())
                    monitor.write_text(
                        "VERIFY:ha:initial_sync_ready:PASS\n",
                        encoding="utf-8",
                    )
                    self.assertTrue(predicate())
                    self.assertEqual(timeout, 300)
                    self.assertEqual(reason, "ha_initial_sync_readiness_timeout")

    def test_phase5e_driver_readiness_timeout_fails_before_voice_injection(self):
        for index, path in enumerate((DRIVER, UI_DRIVER)):
            with self.subTest(driver=path.name):
                driver = self.load_driver(path, f"phase5e_readiness_timeout_driver_{index}")
                with tempfile.TemporaryDirectory() as temporary:
                    root = pathlib.Path(temporary)
                    prompt_file = root / "prompts.json"
                    status_file = root / "status"
                    prompt_file.write_text(
                        json.dumps({
                            "schema_version": 1,
                            "prompts": {
                                "read": "private read",
                                "write": "private write",
                                "barge": "private barge",
                                "followup": "private followup",
                            },
                        }),
                        encoding="utf-8",
                    )
                    argv = [
                        str(path),
                        "--prompt-file", str(prompt_file),
                        "--progress-file", str(root / "progress.json"),
                        "--monitor-log", str(root / "monitor.log"),
                        "--status-file", str(status_file),
                    ]
                    with (
                        mock.patch.object(sys, "argv", argv),
                        mock.patch.object(
                            driver,
                            "wait_for_ha_readiness",
                            side_effect=RuntimeError("ha_initial_sync_readiness_timeout"),
                        ),
                        mock.patch.object(driver, "open_capture") as capture_mock,
                        mock.patch.object(driver, "say") as say_mock,
                        redirect_stdout(io.StringIO()),
                    ):
                        self.assertEqual(driver.main(), 1)

                    capture_mock.assert_not_called()
                    say_mock.assert_not_called()
                    self.assertEqual(status_file.read_text(encoding="ascii"), "1\n")

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
                    outcome = driver.wait_attempt(pathlib.Path("progress.json"), 1, timeout=1)
                    self.assertEqual(outcome, driver.ATTEMPT_COMPLETED)

    def test_voice_e2e_progress_requires_settled_pipeline_and_driver_success(self):
        source = (
            ROOT / "agent/apps/device-harness/src/voice-e2e-cli.ts"
        ).read_text(encoding="utf-8")
        snapshot = source.split(
            "function settledProgressSnapshot", 1
        )[1].split("async function waitForResults", 1)[0]
        wait = source.split("async function waitForResults", 1)[1].split(
            "async function main", 1
        )[0]

        self.assertIn("const pipelineResults = runtime.pipeline.results", snapshot)
        self.assertIn('result.outcome === "dispatched"', snapshot)
        self.assertIn("capture_attempts: pipelineResults.length", snapshot)
        self.assertNotIn("runtime.coordinator.results", snapshot)
        self.assertIn("const snapshot = settledProgressSnapshot(runtime)", wait)
        publish = "await atomicJson(progressFile, snapshot)"
        status_read = 'await readFile(audioDriverStatusFile, "ascii")'
        terminal = (
            "if (snapshot.completed_interactions >= 4 && audioDriverComplete) break"
        )
        self.assertIn("let audioDriverComplete = false", wait)
        self.assertIn("audioDriverComplete = true", wait)
        self.assertIn(terminal, wait)
        self.assertLess(wait.index(publish), wait.index(status_read))
        self.assertLess(wait.index(status_read), wait.index(terminal))
        self.assertNotIn("if (snapshot.completed_interactions >= 4) break", wait)
        self.assertIn('audioStatus === "1"', wait)
        self.assertIn('audioStatus !== "0"', wait)
        self.assertIn('error.code === "ENOENT"', wait)
        self.assertNotIn("runtime.coordinator.results.length", wait)

    def test_voice_ui_progress_requires_settled_pipeline_and_driver_success(self):
        source = (
            ROOT / "agent/apps/device-harness/src/voice-ui-e2e-cli.ts"
        ).read_text(encoding="utf-8")
        snapshot = source.split(
            "function settledProgressSnapshot", 1
        )[1].split("async function waitForResults", 1)[0]
        wait = source.split("async function waitForResults", 1)[1].split(
            "async function main", 1
        )[0]

        self.assertIn("const pipelineResults = runtime.pipeline.results", snapshot)
        self.assertIn('result.outcome === "dispatched"', snapshot)
        self.assertIn("capture_attempts: pipelineResults.length", snapshot)
        self.assertNotIn("runtime.coordinator.results", snapshot)
        self.assertIn("const snapshot = settledProgressSnapshot(runtime)", wait)
        publish = "await atomicJson(progressFile, snapshot)"
        status_read = 'await readFile(inputDriverStatusFile, "ascii")'
        terminal = (
            "if (snapshot.completed_interactions >= 3 && inputDriverComplete) break"
        )
        self.assertIn("let inputDriverComplete = false", wait)
        self.assertIn("inputDriverComplete = true", wait)
        self.assertIn(terminal, wait)
        self.assertLess(wait.index(publish), wait.index(status_read))
        self.assertLess(wait.index(status_read), wait.index(terminal))
        self.assertNotIn("if (snapshot.completed_interactions >= 3) break", wait)
        self.assertIn('inputStatus === "1"', wait)
        self.assertIn('inputStatus !== "0"', wait)
        self.assertIn('error.code === "ENOENT"', wait)
        self.assertNotIn("runtime.coordinator.results.length", wait)

    def test_voice_drivers_stop_waiting_on_terminal_failed_attempt(self):
        for index, path in enumerate((DRIVER, UI_DRIVER)):
            with self.subTest(driver=path.name):
                driver = self.load_driver(path, f"phase5e_terminal_attempt_driver_{index}")
                with mock.patch.object(driver, "progress_state", return_value=(1, 3)):
                    self.assertEqual(
                        driver.wait_attempt(
                            pathlib.Path("progress.json"),
                            2,
                            attempts_before=2,
                            timeout=420,
                        ),
                        driver.ATTEMPT_TERMINAL_FAILED,
                    )

    def test_voice_drivers_never_replay_an_unsettled_timeout(self):
        for index, path in enumerate((DRIVER, UI_DRIVER)):
            with self.subTest(driver=path.name):
                driver = self.load_driver(path, f"phase5e_unsettled_timeout_driver_{index}")
                with (
                    mock.patch.object(driver, "progress_state", return_value=(0, 0)),
                    mock.patch.object(driver, "speak_interaction") as speak_mock,
                    mock.patch.object(
                        driver, "wait_attempt", return_value=driver.ATTEMPT_TIMED_OUT
                    ),
                ):
                    with self.assertRaisesRegex(
                        RuntimeError, "interaction_attempt_timeout_no_replay"
                    ):
                        driver.speak_until_progress(
                            pathlib.Path("monitor.log"),
                            pathlib.Path("progress.json"),
                            "private",
                            1,
                        )
                speak_mock.assert_called_once()

    def test_voice_e2e_progress_parser_rejects_non_integer_or_inconsistent_state(self):
        driver = self.load_driver(DRIVER, "phase5e_strict_progress_driver")
        invalid_states = (
            {"schema_version": True, "completed_interactions": 0, "capture_attempts": 0},
            {"schema_version": 1, "completed_interactions": True, "capture_attempts": 1},
            {"schema_version": 1, "completed_interactions": 2, "capture_attempts": 1},
            {"schema_version": 2, "completed_interactions": 0, "capture_attempts": 0},
        )
        with tempfile.TemporaryDirectory() as raw_root:
            path = pathlib.Path(raw_root) / "progress.json"
            for state in invalid_states:
                with self.subTest(state=state):
                    path.write_text(json.dumps(state), encoding="utf-8")
                    self.assertEqual(driver.progress_state(path), (-1, -1))
            path.write_text(json.dumps({
                "schema_version": 1,
                "completed_interactions": 2,
                "capture_attempts": 3,
            }), encoding="utf-8")
            self.assertEqual(driver.progress_state(path), (2, 3))

    def test_voice_e2e_status_publish_is_atomic_and_bounded(self):
        driver = self.load_driver(DRIVER, "phase5e_atomic_status_driver")
        with tempfile.TemporaryDirectory() as raw_root:
            path = pathlib.Path(raw_root) / "audio-driver-status"
            driver.write_status(path, 0)
            self.assertEqual(path.read_text(encoding="ascii"), "0\n")
            self.assertFalse(path.with_name(f"{path.name}.tmp").exists())
            with self.assertRaisesRegex(ValueError, "invalid_status"):
                driver.write_status(path, 2)

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
            with artifact.open("a", encoding="utf-8") as handle:
                handle.write('{"raw_audio":"present"}\n')
            self.assertNotEqual(self.run_audit(command), 0)

    def test_preflight_pass_marker_does_not_poison_final_artifact_audit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.init_repo(root)
            secret = root / "secret"
            self.write_secret(secret)
            artifact = root / "monitor.log"
            artifact.write_text("safe metadata\n", encoding="utf-8")
            status = root / "status"
            command = self.audit_command(root, artifact, secret, status)

            preflight_output = io.StringIO()
            with redirect_stdout(preflight_output):
                self.assertEqual(self.run_audit(command), 0)
            marker = preflight_output.getvalue()
            self.assertIn("VERIFY:phase5e:artifact_audit:PASS", marker)
            self.assertIn("audio_payload=absent", marker)
            auditor = self.load_driver(AUDIT, "phase5e_marker_regex_test")
            self.assertIsNone(auditor.RAW_FIELD.search(marker.encode("utf-8")))
            with artifact.open("a", encoding="utf-8") as handle:
                handle.write(marker)

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
                "stt_rejections_by_expected_kind": {
                    "read": 0, "write": 0, "barge": 0, "followup": 0,
                    "unexpected": 0,
                },
                "stt_non_mismatch_failures_by_expected_kind": {
                    kind: {
                        "cancelled": 0, "invalid_response": 0,
                        "model_unavailable": 0, "process_error": 0,
                        "timeout": 0, "unknown": 0,
                    }
                    for kind in ("read", "write", "barge", "followup", "unexpected")
                },
                "capture_attempts": 4,
                "capture_failures_by_expected_kind": {
                    kind: {
                        "cancelled": 0, "dispatch_failed": 0,
                        "empty_transcript": 0, "provider_error": 0,
                        "silence": 0, "stale": 0, "timed_out": 0,
                        "too_long": 0, "too_short": 0,
                    }
                    for kind in ("read", "write", "barge", "followup", "unexpected")
                },
                "stt_accepted_capture_failures_by_expected_kind": {
                    kind: {
                        "cancelled": 0, "dispatch_failed": 0,
                        "empty_transcript": 0, "provider_error": 0,
                        "silence": 0, "stale": 0, "timed_out": 0,
                        "too_long": 0, "too_short": 0,
                    }
                    for kind in ("read", "write", "barge", "followup", "unexpected")
                },
                "stt_failed_capture_failures_by_expected_kind": {
                    kind: {
                        "cancelled": 0, "dispatch_failed": 0,
                        "empty_transcript": 0, "provider_error": 0,
                        "silence": 0, "stale": 0, "timed_out": 0,
                        "too_long": 0, "too_short": 0,
                    }
                    for kind in ("read", "write", "barge", "followup", "unexpected")
                },
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
            baseline_payload = json.loads(json.dumps(result_payload))

            # Mirrors the bounded shape observed on real hardware: four
            # successful interactions, four classified STT failures, and one
            # additional pre-STT cancelled capture.
            result_payload["stt_calls"] = 8
            result_payload["stt_transcript_mismatches"] = 2
            result_payload["stt_rejections_by_expected_kind"]["followup"] = 2
            result_payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                "cancelled"
            ] = 2
            result_payload["capture_attempts"] = 9
            result_payload["capture_failures_by_expected_kind"]["read"][
                "stale"
            ] = 2
            result_payload["capture_failures_by_expected_kind"]["barge"][
                "cancelled"
            ] = 1
            result_payload["capture_failures_by_expected_kind"]["followup"][
                "provider_error"
            ] = 2
            result_payload[
                "stt_failed_capture_failures_by_expected_kind"
            ]["read"]["stale"] = 2
            result_payload[
                "stt_failed_capture_failures_by_expected_kind"
            ]["followup"]["provider_error"] = 2
            result.write_text(json.dumps(result_payload), encoding="utf-8")
            self.assertEqual(
                self.run_audit(command), 0,
                "bounded classified retries must conserve STT and capture attempts",
            )

            dispatch_retry_payload = json.loads(json.dumps(baseline_payload))
            dispatch_retry_payload["stt_calls"] = 5
            dispatch_retry_payload["capture_attempts"] = 5
            dispatch_retry_payload["capture_failures_by_expected_kind"]["read"][
                "dispatch_failed"
            ] = 1
            dispatch_retry_payload[
                "stt_accepted_capture_failures_by_expected_kind"
            ]["read"]["dispatch_failed"] = 1
            result.write_text(json.dumps(dispatch_retry_payload), encoding="utf-8")
            self.assertEqual(
                self.run_audit(command), 0,
                "a bounded safe dispatch retry must conserve its successful STT call",
            )

            stale_dispatch_payload = json.loads(json.dumps(baseline_payload))
            stale_dispatch_payload["stt_calls"] = 5
            stale_dispatch_payload["capture_attempts"] = 5
            stale_dispatch_payload["capture_failures_by_expected_kind"]["read"][
                "stale"
            ] = 1
            stale_dispatch_payload[
                "stt_accepted_capture_failures_by_expected_kind"
            ]["read"]["stale"] = 1
            result.write_text(json.dumps(stale_dispatch_payload), encoding="utf-8")
            self.assertEqual(
                self.run_audit(command), 0,
                "a newer capture may stale an accepted STT dispatch before terminalization",
            )

            invalid_payload = json.loads(json.dumps(result_payload))
            invalid_payload["stt_calls"] = 9
            result.write_text(json.dumps(invalid_payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "an unexplained STT call must fail closed",
            )
            invalid_payload = json.loads(json.dumps(result_payload))
            invalid_payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                "unknown"
            ] = 1
            invalid_payload["stt_calls"] = 9
            result.write_text(json.dumps(invalid_payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "unclassified STT failures must not explain retries",
            )
            invalid_payload = json.loads(json.dumps(result_payload))
            invalid_payload["capture_attempts"] = 10
            result.write_text(json.dumps(invalid_payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "every extra capture must have a classified terminal",
            )
            invalid_payload = json.loads(json.dumps(baseline_payload))
            invalid_payload["capture_attempts"] = 5
            invalid_payload["capture_failures_by_expected_kind"]["read"][
                "provider_error"
            ] = 1
            result.write_text(json.dumps(invalid_payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "an unexplained provider terminal must not forge a retry",
            )
            invalid_payload = json.loads(json.dumps(dispatch_retry_payload))
            invalid_payload[
                "stt_accepted_capture_failures_by_expected_kind"
            ]["read"]["dispatch_failed"] = 0
            invalid_payload["stt_calls"] = 4
            result.write_text(json.dumps(invalid_payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "a successful STT dispatch failure must be identity-accounted",
            )
            invalid_payload = json.loads(json.dumps(baseline_payload))
            invalid_payload["stt_calls"] = 5
            invalid_payload["capture_attempts"] = 5
            invalid_payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                "process_error"
            ] = 1
            invalid_payload["capture_failures_by_expected_kind"]["read"][
                "silence"
            ] = 1
            result.write_text(json.dumps(invalid_payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "a pre-STT capture terminal cannot explain a provider failure",
            )
            invalid_payload = json.loads(json.dumps(baseline_payload))
            invalid_payload["capture_attempts"] = 8
            invalid_payload["capture_failures_by_expected_kind"]["followup"][
                "silence"
            ] = 4
            result.write_text(json.dumps(invalid_payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "follow-up capture failures beyond the driver budget must fail closed",
            )
            invalid_payload = json.loads(json.dumps(baseline_payload))
            invalid_payload["capture_attempts"] = 5
            invalid_payload["capture_failures_by_expected_kind"]["write"][
                "silence"
            ] = 1
            result.write_text(json.dumps(invalid_payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "write capture failures imply a forbidden write replay",
            )

            result_payload = baseline_payload
            result.write_text(json.dumps(result_payload), encoding="utf-8")
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
            model_calls = [model_call_timing(index) for index in range(7)]
            interaction_model_timings = [
                model_timing_summary(model_calls[:1]),
                model_timing_summary(model_calls[1:4]),
                model_timing_summary(model_calls[4:]),
            ]
            result.write_text(json.dumps({
                "schema_version": 3, "profile": "phase5e_ui", "passed": True,
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
                "stt_rejections_by_expected_kind": {
                    "read": 0, "write": 0, "chat": 0, "unexpected": 0,
                },
                "stt_non_mismatch_failures_by_expected_kind": {
                    kind: {
                        "cancelled": 0, "invalid_response": 0,
                        "model_unavailable": 0, "process_error": 0,
                        "timeout": 0, "unknown": 0,
                    }
                    for kind in ("read", "write", "chat", "unexpected")
                },
                "real_model_calls": 7,
                "model_timing": {
                    "schema_version": 1,
                    "interactions": [{
                        "kind": kind,
                        "timing": interaction_model_timings[index],
                    } for index, kind in enumerate(("read", "write", "chat"))],
                    "totals": model_timing_summary(model_calls),
                    "content_retained": False,
                },
                "audit_events": 6, "restored": True,
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
            valid_payload = json.loads(json.dumps(payload))
            payload["model_timing"]["interactions"][0]["timing"][
                "call_details"
            ][0]["ollama"]["load_duration_ns"] = None
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "successful real-model artifacts require complete Ollama usage",
            )
            payload = json.loads(json.dumps(valid_payload))
            payload["model_timing"]["interactions"][0]["timing"]["calls"] = True
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "booleans cannot forge integer timing counters",
            )
            payload = json.loads(json.dumps(valid_payload))
            payload["model_timing"]["interactions"][0]["timing"][
                "call_details"
            ][0]["schema_version"] = True
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "booleans cannot forge nested schema versions",
            )
            payload = json.loads(json.dumps(valid_payload))
            payload["model_timing"]["interactions"][0]["timing"][
                "call_details"
            ][0]["transcript"] = "private forged transcript"
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "call details use an exact body-free schema",
            )
            payload = json.loads(json.dumps(valid_payload))
            payload["model_timing"]["interactions"][0]["timing"][
                "call_details"
            ][0]["request_duration_ms"] = float("nan")
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "NaN timing values fail closed",
            )
            payload = json.loads(json.dumps(valid_payload))
            payload["model_timing"]["interactions"][0]["timing"][
                "call_details"
            ][0]["ollama"]["total_duration_ns"] = 600_000_000_001
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "out-of-range Ollama counters fail closed",
            )
            payload = json.loads(json.dumps(valid_payload))
            payload["model_timing"]["totals"]["call_details"][0][
                "request_duration_ms"
            ] += 1
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "aggregate call details must equal the interaction concatenation",
            )
            payload = json.loads(json.dumps(valid_payload))
            payload["real_model_calls"] += 1
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "real model calls must conserve the aggregated timing calls",
            )
            payload = valid_payload
            result.write_text(json.dumps(payload), encoding="utf-8")
            payload["stt_calls"] = 7
            payload["stt_transcript_mismatches"] = 4
            payload["stt_rejections_by_expected_kind"] = {
                "read": 2, "write": 0, "chat": 2, "unexpected": 0,
            }
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(
                self.run_audit(command), 0,
                "read/chat retries at the exact driver upper bound are valid",
            )
            payload["stt_calls"] = 4
            payload["stt_transcript_mismatches"] = 0
            payload["stt_rejections_by_expected_kind"] = {
                "read": 0, "write": 0, "chat": 0, "unexpected": 0,
            }
            for failure_code in (
                "cancelled", "invalid_response", "model_unavailable",
                "process_error", "timeout",
            ):
                payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                    failure_code
                ] = 1
                result.write_text(json.dumps(payload), encoding="utf-8")
                self.assertEqual(
                    self.run_audit(command), 0,
                    f"bounded {failure_code} metadata explains the extra call",
                )
                payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                    failure_code
                ] = 0
            payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                "unknown"
            ] = 1
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "unclassified exceptions must not explain a retry",
            )
            payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                "unknown"
            ] = 0
            payload["stt_calls"] = 5
            payload["stt_transcript_mismatches"] = 1
            payload["stt_rejections_by_expected_kind"] = {
                "read": 1, "write": 0, "chat": 0, "unexpected": 0,
            }
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "every extra STT call must have a rejection attribution",
            )
            payload["stt_calls"] = 6
            payload["stt_transcript_mismatches"] = 3
            payload["stt_rejections_by_expected_kind"] = {
                "read": 3, "write": 0, "chat": 0, "unexpected": 0,
            }
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "read rejections beyond its retry budget must fail closed",
            )
            payload["stt_calls"] = 6
            payload["stt_transcript_mismatches"] = 2
            payload["stt_rejections_by_expected_kind"] = {
                "read": 2, "write": 0, "chat": 0, "unexpected": 0,
            }
            payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                "process_error"
            ] = 1
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "combined read mismatches and provider failures share one retry budget",
            )
            payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                "process_error"
            ] = 0
            for forbidden_kind in ("write", "unexpected"):
                payload["stt_calls"] = 4
                payload["stt_transcript_mismatches"] = 1
                payload["stt_rejections_by_expected_kind"] = {
                    "read": 0, "write": 0, "chat": 0, "unexpected": 0,
                }
                payload["stt_rejections_by_expected_kind"][forbidden_kind] = 1
                result.write_text(json.dumps(payload), encoding="utf-8")
                self.assertNotEqual(
                    self.run_audit(command), 0,
                    f"{forbidden_kind} rejections must fail closed",
                )
            for forbidden_kind in ("write", "unexpected"):
                payload["stt_calls"] = 4
                payload["stt_transcript_mismatches"] = 0
                payload["stt_rejections_by_expected_kind"] = {
                    "read": 0, "write": 0, "chat": 0, "unexpected": 0,
                }
                payload["stt_non_mismatch_failures_by_expected_kind"][forbidden_kind][
                    "process_error"
                ] = 1
                result.write_text(json.dumps(payload), encoding="utf-8")
                self.assertNotEqual(
                    self.run_audit(command), 0,
                    f"{forbidden_kind} provider failures must fail closed",
                )
                payload["stt_non_mismatch_failures_by_expected_kind"][forbidden_kind][
                    "process_error"
                ] = 0
            payload["stt_rejections_by_expected_kind"] = {
                "read": 0, "write": 0, "chat": 0,
            }
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(self.run_audit(command), 0)
            payload["stt_rejections_by_expected_kind"] = {
                "read": 0, "write": 0, "chat": 0, "unexpected": 0,
            }
            payload["stt_non_mismatch_failures_by_expected_kind"]["read"] = {
                "cancelled": 0, "invalid_response": 0,
                "model_unavailable": 0, "process_error": True,
                "timeout": 0, "unknown": 0,
            }
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(self.run_audit(command), 0)
            payload["stt_calls"] = 3
            payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                "process_error"
            ] = 0
            del payload["stt_non_mismatch_failures_by_expected_kind"]["read"]["unknown"]
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(self.run_audit(command), 0)
            payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                "unknown"
            ] = 0
            payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                "extra"
            ] = 0
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(self.run_audit(command), 0)
            del payload["stt_non_mismatch_failures_by_expected_kind"]["read"][
                "extra"
            ]
            payload["stt_non_mismatch_failures_by_expected_kind"]["read"] = {
                "cancelled": 0, "invalid_response": 0,
                "model_unavailable": 0, "process_error": 0,
                "timeout": 0, "unknown": 0,
            }
            payload["stt_rejections_by_expected_kind"] = {
                "read": True, "write": 0, "chat": 0, "unexpected": 0,
            }
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(self.run_audit(command), 0)
            payload["stt_calls"] = 3
            payload["stt_transcript_mismatches"] = 0
            payload["stt_rejections_by_expected_kind"] = {
                "read": 0, "write": 0, "chat": 0, "unexpected": 0,
            }
            result.write_text(json.dumps(payload), encoding="utf-8")
            payload["stt_failure_message"] = "Bearer unit-test-secret-marker"
            result.write_text(json.dumps(payload), encoding="utf-8")
            self.assertNotEqual(
                self.run_audit(command), 0,
                "provider error messages are outside the exact result schema",
            )
            del payload["stt_failure_message"]
            result.write_text(json.dumps(payload), encoding="utf-8")
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

    def test_voice_e2e_result_conserves_classified_retries(self):
        source = (
            ROOT / "agent/apps/device-harness/src/voice-e2e-cli.ts"
        ).read_text(encoding="utf-8")
        measured = source.split(
            "const measuredStt: SttProvider", 1
        )[1].split("const pythonTts", 1)[0]
        capture_accounting = source.split(
            "const captureResults = completedRuntime.pipeline.results", 1
        )[1].split("runtime = null", 1)[0]
        result = source.split("await atomicJson(resultFile", 1)[1].split(
            "process.stdout.write", 1
        )[0]

        self.assertIn("const transcriptRejectionsByExpectedKind", source)
        self.assertIn("const nonMismatchFailuresByExpectedKind", source)
        self.assertIn("const sttExpectedKindByCapture", source)
        self.assertIn("const acceptedSttCaptures", source)
        self.assertIn("const failedSttCaptures", source)
        self.assertLess(
            source.index("await completedRuntime.close()"),
            source.index("const captureResults = completedRuntime.pipeline.results"),
        )
        self.assertIn("let transcriptMismatch = false", measured)
        self.assertLess(
            measured.index("transcriptRejectionsByExpectedKind[expectedKind]++"),
            measured.index(
                '"INVALID_RESPONSE", "Phase 5E transcript did not match the expected holdout prompt"'
            ),
        )
        self.assertIn("if (!transcriptMismatch)", measured)
        self.assertIn("nonMismatchFailuresByExpectedKind[expectedKind]", measured)
        self.assertIn(
            "captureFailuresByExpectedKind[expectedKind][capture.outcome]++",
            capture_accounting,
        )
        self.assertIn(
            "acceptedSttCaptureFailuresByExpectedKind[expectedKind][capture.outcome]++",
            capture_accounting,
        )
        self.assertIn(
            "failedSttCaptureFailuresByExpectedKind[expectedKind][capture.outcome]++",
            capture_accounting,
        )
        self.assertIn("sttExpectedKindByCapture.get(captureKey)", capture_accounting)
        self.assertIn(
            'if (capture.outcome === "dispatched") dispatchedCaptures++',
            capture_accounting,
        )
        for field in (
            "stt_rejections_by_expected_kind: transcriptRejectionsByExpectedKind",
            "stt_non_mismatch_failures_by_expected_kind: nonMismatchFailuresByExpectedKind",
            "capture_attempts: captureResults.length",
            "capture_failures_by_expected_kind: captureFailuresByExpectedKind",
            "stt_accepted_capture_failures_by_expected_kind:",
            "stt_failed_capture_failures_by_expected_kind:",
        ):
            self.assertIn(field, result)

    def test_voice_ui_result_attributes_rejections_before_dispatch(self):
        source = (
            ROOT / "agent/apps/device-harness/src/voice-ui-e2e-cli.ts"
        ).read_text(encoding="utf-8")
        measured = source.split(
            "const measuredStt: SttProvider", 1
        )[1].split("const roleResults", 1)[0]
        result = source.split("await atomicJson(resultFile", 1)[1].split(
            "process.stdout.write", 1
        )[0]
        failure_mapping = source.split(
            "function boundedSttFailureCode", 1
        )[1].split("async function atomicJson", 1)[0]

        self.assertIn("const transcriptRejectionsByExpectedKind = {", source)
        for expected_kind in ("read", "write", "chat", "unexpected"):
            self.assertIn(f"{expected_kind}: 0", source)
        self.assertLess(
            measured.index("transcriptRejectionsByExpectedKind"),
            measured.index("throw new SttProviderError("),
        )
        self.assertIn(
            "else transcriptRejectionsByExpectedKind.unexpected++", measured
        )
        self.assertIn(
            "stt_rejections_by_expected_kind: transcriptRejectionsByExpectedKind",
            result,
        )
        self.assertIn("const nonMismatchFailuresByExpectedKind = {", source)
        self.assertIn("if (!transcriptMismatch)", measured)
        self.assertIn("boundedSttFailureCode(error)", measured)
        self.assertNotIn(".message", failure_mapping)
        self.assertNotIn("String(error)", failure_mapping)
        self.assertNotIn("error.message", result)
        self.assertNotIn("failure_message", result)
        self.assertIn(
            "stt_non_mismatch_failures_by_expected_kind: nonMismatchFailuresByExpectedKind",
            result,
        )

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
