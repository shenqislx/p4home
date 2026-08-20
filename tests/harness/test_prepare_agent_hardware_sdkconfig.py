from __future__ import annotations

import importlib.util
import pathlib
import sys
import tempfile
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "scripts" / "prepare-agent-hardware-sdkconfig.py"
SPEC = importlib.util.spec_from_file_location("prepare_agent_hardware_sdkconfig", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class PrepareAgentHardwareSdkconfigTests(unittest.TestCase):
    def test_profile_replaces_stale_values_without_exposing_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sdkconfig = pathlib.Path(directory) / "sdkconfig"
            sdkconfig.write_text(
                "# CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED is not set\n"
                'CONFIG_P4HOME_AGENT_DEVICE_TOKEN="stale"\n'
                "CONFIG_UNRELATED=y\n",
                encoding="utf-8",
            )
            config = MODULE.AgentHardwareConfig(
                uri="wss://192.0.2.10:8443/v1/device",
                device_id="p4-hardware-test",
                device_token="0123456789abcdef0123456789abcdef",
                spki_sha256="ab" * 32,
            )

            MODULE.apply_profile(sdkconfig, config)

            output = sdkconfig.read_text(encoding="utf-8")
            self.assertIn("CONFIG_UNRELATED=y", output)
            self.assertIn("CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED=y", output)
            self.assertEqual(output.count("CONFIG_P4HOME_AGENT_DEVICE_TOKEN="), 1)
            self.assertIn("CONFIG_P4HOME_AGENT_PROTOCOL_VERSION=1", output)
            self.assertNotIn('CONFIG_P4HOME_AGENT_DEVICE_TOKEN="stale"', output)
            self.assertEqual(sdkconfig.stat().st_mode & 0o777, 0o600)

    def test_profile_rejects_unsafe_transport_values(self) -> None:
        valid = dict(
            uri="wss://192.0.2.10:8443/v1/device",
            device_id="p4-hardware-test",
            device_token="0123456789abcdef0123456789abcdef",
            spki_sha256="ab" * 32,
        )
        for update in (
            {"uri": "ws://192.0.2.10:8443/v1/device"},
            {"uri": "wss://192.0.2.10:8443/v1/device?debug=1"},
            {"device_id": "invalid device"},
            {"device_token": "too-short"},
            {"spki_sha256": "AB" * 32},
            {"protocol_version": 3},
        ):
            with self.subTest(update=next(iter(update))):
                with self.assertRaises(ValueError):
                    MODULE.validate(MODULE.AgentHardwareConfig(**(valid | update)))


if __name__ == "__main__":
    unittest.main()
