from __future__ import annotations

import importlib.util
import pathlib
import tempfile
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "scripts" / "merge-sdkconfig-defaults.py"
SPEC = importlib.util.spec_from_file_location("merge_sdkconfig_defaults", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MergeSdkconfigDefaultsTests(unittest.TestCase):
    def test_tracked_defaults_override_private_values_and_keep_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            base = root / "private"
            defaults = root / "defaults"
            output = root / "merged"
            base.write_text(
                "CONFIG_WIFI_SSID=\"private\"\n"
                "CONFIG_ESP_MAIN_TASK_STACK_SIZE=3584\n"
                "CONFIG_FEATURE=y\n",
                encoding="utf-8",
            )
            defaults.write_text(
                "CONFIG_ESP_MAIN_TASK_STACK_SIZE=5120\n"
                "# CONFIG_FEATURE is not set\n",
                encoding="utf-8",
            )

            MODULE.merge(base, defaults, output)

            merged = output.read_text(encoding="utf-8")
            self.assertIn('CONFIG_WIFI_SSID="private"', merged)
            self.assertIn("CONFIG_ESP_MAIN_TASK_STACK_SIZE=5120", merged)
            self.assertIn("# CONFIG_FEATURE is not set", merged)
            self.assertNotIn("CONFIG_ESP_MAIN_TASK_STACK_SIZE=3584", merged)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_missing_defaults_are_appended_and_duplicates_are_collapsed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            base = root / "private"
            defaults = root / "defaults"
            output = root / "merged"
            base.write_text("CONFIG_DUP=old\nCONFIG_DUP=older\n", encoding="utf-8")
            defaults.write_text("CONFIG_DUP=new\nCONFIG_ADDED=y\n", encoding="utf-8")

            MODULE.merge(base, defaults, output)

            merged = output.read_text(encoding="utf-8")
            self.assertEqual(merged.count("CONFIG_DUP="), 1)
            self.assertIn("CONFIG_DUP=new", merged)
            self.assertIn("CONFIG_ADDED=y", merged)


if __name__ == "__main__":
    unittest.main()
