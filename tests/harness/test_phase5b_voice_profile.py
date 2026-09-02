import importlib.util
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "prepare-phase5b-voice-profile.py"
SPEC = importlib.util.spec_from_file_location("phase5b_profile", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Phase5BVoiceProfileTest(unittest.TestCase):
    def test_enables_bounded_voice_data_plane_and_disables_device_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "sdkconfig"
            path.write_text(
                "CONFIG_ESP_MAIN_TASK_STACK_SIZE=5120\n"
                "CONFIG_P4HOME_SR_ENABLE=n\n"
                "CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED=y\n"
                "# CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED is not set\n",
                encoding="utf-8",
            )
            path.chmod(0o600)
            token_file = pathlib.Path(directory) / "token"
            pin_file = pathlib.Path(directory) / "pin"
            token_file.write_text("t" * 32, encoding="utf-8")
            pin_file.write_text("ab" * 32, encoding="utf-8")
            MODULE.apply_profile(
                path,
                "wss://192.0.2.10:8443/v1/voice",
                "p4-phase5b",
                token_file.read_text().strip(),
                pin_file.read_text().strip(),
            )
            value = path.read_text(encoding="utf-8")
            for line in (
                "CONFIG_ESP_MAIN_TASK_STACK_SIZE=8192",
                "CONFIG_P4HOME_SR_ENABLE=y",
                "CONFIG_P4HOME_PHASE5A_VALIDATION=y",
                "CONFIG_P4HOME_PHASE5B_VALIDATION=y",
                "CONFIG_P4HOME_BACKGROUND_TASKS_EXTERNAL_STACK=y",
                "CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y",
                "# CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC is not set",
                "CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED=y",
                "CONFIG_P4HOME_VOICE_TRANSPORT_TASK_STACK=12288",
                "CONFIG_P4HOME_VOICE_WEBSOCKET_TASK_STACK=6144",
                "CONFIG_P4HOME_VOICE_RECONNECT_TIMEOUT_MS=10000",
                "CONFIG_P4HOME_HA_CLIENT_WS_TASK_STACK=8192",
                "# CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED is not set",
                'CONFIG_P4HOME_VOICE_TRANSPORT_URI="wss://192.0.2.10:8443/v1/voice"',
            ):
                self.assertIn(f"{line}\n", value)
            self.assertNotIn("t" * 32, SCRIPT.read_text(encoding="utf-8"))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_rejects_wrong_path_and_unsafe_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "sdkconfig"
            path.write_text("", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Voice WSS URI"):
                MODULE.apply_profile(path, "wss://host/v1/device", "p4", "t" * 32, "ab" * 32)
            with self.assertRaisesRegex(ValueError, "device id"):
                MODULE.apply_profile(path, "wss://host/v1/voice", "bad id", "t" * 32, "ab" * 32)
            with self.assertRaisesRegex(ValueError, "profile mode"):
                MODULE.apply_profile(
                    path,
                    "wss://host/v1/voice",
                    "p4",
                    "t" * 32,
                    "ab" * 32,
                    "unsafe",
                )

    def test_product_profile_enables_voice_and_human_avatar_device_v3(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "sdkconfig"
            path.write_text(
                "CONFIG_P4HOME_SR_ENABLE=n\n"
                "CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST=y\n"
                "CONFIG_P4HOME_PHASE5A_VALIDATION=y\n"
                "CONFIG_P4HOME_PHASE5B_VALIDATION=y\n",
                encoding="utf-8",
            )
            path.chmod(0o600)
            MODULE.apply_profile(
                path,
                "wss://192.0.2.20:18443/v1/voice",
                "p4-product-human",
                "t" * 32,
                "ab" * 32,
                "product",
                "wss://192.0.2.20:18444/v1/device",
            )
            value = path.read_text(encoding="utf-8")
            for line in (
                "CONFIG_P4HOME_SR_ENABLE=y",
                "CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED=y",
                "# CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST is not set",
                "# CONFIG_P4HOME_PHASE5A_VALIDATION is not set",
                "# CONFIG_P4HOME_PHASE5B_VALIDATION is not set",
                "CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED=y",
                'CONFIG_P4HOME_AGENT_TRANSPORT_URI="wss://192.0.2.20:18444/v1/device"',
                'CONFIG_P4HOME_AGENT_DEVICE_ID="p4-product-human"',
                "CONFIG_P4HOME_AGENT_PROTOCOL_VERSION=3",
                "CONFIG_P4HOME_AGENT_TRANSPORT_TASK_STACK=12288",
                MODULE.PRODUCT_PROFILE_COMMENT,
            ):
                self.assertIn(f"{line}\n", value)
            self.assertNotIn(MODULE.VALIDATION_PROFILE_COMMENT, value)

    def test_product_profile_requires_distinct_same_host_device_endpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "sdkconfig"
            path.write_text("", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "requires Human avatar"):
                MODULE.apply_profile(
                    path, "wss://host:18443/v1/voice", "p4", "t" * 32, "ab" * 32, "product"
                )

    def test_switching_product_to_validation_removes_all_agent_managed_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "sdkconfig"
            path.write_text("CONFIG_P4HOME_SR_ENABLE=n\n", encoding="utf-8")
            path.chmod(0o600)
            MODULE.apply_profile(
                path,
                "wss://192.0.2.20:18443/v1/voice",
                "p4-product-human",
                "p" * 32,
                "ab" * 32,
                "product",
                "wss://192.0.2.20:18444/v1/device",
            )
            MODULE.apply_profile(
                path,
                "wss://192.0.2.10:8443/v1/voice",
                "p4-phase5b",
                "v" * 32,
                "cd" * 32,
                "validation",
            )
            value = path.read_text(encoding="utf-8")
            for key in (
                "CONFIG_P4HOME_AGENT_TRANSPORT_URI",
                "CONFIG_P4HOME_AGENT_DEVICE_ID",
                "CONFIG_P4HOME_AGENT_DEVICE_TOKEN",
                "CONFIG_P4HOME_AGENT_SPKI_SHA256",
                "CONFIG_P4HOME_AGENT_PROTOCOL_VERSION",
                "CONFIG_P4HOME_AGENT_TRANSPORT_TASK_STACK",
            ):
                self.assertNotIn(f"{key}=", value)
                self.assertNotIn(f"# {key} is not set", value)
            self.assertNotIn("p" * 32, value)
            self.assertIn("# CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED is not set\n", value)
            self.assertIn(MODULE.VALIDATION_PROFILE_COMMENT, value)
            self.assertNotIn(MODULE.PRODUCT_PROFILE_COMMENT, value)
            with self.assertRaisesRegex(ValueError, "distinct ports"):
                MODULE.apply_profile(
                    path,
                    "wss://host:18443/v1/voice",
                    "p4",
                    "t" * 32,
                    "ab" * 32,
                    "product",
                    "wss://host:18443/v1/device",
                )

    def test_is_idempotent_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / "sdkconfig"
            path.write_text("CONFIG_P4HOME_SR_ENABLE=y\n", encoding="utf-8")
            MODULE.apply_profile(path, "wss://host/v1/voice", "p4", "t" * 32, "ab" * 32)
            first = path.read_bytes()
            MODULE.apply_profile(path, "wss://host/v1/voice", "p4", "t" * 32, "ab" * 32)
            self.assertEqual(path.read_bytes(), first)
            link = root / "sdkconfig-link"
            link.symlink_to(path)
            with self.assertRaisesRegex(ValueError, "non-symlink"):
                MODULE.apply_profile(link, "wss://host/v1/voice", "p4", "t" * 32, "ab" * 32)

    def test_workflow_wires_profile_harness_and_manifest(self):
        workflow = (ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml").read_text(
            encoding="utf-8"
        )
        for marker in (
            "- phase5b_voice",
            "prepare-phase5b-voice-profile.py",
            "apps/device-harness/src/voice-cli.ts",
            'phase5b_validation_prefix = "CONFIG_P4HOME_PHASE5B_VALIDATION="',
            '"phase5b_voice_transport_enabled": phase5b_voice_transport_enabled',
            '"phase5b_voice_transport_task_stack_size_bytes": phase5b_voice_transport_stack_size',
            '"phase5b_voice_websocket_task_stack_size_bytes": phase5b_voice_websocket_stack_size',
            '"phase5b_background_tasks_external_stack": phase5b_background_tasks_external_stack',
            '"phase5b_mbedtls_external_mem_alloc": phase5b_mbedtls_external_mem_alloc',
            '[[ "$VALIDATION_PROFILE" == "phase5b_voice" ||',
            "HARNESS_ENTRYPOINT=apps/device-harness/src/voice-cli.ts",
            'node --import tsx "$HARNESS_ENTRYPOINT"',
            'test -s "$AGENT_HARNESS_READY_FILE"',
            'if [[ -s "$AGENT_HARNESS_STATUS_FILE" ]]',
            '[[ "${{ inputs.validation_profile }}" == "phase5b_voice" ||',
        ):
            self.assertIn(marker, workflow)
        flash_index = workflow.index('flash > "$monitor_log" 2>&1')
        voice_harness_index = workflow.index(
            "HARNESS_ENTRYPOINT=apps/device-harness/src/voice-cli.ts"
        )
        capture_index = workflow.index("python scripts/capture-esp-serial.py", flash_index)
        self.assertLess(flash_index, voice_harness_index)
        self.assertLess(voice_harness_index, capture_index)


if __name__ == "__main__":
    unittest.main()
