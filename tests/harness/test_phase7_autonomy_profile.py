import base64
import json
import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml"
AUDITOR = ROOT / "scripts/audit-phase7-artifacts.py"
AUDITOR_SPEC = importlib.util.spec_from_file_location("phase7_auditor", AUDITOR)
assert AUDITOR_SPEC is not None and AUDITOR_SPEC.loader is not None
AUDITOR_MODULE = importlib.util.module_from_spec(AUDITOR_SPEC)
AUDITOR_SPEC.loader.exec_module(AUDITOR_MODULE)
CAPTURE = ROOT / "scripts/capture-esp-serial.py"
CAPTURE_SPEC = importlib.util.spec_from_file_location("phase7_capture", CAPTURE)
assert CAPTURE_SPEC is not None and CAPTURE_SPEC.loader is not None
CAPTURE_MODULE = importlib.util.module_from_spec(CAPTURE_SPEC)
with mock.patch.dict(sys.modules, {"serial": types.SimpleNamespace(Serial=None)}):
    CAPTURE_SPEC.loader.exec_module(CAPTURE_MODULE)
P4_HA_READY = (
    "$ serial-capture stop-file-observed post_stop_seconds=35\n"
    "diagnostics: ha_summary state=READY reconnect=0 initial=1 events=0 "
    "service_calls=0 epm=0\n"
)


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
        "agent_ha_service_calls_dispatched": 0,
        "agent_ha_invalid_outbound_frames": 0,
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
        ha_client = (
            ROOT / "firmware/components/ha_client/ha_client.c"
        ).read_text(encoding="utf-8")
        diagnostics = (
            ROOT / "firmware/components/diagnostics_service/diagnostics_service.c"
        ).read_text(encoding="utf-8")
        capture = CAPTURE.read_text(encoding="utf-8")
        self.assertIn("- phase7_autonomy", workflow)
        self.assertIn('profile == "phase7_autonomy" and seconds < 300', workflow)
        self.assertIn("apps/device-harness/src/phase7-autonomy-cli.ts", workflow)
        self.assertIn('echo "OLLAMA_MODEL=qwen3.6:35b-mlx"', workflow)
        self.assertIn('echo "CAPTURE_SECONDS=1235"', workflow)
        self.assertIn('--stop-file "$AGENT_HARNESS_STATUS_FILE"', workflow)
        self.assertIn("--post-stop-seconds 35", workflow)
        self.assertIn('--duration-file "$P4HOME_PHASE7_CAPTURE_DURATION_FILE"', workflow)
        self.assertIn("harness_wait_attempts=1", workflow)
        self.assertIn("Audit Phase 7 upload candidates", workflow)
        self.assertIn("scripts/audit-phase7-artifacts.py", workflow)
        self.assertIn('--ha-policy "$P4HOME_PHASE7_POLICY_FILE"', workflow)
        self.assertIn(
            "--entity-catalog firmware/components/panel_data_store/panel_entities.json",
            workflow,
        )
        self.assertIn('--sdkconfig "$HARDWARE_SDKCONFIG"', workflow)
        self.assertIn('--secret-file "$AGENT_TMP_DIR/device-token"', workflow)
        self.assertIn('--secret-file "$AGENT_TMP_DIR/agent-key.pem"', workflow)
        self.assertIn('--secret-file "$P4HOME_PHASE7_TOKEN_FILE"', workflow)
        self.assertIn('--secret-file "$P4HOME_PHASE7_URL_FILE"', workflow)
        self.assertIn('"phase7_artifact_audit_status":', workflow)
        self.assertIn("const HARNESS_DEADLINE_MS = 1_200_000", harness)
        self.assertIn("timer: 86_400_000", harness)
        self.assertIn("rss_peak_growth_bytes", harness)
        self.assertIn("pause_seconds=60 disable_seconds=60", harness)
        self.assertIn("s_ctx.service_calls_dispatched++", ha_client)
        self.assertIn('strcmp(type, "call_service") != 0', ha_client)
        self.assertIn('" service_calls=%" PRIu32', diagnostics)
        self.assertLess(
            capture.index("reset.hard()"),
            capture.index("capture_started_at = time.monotonic()"),
        )
        self.assertNotIn(
            "origin=isolated_transition_from_real_allowlist_snapshot service_calls=0",
            harness,
        )
        upload_condition = workflow.split("      - name: Upload serial artifact", 1)[1]
        self.assertIn("inputs.validation_profile != 'phase7_autonomy'", upload_condition)
        self.assertIn("|| success())", upload_condition)

    def test_auditor_accepts_bounded_result_redacts_monitor_entities_and_rejects_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            monitor = root / "monitor.log"
            result = root / "result.json"
            policy = root / "policy.json"
            catalog = root / "catalog.json"
            sdkconfig = root / "sdkconfig"
            token = root / "token"
            private_key = root / "key.pem"
            status = root / "status"
            output = root / "published.log"
            monitor.write_text(
                P4_HA_READY
                + "VERIFY:phase7:timer_action:PASS action_id=cat7:probe\n"
                "VERIFY:phase7:ha_read_only:PASS agent_service_calls=0\n"
                "diagnostic=light.private_phase7_test\n"
                "panel=climate.private_panel_phase7_a\n"
                "panel=climate.private_panel_phase7_b\n"
                "weather=weather.private_weather_phase7\n",
                encoding="utf-8",
            )
            result.write_text(json.dumps(valid_result()), encoding="utf-8")
            result.chmod(0o600)
            policy.write_text(json.dumps({
                "entities": [{"entity_id": "light.private_phase7_test"}],
            }), encoding="utf-8")
            catalog.write_text(json.dumps({
                "entities": [
                    {"entity_id": "climate.private_panel_phase7_a"},
                    {"entity_id": "climate.private_panel_phase7_b"},
                ],
            }), encoding="utf-8")
            sdkconfig.write_text(
                'CONFIG_P4HOME_WEATHER_PANEL_ENTITY_ID="weather.private_weather_phase7"\n',
                encoding="utf-8",
            )
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
                "--entity-catalog", str(catalog),
                "--sdkconfig", str(sdkconfig),
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
            self.assertIn(
                "VERIFY:phase7:p4_ha_read_only:PASS service_calls=0 ready_samples=1",
                output.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "VERIFY:phase7:timer_action:PASS action_id=cat7:probe\n",
                output.read_text(encoding="utf-8"),
            )
            self.assertNotIn(
                "light.private_phase7_test",
                output.read_text(encoding="utf-8"),
            )
            self.assertNotIn(
                "climate.private_panel_phase7_a",
                output.read_text(encoding="utf-8"),
            )
            self.assertNotIn(
                "climate.private_panel_phase7_b",
                output.read_text(encoding="utf-8"),
            )
            self.assertNotIn("phase7_a", output.read_text(encoding="utf-8"))
            self.assertNotIn("phase7_b", output.read_text(encoding="utf-8"))
            self.assertNotIn(
                "weather.private_weather_phase7",
                output.read_text(encoding="utf-8"),
            )
            self.assertIn("entity_values=4", output.read_text(encoding="utf-8"))

            for leaked in ("456789abcdef0123",):
                monitor.write_text(P4_HA_READY + f"diagnostic={leaked}\n", encoding="utf-8")
                rejected = subprocess.run(
                    command, check=False, capture_output=True, text=True
                )
                self.assertNotEqual(rejected.returncode, 0)
                self.assertFalse(output.exists())
                self.assertEqual(status.read_text(encoding="utf-8"), "fail\n")

            entity = b"light.private_phase7_test"
            encoded_entity_fragments = set()
            for width in (16, 17, 18):
                for offset in (0, 1, 2):
                    fragment = entity[offset : offset + width]
                    for encoder in (base64.b64encode, base64.urlsafe_b64encode):
                        encoded = encoder(fragment)
                        encoded_entity_fragments.add(encoded.decode())
                        encoded_entity_fragments.add(encoded.rstrip(b"=").decode())
            for encoder in (base64.b64encode, base64.urlsafe_b64encode):
                complete = encoder(entity).rstrip(b"=")
                for offset in (1, 2, 3):
                    for width in (22, 23, 24):
                        encoded_entity_fragments.add(
                            complete[offset : offset + width].decode()
                        )
            for leaked in (
                "light.private_phase7_test",
                "private_phase7_t",
                "bGlnaHQucHJpdmF0ZV9waGFzZTdfdGVzdA==",
                *sorted(encoded_entity_fragments),
            ):
                monitor.write_text(P4_HA_READY + f"diagnostic={leaked}\n", encoding="utf-8")
                sanitized = subprocess.run(
                    command, check=False, capture_output=True, text=True
                )
                self.assertEqual(sanitized.returncode, 0, sanitized.stderr)
                published = output.read_text(encoding="utf-8")
                self.assertIn("[REDACTED_HA_ENTITY]", published)
                self.assertNotIn(leaked, published)
                self.assertIn("entity_redactions=1", published)

            monitor.write_text(P4_HA_READY + "safe monitor\n", encoding="utf-8")
            leaked_result = valid_result()
            leaked_result["reason"] = "light.private_phase7_test"
            result.write_text(json.dumps(leaked_result), encoding="utf-8")
            result.chmod(0o600)
            rejected_result = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(rejected_result.returncode, 0)
            self.assertIn("entity", rejected_result.stderr)
            self.assertFalse(output.exists())
            self.assertEqual(status.read_text(encoding="utf-8"), "fail\n")

            escaped_entity = "".join(
                f"\\u{ord(character):04x}"
                for character in "light.private_phase7_test"
            )
            escaped_result_text = json.dumps(valid_result()).replace(
                '"reason": "ok"', f'"reason": "{escaped_entity}"'
            )
            result.write_text(escaped_result_text, encoding="utf-8")
            result.chmod(0o600)
            rejected_escaped_result = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(rejected_escaped_result.returncode, 0)
            self.assertIn("entity", rejected_escaped_result.stderr)
            self.assertFalse(output.exists())

            invalid_result = valid_result()
            invalid_result["passed"] = 1
            result.write_text(json.dumps(invalid_result), encoding="utf-8")
            result.chmod(0o600)
            monitor.write_text(P4_HA_READY + "safe monitor\n", encoding="utf-8")
            rejected_invalid_result = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(rejected_invalid_result.returncode, 0)
            self.assertIn("invalid boolean", rejected_invalid_result.stderr)
            self.assertFalse(output.exists())

            secret = token.read_bytes()
            encoded_secret_fragments = set()
            for width in (16, 17, 18):
                for offset in (0, 1, 2):
                    fragment = secret[offset : offset + width]
                    for encoder in (base64.b64encode, base64.urlsafe_b64encode):
                        encoded = encoder(fragment)
                        encoded_secret_fragments.add(encoded.decode())
                        encoded_secret_fragments.add(encoded.rstrip(b"=").decode())
            for encoder in (base64.b64encode, base64.urlsafe_b64encode):
                complete = encoder(secret).rstrip(b"=")
                for offset in (1, 2, 3):
                    for width in (22, 23, 24):
                        encoded_secret_fragments.add(
                            complete[offset : offset + width].decode()
                        )
            for encoded_secret_fragment in sorted(encoded_secret_fragments):
                monitor.write_text(
                    P4_HA_READY + f"diagnostic={encoded_secret_fragment}\n", encoding="utf-8"
                )
                result.write_text(json.dumps(valid_result()), encoding="utf-8")
                result.chmod(0o600)
                rejected_encoded_secret = subprocess.run(
                    command, check=False, capture_output=True, text=True
                )
                self.assertNotEqual(rejected_encoded_secret.returncode, 0)
                self.assertIn("secret leaked", rejected_encoded_secret.stderr)
                self.assertFalse(output.exists())

            for noncanonical_fragment in (
                "dmF0ZV9waGFzZTdfdGVzdF",
                "dmF0ZV9waGFzZTdfdGVzdFABC",
                "MjM0NTY3ODlhYmNkZWYwMT",
                base64.b64encode(
                    b"".join(f"%{byte:02X}".encode() for byte in entity)
                ).decode(),
                base64.b64encode(
                    b"".join(f"%{byte:02X}".encode() for byte in entity)
                ).decode() + "A",
                base64.b64encode(
                    base64.b64encode(base64.b64encode(entity))
                ).decode(),
                base64.b64encode(
                    b"".join(f"%{byte:02X}".encode() for byte in secret)
                ).decode(),
                base64.b64encode(
                    b"".join(f"%{byte:02X}".encode() for byte in secret)
                ).decode() + "A",
                base64.b64encode(
                    base64.b64encode(base64.b64encode(secret))
                ).decode(),
            ):
                with self.subTest(noncanonical_fragment=noncanonical_fragment):
                    monitor.write_text(
                        P4_HA_READY + f"diagnostic={noncanonical_fragment}\n",
                        encoding="utf-8",
                    )
                    result.write_text(json.dumps(valid_result()), encoding="utf-8")
                    result.chmod(0o600)
                    rejected_noncanonical = subprocess.run(
                        command, check=False, capture_output=True, text=True
                    )
                    self.assertNotEqual(rejected_noncanonical.returncode, 0)
                    self.assertFalse(output.exists())

            escaped_secret = "".join(
                f"\\u{ord(character):04x}"
                for character in token.read_text(encoding="utf-8")
            )
            escaped_secret_result = json.dumps(valid_result()).replace(
                '"reason": "ok"', f'"reason": "{escaped_secret}"'
            )
            result.write_text(escaped_secret_result, encoding="utf-8")
            result.chmod(0o600)
            monitor.write_text(P4_HA_READY + "safe monitor\n", encoding="utf-8")
            rejected_escaped_secret = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(rejected_escaped_secret.returncode, 0)
            self.assertIn("secret leaked", rejected_escaped_secret.stderr)
            self.assertFalse(output.exists())

            monitor.write_text(
                P4_HA_READY + f"diagnostic={escaped_entity}\n",
                encoding="utf-8",
            )
            result.write_text(json.dumps(valid_result()), encoding="utf-8")
            result.chmod(0o600)
            rejected_monitor_escaped_entity = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(rejected_monitor_escaped_entity.returncode, 0)
            self.assertFalse(output.exists())

            monitor.write_text(
                P4_HA_READY + f"diagnostic={escaped_secret}\n",
                encoding="utf-8",
            )
            rejected_monitor_escaped_secret = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(rejected_monitor_escaped_secret.returncode, 0)
            self.assertIn("secret leaked", rejected_monitor_escaped_secret.stderr)
            self.assertFalse(output.exists())
            result.write_text(json.dumps(valid_result()), encoding="utf-8")
            result.chmod(0o600)

            policy.write_text(json.dumps({
                "entities": [{
                    "entity_id": "sensor.protect_marker_unique_private",
                }],
            }), encoding="utf-8")
            monitor.write_text(
                P4_HA_READY
                + "VERIFY:phase7:timer_action:PASS "
                "action_id=cat7:protect_marker_unique\n",
                encoding="utf-8",
            )
            protected_collision = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(protected_collision.returncode, 0)
            self.assertIn("protected", protected_collision.stderr)
            self.assertFalse(output.exists())

            policy.write_text(json.dumps({
                "entities": [{"entity_id": "sensor.guru meditation private"}],
            }), encoding="utf-8")
            monitor.write_text(
                P4_HA_READY + "Guru Meditation Error: probe\n", encoding="utf-8"
            )
            raw_crash = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(raw_crash.returncode, 0)
            self.assertIn("crash marker", raw_crash.stderr)
            self.assertFalse(output.exists())

            policy.write_text(json.dumps({
                "entities": [{"entity_id": "light.private_phase7_test"}],
            }), encoding="utf-8")
            monitor.write_text(
                P4_HA_READY + "panel id=sensor.unknown_private_phase7\n",
                encoding="utf-8",
            )
            unknown_entity = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(unknown_entity.returncode, 0)
            self.assertIn("unknown HA entity id", unknown_entity.stderr)
            self.assertFalse(output.exists())

            monitor.write_text(
                P4_HA_READY
                + "VERIFY:phase7:probe:PASS entity_id=sensor.unknown_private_phase7\n",
                encoding="utf-8",
            )
            unknown_verify_entity = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(unknown_verify_entity.returncode, 0)
            self.assertIn("protected", unknown_verify_entity.stderr)
            self.assertFalse(output.exists())

            monitor.write_text(
                P4_HA_READY + "panel id=sensor%2Eunknown_private_phase7\n",
                encoding="utf-8",
            )
            encoded_unknown_entity = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(encoded_unknown_entity.returncode, 0)
            self.assertIn("unknown HA entity id", encoded_unknown_entity.stderr)
            self.assertFalse(output.exists())

            for unknown_line in (
                '{"id":"sensor.unknown_private_phase7"}',
                '{"entity":"sensor.unknown_private_phase7"}',
                "ha_entity_id=sensor.unknown_private_phase7",
                "entity_id : sensor.unknown_private_phase7",
                "panel=sensor.unknown_private_phase7",
                "panel id=sensor%25252Eunknown_private_phase7",
                "panel=air_quality.private_home",
                "panel=custom_private.private_home",
                '{"id":"custom_private.private_home"}',
                "ha_entity_id=custom_private.private_home",
                "diagnostic=c2Vuc29yLnVua25vd25fcHABC",
            ):
                monitor.write_text(P4_HA_READY + unknown_line + "\n", encoding="utf-8")
                rejected_unknown_variant = subprocess.run(
                    command, check=False, capture_output=True, text=True
                )
                self.assertNotEqual(rejected_unknown_variant.returncode, 0)
                self.assertFalse(output.exists())

            monitor.write_text(
                P4_HA_READY + "diagnostic=light%2Eprivate_phase7_test\n",
                encoding="utf-8",
            )
            encoded_known_entity = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(encoded_known_entity.returncode, 0)
            self.assertIn("entity id", encoded_known_entity.stderr)
            self.assertFalse(output.exists())

            status.chmod(0o666)
            policy.write_text(json.dumps({
                "entities": [{"entity_id": "light.private_phase7_test"}],
            }), encoding="utf-8")
            monitor.write_text(P4_HA_READY + "safe monitor\n", encoding="utf-8")
            accepted_private_status = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertEqual(
                accepted_private_status.returncode, 0, accepted_private_status.stderr
            )
            self.assertEqual(status.stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

            secret_result = valid_result()
            secret_result["reason"] = token.read_text(encoding="utf-8")
            result.write_text(json.dumps(secret_result), encoding="utf-8")
            result.chmod(0o600)
            rejected_secret_result = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(rejected_secret_result.returncode, 0)
            self.assertIn("secret leaked", rejected_secret_result.stderr)
            self.assertFalse(output.exists())
            self.assertEqual(status.read_text(encoding="utf-8"), "fail\n")

    def test_auditor_bounds_nested_closure_without_rejecting_many_safe_tokens(self) -> None:
        safe_log = b"\n".join(
            base64.b64encode(f"safe normal token {index:04d}".encode())
            for index in range(1_000)
        )
        views = AUDITOR_MODULE.candidate_views(safe_log)
        self.assertEqual(views, {safe_log})

        adversarial_log = b"\n".join(
            base64.b64encode(f"%25malicious-wrapper-{index:04d}".encode())
            for index in range(300)
        )
        with self.assertRaisesRegex(
            SystemExit, "encoded upload candidate exceeds the Phase 7 audit limit"
        ):
            AUDITOR_MODULE.candidate_views(adversarial_log)

    def test_auditor_retries_short_writes_and_never_publishes_after_zero_write(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            status = root / "status"
            output = root / "published.log"
            real_write = AUDITOR_MODULE.os.write

            def short_write(descriptor: int, value: bytes) -> int:
                return real_write(descriptor, bytes(value[:3]))

            with mock.patch.object(AUDITOR_MODULE.os, "write", side_effect=short_write):
                AUDITOR_MODULE.write_private_text(status, "pass\n")
                AUDITOR_MODULE.publish_monitor(output, b"monitor-body", b"marker\n")
            self.assertEqual(status.read_text(encoding="utf-8"), "pass\n")
            self.assertEqual(output.read_bytes(), b"monitor-body\nmarker\n")

            output.unlink()
            with mock.patch.object(AUDITOR_MODULE.os, "write", return_value=0):
                with self.assertRaises(SystemExit):
                    AUDITOR_MODULE.publish_monitor(output, b"monitor-body", b"marker\n")
            self.assertFalse(output.exists())

    def test_capture_requires_the_complete_post_terminal_window(self) -> None:
        class Clock:
            def __init__(self) -> None:
                self.now = 100.0

            def monotonic(self) -> float:
                return self.now

        class FakeSerial:
            in_waiting = 0

            def __init__(self, clock: Clock, **_: object) -> None:
                self.clock = clock

            def read(self, _: int) -> bytes:
                self.clock.now += 0.25
                return b""

            def close(self) -> None:
                return None

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            stop = root / "status"
            stop.write_text("0\n", encoding="utf-8")

            def run_capture(seconds: int, name: str) -> pathlib.Path:
                clock = Clock()
                duration = root / f"{name}.duration"
                arguments = types.SimpleNamespace(
                    port="fixture",
                    seconds=seconds,
                    output=root / f"{name}.log",
                    baud=115200,
                    append=False,
                    reset=False,
                    stop_file=stop,
                    post_stop_seconds=35,
                    duration_file=duration,
                )
                with (
                    mock.patch.object(CAPTURE_MODULE, "parse_args", return_value=arguments),
                    mock.patch.object(CAPTURE_MODULE.time, "monotonic", side_effect=clock.monotonic),
                    mock.patch.object(
                        CAPTURE_MODULE.serial,
                        "Serial",
                        side_effect=lambda **kwargs: FakeSerial(clock, **kwargs),
                    ),
                ):
                    CAPTURE_MODULE.main()
                return duration

            duration = run_capture(40, "complete")
            self.assertEqual(duration.read_text(encoding="utf-8"), "35\n")
            self.assertEqual(duration.stat().st_mode & 0o777, 0o600)

            with self.assertRaises(RuntimeError):
                run_capture(30, "truncated")
            self.assertFalse((root / "truncated.duration").exists())

    def test_auditor_preserves_safe_functional_failure_for_verdict_owner(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            monitor = root / "monitor.log"
            policy = root / "policy.json"
            catalog = root / "catalog.json"
            sdkconfig = root / "sdkconfig"
            token = root / "token"
            status = root / "status"
            output = root / "published.log"
            monitor.write_text(
                P4_HA_READY
                + "VERIFY:phase7:hardware_harness:FAIL reason=model_timeout\n",
                encoding="utf-8",
            )
            policy.write_text(json.dumps({
                "entities": [{"entity_id": "light.private_phase7_test"}],
            }), encoding="utf-8")
            catalog.write_text(json.dumps({
                "entities": [{"entity_id": "climate.private_panel_phase7"}],
            }), encoding="utf-8")
            sdkconfig.write_text(
                'CONFIG_P4HOME_WEATHER_PANEL_ENTITY_ID="weather.private_weather_phase7"\n',
                encoding="utf-8",
            )
            token.write_text("0123456789abcdef0123456789abcdef", encoding="utf-8")
            completed = subprocess.run([
                "python3", str(AUDITOR),
                "--monitor", str(monitor),
                "--output", str(output),
                "--ha-policy", str(policy),
                "--entity-catalog", str(catalog),
                "--sdkconfig", str(sdkconfig),
                "--secret-file", str(token),
                "--status-file", str(status),
            ], check=False, capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn(
                "VERIFY:phase7:hardware_harness:FAIL",
                output.read_text(encoding="utf-8"),
            )
            monitor.write_text(
                P4_HA_READY
                + "$ serial-capture stop-file-observed post_stop_seconds=35\n",
                encoding="utf-8",
            )
            duplicate_terminal = subprocess.run(
                completed.args, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(duplicate_terminal.returncode, 0)
            self.assertIn("capture marker", duplicate_terminal.stderr)
            self.assertFalse(output.exists())
            monitor.write_text(
                P4_HA_READY.replace("service_calls=0", "service_calls=1"),
                encoding="utf-8",
            )
            p4_write = subprocess.run(
                completed.args, check=False, capture_output=True, text=True
            )
            self.assertNotEqual(p4_write.returncode, 0)
            self.assertIn("dispatched a service call", p4_write.stderr)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
