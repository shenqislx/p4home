import importlib.util
import os
import pathlib
import plistlib
import subprocess
import tempfile
import types
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "install-product-human-voice.py"
SPEC = importlib.util.spec_from_file_location("product_human_install", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProductHumanVoiceInstallTest(unittest.TestCase):
    def test_product_profile_is_wired_without_agent_harness_or_ha_write_gate(self):
        workflow = (ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml").read_text(
            encoding="utf-8"
        )
        wrapper = (ROOT / "scripts/run-product-human-voice.sh").read_text(encoding="utf-8")
        product = (ROOT / "agent/apps/runtime/src/product-voice-main.ts").read_text(
            encoding="utf-8"
        )
        for expected in (
            "- product_human",
            "Prepare persistent Human Voice product profile",
            "--profile product",
            "Validate persistent Human Voice service",
            '"product_human_mode": profile == "product_human"',
            '"product_human_validation_disabled"',
            "Audit persistent Human Voice upload candidates",
            '"product_human_artifact_audit_status"',
            '! grep -qx "CONFIG_P4HOME_PHASE5A_VALIDATION=y"',
            'grep -q "Public Key Algorithm: rsaEncryption"',
            '--device-uri "$PRODUCT_DEVICE_URI"',
            'CONFIG_P4HOME_AGENT_PROTOCOL_VERSION=3',
            '"product_human_agent_transport_enabled"',
            '"product_human_agent_protocol_version"',
        ):
            self.assertIn(expected, workflow)
        self.assertIn('P4HOME_PRODUCT_ROLE_MODE="human-only"', wrapper)
        self.assertIn('P4HOME_DEVICE_PORT="$device_port"', wrapper)
        self.assertIn('device_port="18444"', wrapper)
        self.assertIn('PRODUCT_DEVICE_PORT="18444"', workflow)
        self.assertIn('if [[ -f "$PRODUCT_CONFIG_DIR/device-port" ]]', workflow)
        self.assertIn("P4HOME_TTS_MODEL", wrapper)
        self.assertNotIn("P4HOME_HA_TOKEN_FILE", wrapper)
        self.assertIn("resolveProductVoiceRoleMode", product)
        self.assertIn("human_only: true", product)
        self.assertIn("new PythonTtsProvider", product)
        self.assertIn('audio_output: "required"', product)

    def test_identity_is_private_stable_and_has_matching_spki(self):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "config"
            config.mkdir(mode=0o700)
            MODULE.generate_identity(config)
            first = {
                name: (config / name).read_bytes()
                for name in ("device-token", "agent-key.pem", "agent-cert.pem")
            }
            for name in first:
                self.assertEqual((config / name).stat().st_mode & 0o077, 0)
            pin = MODULE.spki_sha256(config / "agent-key.pem")
            self.assertRegex(pin, r"^[0-9a-f]{64}$")
            MODULE.subprocess.run(
                [
                    "/usr/bin/openssl", "rsa", "-in", str(config / "agent-key.pem"),
                    "-check", "-noout",
                ],
                check=True,
                stdout=MODULE.subprocess.DEVNULL,
                stderr=MODULE.subprocess.DEVNULL,
            )
            MODULE.generate_identity(config)
            self.assertEqual(
                first,
                {name: (config / name).read_bytes() for name in first},
            )

    def test_installer_writes_secret_free_human_only_launch_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            config = root / "config"
            config.mkdir(mode=0o700)
            for name in ("device-token", "agent-key.pem", "agent-cert.pem"):
                (config / name).write_text("private-placeholder\n", encoding="utf-8")
                (config / name).chmod(0o600)
            state = root / "state"
            logs = root / "logs"
            launch_agent = root / "LaunchAgents" / "voice.plist"
            model = root / "model"
            model.mkdir()
            node = root / "node"
            node.write_text("node-placeholder", encoding="utf-8")
            node.chmod(0o700)
            args = types.SimpleNamespace(
                repo_root=str(ROOT),
                agent_host="192.0.2.30",
                agent_port=18443,
                device_port=18444,
                device_id="p4-product-human",
                node_bin=str(node),
                config_dir=str(config),
                state_dir=str(state),
                log_dir=str(logs),
                launch_agent=str(launch_agent),
            )
            completed = types.SimpleNamespace(stdout="v24.19.0\n")
            with (
                mock.patch.object(MODULE, "resolve_stt_model", return_value=model),
                mock.patch.object(MODULE, "resolve_tts_model", return_value=model),
                mock.patch.object(MODULE.subprocess, "run", return_value=completed),
                mock.patch.object(MODULE, "spki_sha256", return_value="ab" * 32),
            ):
                result = MODULE.install(args)
            self.assertEqual(result, launch_agent.resolve())
            payload = plistlib.loads(launch_agent.read_bytes())
            self.assertEqual(payload["Label"], MODULE.LABEL)
            self.assertTrue(payload["RunAtLoad"])
            self.assertNotIn("device-token", str(payload))
            self.assertNotIn("P4HOME_HA_TOKEN", str(payload))
            self.assertEqual((config / "device-token").stat().st_mode & 0o077, 0)
            self.assertEqual((config / "agent-host").read_text().strip(), "192.0.2.30")
            self.assertEqual((config / "device-port").read_text().strip(), "18444")
            self.assertEqual((config / "tts-model-path").read_text().strip(), str(model))

    def test_installer_migrates_missing_device_port_without_rotating_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            config = root / "config"
            config.mkdir(mode=0o700)
            identity = {
                "device-token": b"stable-token\n",
                "agent-key.pem": b"stable-private-key\n",
                "agent-cert.pem": b"stable-certificate\n",
            }
            for name, body in identity.items():
                (config / name).write_bytes(body)
                (config / name).chmod(0o600)
            model = root / "model"
            model.mkdir()
            node = root / "node"
            node.write_text("node-placeholder", encoding="utf-8")
            node.chmod(0o700)
            args = types.SimpleNamespace(
                repo_root=str(ROOT), agent_host="192.0.2.30", agent_port=18443,
                device_port=18444, device_id="p4-product-human", node_bin=str(node),
                config_dir=str(config), state_dir=str(root / "state"),
                log_dir=str(root / "logs"), launch_agent=str(root / "voice.plist"),
            )
            completed = types.SimpleNamespace(stdout="v24.19.0\n")
            with (
                mock.patch.object(MODULE, "resolve_stt_model", return_value=model),
                mock.patch.object(MODULE, "resolve_tts_model", return_value=model),
                mock.patch.object(MODULE.subprocess, "run", return_value=completed),
                mock.patch.object(MODULE, "spki_sha256", return_value="ab" * 32),
            ):
                MODULE.install(args)
            self.assertEqual((config / "device-port").read_text().strip(), "18444")
            self.assertEqual(
                identity,
                {name: (config / name).read_bytes() for name in identity},
            )

    def test_legacy_config_without_device_port_uses_fixed_default_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            config = root / "config"
            state = root / "state"
            stt_model = root / "stt"
            tts_model = root / "tts"
            config.mkdir(mode=0o700)
            stt_model.mkdir()
            tts_model.mkdir()
            files = {
                "device-id": "p4-product-human\n",
                "device-token": "stable-token\n",
                "agent-key.pem": "stable-key\n",
                "agent-cert.pem": "stable-cert\n",
                "stt-model-path": f"{stt_model}\n",
                "tts-model-path": f"{tts_model}\n",
                "agent-port": "18443\n",
            }
            for name, body in files.items():
                path = config / name
                path.write_text(body, encoding="utf-8")
                path.chmod(0o600)
            capture = root / "captured-device-port"
            node = root / "fake-node"
            node.write_text(
                "#!/bin/sh\n"
                "if [ \"$1\" = \"--version\" ]; then echo v24.19.0; exit 0; fi\n"
                "printf '%s' \"$P4HOME_DEVICE_PORT\" > \"$P4HOME_TEST_CAPTURE\"\n",
                encoding="utf-8",
            )
            node.chmod(0o700)
            environment = os.environ.copy()
            environment.update({
                "P4HOME_PRODUCT_VOICE_CONFIG_DIR": str(config),
                "P4HOME_PRODUCT_VOICE_STATE_DIR": str(state),
                "P4HOME_NODE_BIN": str(node),
                "P4HOME_TEST_CAPTURE": str(capture),
            })
            subprocess.run(
                [str(ROOT / "scripts/run-product-human-voice.sh")],
                check=True,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.assertEqual(capture.read_text(), "18444")
            self.assertFalse((config / "device-port").exists())
            self.assertEqual((config / "device-token").read_text(), "stable-token\n")

    def test_rejects_invalid_endpoint_without_writing_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            args = types.SimpleNamespace(
                repo_root=str(ROOT),
                agent_host="bad host",
                agent_port=18443,
                device_port=18444,
                device_id="p4-product-human",
                node_bin="/missing/node",
                config_dir=str(root / "config"),
                state_dir=str(root / "state"),
                log_dir=str(root / "logs"),
                launch_agent=str(root / "voice.plist"),
            )
            with self.assertRaisesRegex(ValueError, "Agent host"):
                MODULE.install(args)
            self.assertFalse((root / "config/device-token").exists())


if __name__ == "__main__":
    unittest.main()
