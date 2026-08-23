import importlib.util
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "prepare-phase5a-voice-profile.py"
SPEC = importlib.util.spec_from_file_location("phase5a_profile", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Phase5AVoiceProfileTest(unittest.TestCase):
    def test_enables_only_local_voice_baseline_and_disables_agent_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "sdkconfig"
            path.write_text(
                "CONFIG_P4HOME_SR_ENABLE=n\n"
                "# CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST is not set\n"
                "CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED=y\n",
                encoding="utf-8",
            )
            path.chmod(0o600)
            MODULE.prepare(path)
            value = path.read_text(encoding="utf-8")
            self.assertIn("CONFIG_P4HOME_SR_ENABLE=y\n", value)
            self.assertIn("CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST=y\n", value)
            self.assertIn("CONFIG_P4HOME_PHASE5A_VALIDATION=y\n", value)
            self.assertIn("# CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED is not set\n", value)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_is_idempotent_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / "sdkconfig"
            path.write_text("CONFIG_P4HOME_SR_ENABLE=y\n", encoding="utf-8")
            MODULE.prepare(path)
            first = path.read_bytes()
            MODULE.prepare(path)
            self.assertEqual(path.read_bytes(), first)
            link = root / "sdkconfig-link"
            link.symlink_to(path)
            with self.assertRaises(ValueError):
                MODULE.prepare(link)


if __name__ == "__main__":
    unittest.main()
