import importlib.util
import pathlib
import plistlib
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
        ):
            self.assertIn(expected, workflow)
        self.assertIn('P4HOME_PRODUCT_ROLE_MODE="human-only"', wrapper)
        self.assertNotIn("P4HOME_HA_TOKEN_FILE", wrapper)
        self.assertIn("resolveProductVoiceRoleMode", product)
        self.assertIn("human_only: true", product)

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

    def test_rejects_invalid_endpoint_without_writing_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            args = types.SimpleNamespace(
                repo_root=str(ROOT),
                agent_host="bad host",
                agent_port=18443,
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
