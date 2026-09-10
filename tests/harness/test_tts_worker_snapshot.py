"""Worker startup regressions independent of model/runtime dependencies."""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

WORKER_DIR = pathlib.Path(__file__).resolve().parents[2] / "agent/packages/provider-tts/python"
sys.path.insert(0, str(WORKER_DIR))
import p4home_tts_worker as worker
import prepare_model


class TtsWorkerSnapshotTests(unittest.TestCase):
    def snapshot(self, root: pathlib.Path) -> dict:
        hashes = {}
        for name in prepare_model.REQUIRED_FILES:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"fixture:{name}".encode())
            hashes[name] = prepare_model.sha256(path)
        manifest = {
            "schema_version": 1, "provider": "mlx-audio",
            "provider_version": prepare_model.PROVIDER_VERSION,
            "model_id": prepare_model.MODEL_ID, "revision": prepare_model.MODEL_REVISION,
            "files": hashes,
        }
        (root / prepare_model.MANIFEST_NAME).write_text(json.dumps(manifest))
        return manifest

    def test_worker_rejects_self_consistent_but_untrusted_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            manifest = self.snapshot(root)
            self.assertFalse(worker.model_verified(root))
            with mock.patch.dict(worker.MODEL["EXPECTED_SHA256"], manifest["files"], clear=True):
                self.assertTrue(worker.model_verified(root))
                (root / "voices/zf_xiaoxiao.safetensors").write_bytes(b"damaged")
                self.assertFalse(worker.model_verified(root))

    def test_worker_rejects_malformed_manifest_and_missing_new_voice(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.snapshot(root)
            for value in ([], None, 12, "manifest", {"files": []}):
                with self.subTest(value=value):
                    (root / prepare_model.MANIFEST_NAME).write_text(json.dumps(value))
                    self.assertFalse(worker.model_verified(root))
            manifest = self.snapshot(root)
            with mock.patch.dict(worker.MODEL["EXPECTED_SHA256"], manifest["files"], clear=True):
                (root / "voices/zf_xiaoxiao.safetensors").unlink()
                self.assertFalse(worker.model_verified(root))

    def test_invalid_snapshot_emits_structured_startup_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.snapshot(root)
            (root / prepare_model.MANIFEST_NAME).write_text("[]")
            import os
            result = subprocess.run(
                [sys.executable, "-I", "-u", str(WORKER_DIR / "p4home_tts_worker.py"), "--model", str(root)],
                env={**os.environ, "P4HOME_TTS_PROVIDER_VERSION": worker.PROVIDER_VERSION,
                     "P4HOME_TTS_MODEL_REVISION": worker.MODEL_REVISION},
                capture_output=True, text=True, timeout=15,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)["error_code"], "MODEL_UNAVAILABLE")
            self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
