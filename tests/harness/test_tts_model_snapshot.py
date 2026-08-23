from __future__ import annotations

import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "agent/packages/provider-tts/python/prepare_model.py"
SPEC = importlib.util.spec_from_file_location("p4home_tts_prepare_model", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
prepare_model = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare_model)


class TtsModelSnapshotTests(unittest.TestCase):
    def test_download_retries_with_one_persistent_cache(self) -> None:
        calls: list[dict[str, object]] = []
        sleeps: list[float] = []
        with tempfile.TemporaryDirectory() as directory:
            snapshot = pathlib.Path(directory) / "snapshot"
            snapshot.mkdir()
            cache = pathlib.Path(directory) / "cache"

            def fake_download(**kwargs: object) -> str:
                calls.append(kwargs)
                if len(calls) < prepare_model.DOWNLOAD_ATTEMPTS:
                    raise TimeoutError("simulated interrupted transfer")
                return str(snapshot)

            result = prepare_model.download_snapshot(cache, fake_download, sleeps.append)

        self.assertEqual(result, snapshot)
        self.assertEqual(len(calls), prepare_model.DOWNLOAD_ATTEMPTS)
        self.assertEqual(sleeps, [1.0, 2.0])
        for call in calls:
            self.assertEqual(call["repo_id"], prepare_model.MODEL_ID)
            self.assertEqual(call["revision"], prepare_model.MODEL_REVISION)
            self.assertEqual(call["cache_dir"], cache)
            self.assertEqual(call["allow_patterns"], list(prepare_model.REQUIRED_FILES))
            self.assertNotIn("local_dir", call)

    def test_corrupt_cached_file_is_rejected_before_publish(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            snapshot = root / "snapshot"
            output = root / "output"
            output.mkdir()
            expected: dict[str, str] = {}
            for name in prepare_model.REQUIRED_FILES:
                path = snapshot / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f"trusted:{name}".encode())
                expected[name] = prepare_model.sha256(path)
            (snapshot / prepare_model.REQUIRED_FILES[0]).write_bytes(b"corrupt")

            with mock.patch.dict(prepare_model.EXPECTED_SHA256, expected, clear=True):
                with self.assertRaisesRegex(SystemExit, "hash mismatch"):
                    prepare_model.copy_verified_snapshot(snapshot, output)

    def test_verify_rejects_self_consistent_manifest_with_untrusted_hash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            model = pathlib.Path(directory) / "model"
            actual: dict[str, str] = {}
            for name in prepare_model.REQUIRED_FILES:
                path = model / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f"cache:{name}".encode())
                actual[name] = prepare_model.sha256(path)
            (model / prepare_model.MANIFEST_NAME).write_text(json.dumps({
                "schema_version": 1,
                "provider": "mlx-audio",
                "provider_version": prepare_model.PROVIDER_VERSION,
                "model_id": prepare_model.MODEL_ID,
                "revision": prepare_model.MODEL_REVISION,
                "files": actual,
            }), encoding="utf-8")
            trusted = dict(actual)
            trusted[prepare_model.REQUIRED_FILES[0]] = "0" * 64

            with mock.patch.dict(prepare_model.EXPECTED_SHA256, trusted, clear=True):
                self.assertIsNone(prepare_model.verified_manifest(model))

    def test_cache_directory_must_be_private_owned_and_not_a_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            private_cache = root / "private"
            prepare_model.prepare_private_cache(private_cache)
            self.assertEqual(private_cache.stat().st_mode & 0o777, 0o700)
            with mock.patch.object(
                prepare_model.os,
                "getuid",
                return_value=private_cache.stat().st_uid + 1,
            ):
                with self.assertRaisesRegex(SystemExit, "private owned directory"):
                    prepare_model.prepare_private_cache(private_cache)

            wide_cache = root / "wide"
            wide_cache.mkdir(mode=0o755)
            wide_cache.chmod(0o755)
            with self.assertRaisesRegex(SystemExit, "private owned directory"):
                prepare_model.prepare_private_cache(wide_cache)

            target = root / "target"
            target.mkdir(mode=0o700)
            linked_cache = root / "linked"
            linked_cache.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(SystemExit, "private owned directory"):
                prepare_model.prepare_private_cache(linked_cache)

            regular_file = root / "file"
            regular_file.write_text("not a directory", encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "private owned directory"):
                prepare_model.prepare_private_cache(regular_file)


if __name__ == "__main__":
    unittest.main()
