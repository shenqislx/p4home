import importlib.util
import os
import pathlib
import stat
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "audit-phase4-sensitive-data.py"
SECURE_TEMP_ROOT = pathlib.Path("/private/tmp")
if not SECURE_TEMP_ROOT.is_dir():
    SECURE_TEMP_ROOT = pathlib.Path(tempfile.gettempdir()).resolve()
SPEC = importlib.util.spec_from_file_location("phase4_sensitive_audit", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Phase4SensitiveAuditTests(unittest.TestCase):
    def test_secure_secret_rejects_loose_permissions_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            token = root / "token"
            token.write_text("safe-token-value-123456", encoding="ascii")
            token.chmod(0o644)
            with self.assertRaises(ValueError):
                MODULE.secure_secret(token)
            token.chmod(0o600)
            self.assertEqual(MODULE.secure_secret(token), b"safe-token-value-123456")
            link = root / "token-link"
            link.symlink_to(token)
            with self.assertRaises(ValueError):
                MODULE.secure_secret(link)

    def test_runtime_scan_detects_token_headers_entity_ids_and_sensitive_attributes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "artifact.log"
            secret = b"safe-token-value-123456"
            path.write_bytes(
                b"Authorization: Bearer " + secret
                + b' {"entity_id":"light.private_light","latitude":1}'
            )
            result = MODULE.scan_file(path, secret)
            self.assertGreater(result["exact_token"], 0)
            self.assertGreater(result["authorization_header"], 0)
            self.assertGreater(result["raw_entity_id"], 0)
            self.assertGreater(result["sensitive_attribute"], 0)

    def test_clean_runtime_scan_and_output_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / "artifact.log"
            path.write_text("alias=study_light state=off sanitized=true\n", encoding="utf-8")
            result = MODULE.scan_file(path, b"safe-token-value-123456")
            self.assertTrue(all(value == 0 for value in result.values()))
            token = root / "token"
            token.write_text("safe-token-value-123456", encoding="ascii")
            token.chmod(0o600)
            self.assertEqual(stat.S_IMODE(token.stat().st_mode), 0o600)

    def test_runtime_scan_counts_a_match_crossing_a_chunk_boundary_once(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "artifact.log"
            secret = b"safe-token-value-123456"
            path.write_bytes(b"x" * (65_536 - 5) + secret + b"\n")
            result = MODULE.scan_file(path, secret)
            self.assertEqual(result["exact_token"], 1)

    def test_whitespace_compacted_patterns_cross_chunk_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "artifact.log"
            payload = bytearray()
            for prefix, suffix in (
                (b"Authorization", b": Bearer value"),
                (b'"access_token"', b': "value"'),
                (b'"latitude"', b": 1"),
            ):
                padding = (65_536 - 3 - len(payload) % 65_536) % 65_536
                payload.extend(b"x" * padding)
                payload.extend(prefix)
                payload.extend(b" " * 700)
                payload.extend(suffix + b"\n")
            path.write_bytes(payload)
            result = MODULE.scan_file(path, b"safe-token-value-123456")
            self.assertGreater(result["authorization_header"], 0)
            self.assertGreater(result["ha_token_field"], 0)
            self.assertGreater(result["sensitive_attribute"], 0)

    def test_top_level_scan_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            target = root / "artifact.log"
            target.write_text("clean\n", encoding="utf-8")
            link = root / "artifact-link"
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                list(MODULE.iter_files([link]))
            with self.assertRaises(ValueError):
                MODULE.scan_file(link, b"safe-token-value-123456")

    def test_output_symlink_is_rejected_without_touching_target(self):
        with tempfile.TemporaryDirectory(dir=SECURE_TEMP_ROOT) as directory:
            root = pathlib.Path(directory)
            target = root / "victim"
            target.write_text("preserve-me", encoding="utf-8")
            target.chmod(0o644)
            link = root / "report.json"
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                MODULE.write_report(link, {"passed": True})
            self.assertEqual(target.read_text(encoding="utf-8"), "preserve-me")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)

    def test_fifo_inputs_outputs_and_directory_entries_fail_without_blocking(self):
        with tempfile.TemporaryDirectory(dir=SECURE_TEMP_ROOT) as directory:
            root = pathlib.Path(directory)
            fifo = root / "pipe"
            os.mkfifo(fifo, mode=0o600)
            with self.assertRaises(ValueError):
                MODULE.secure_secret(fifo)
            with self.assertRaises(ValueError):
                MODULE.scan_file(fifo, b"safe-token-value-123456")
            with self.assertRaises(ValueError):
                MODULE.write_report(fifo, {"passed": True})
            with self.assertRaises(ValueError):
                list(MODULE.iter_files([root]))


if __name__ == "__main__":
    unittest.main()
