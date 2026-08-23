import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "agent/packages/provider-stt/python/prepare_model.py"
SPEC = importlib.util.spec_from_file_location("phase5c_prepare_model", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Phase5CSttProfileTest(unittest.TestCase):
    def test_model_verifier_is_revision_hash_and_directory_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            model = pathlib.Path(directory) / "model"
            model.mkdir()
            files = {}
            for name, value in (("config.json", b"{}\n"), ("weights.npz", b"weights")):
                path = model / name
                path.write_bytes(value)
                files[name] = hashlib.sha256(value).hexdigest()
            (model / MODULE.MANIFEST_NAME).write_text(json.dumps({
                "schema_version": 1,
                "provider": "mlx-whisper",
                "provider_version": "0.4.3",
                "model_id": MODULE.MODEL_ID,
                "revision": MODULE.MODEL_REVISION,
                "files": files,
            }), encoding="utf-8")
            self.assertIsNotNone(MODULE.verified_manifest(model))
            (model / "unexpected").write_text("no", encoding="utf-8")
            self.assertIsNone(MODULE.verified_manifest(model))

    def test_workflow_wires_pinned_stt_unified_harness_and_speaker_input(self):
        workflow = (ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml").read_text(
            encoding="utf-8"
        )
        harness = (ROOT / "agent/apps/device-harness/src/voice-stt-cli.ts").read_text(
            encoding="utf-8"
        )
        for marker in (
            "- phase5c_stt",
            "Prepare pinned Phase 5C STT runtime",
            '"$UV_BIN" sync --frozen --python "$PYTHON312_BIN"',
            "export HF_HUB_DISABLE_XET=1",
            'prepare_model.py --verify "$STT_MODEL"',
            "HARNESS_ENTRYPOINT=apps/device-harness/src/voice-stt-cli.ts",
            'test "$("$AGENT_NODE_BIN" --version)" = "v24.19.0"',
            '"$AGENT_NODE_BIN" --import tsx "$HARNESS_ENTRYPOINT"',
            'say -v Samantha "Hi ESP"',
            'say -v Tingting "你好，请介绍一下你自己"',
            "voice_transport: capture opened epoch=",
            '"phase5c_stt_model_revision": phase5c_model_revision',
            '"phase5c_stt_model_manifest_sha256": phase5c_model_manifest_sha256',
            'grep -qx "0" "$AGENT_HARNESS_STATUS_FILE"',
            "grep -q '^VERIFY:phase5c:voice_stt_unified:PASS '",
        ):
            self.assertIn(marker, workflow)
        for marker in (
            "new PythonSttProvider",
            "new VoiceSttPipeline",
            "new UnifiedVoiceRoleDispatcher",
            "new SqliteAuditStore",
            'raw_audio_retained: false',
            'cat_history_messages: sessions.get("cat").history().length',
            "PHASE5C_MAX_VOICE_ATTEMPTS",
            "PHASE5C_EXPECTED_TRANSCRIPT_SHA256",
        ):
            self.assertIn(marker, harness)
        self.assertNotIn('say -v Samantha "Hi ESP"\n                sleep 2', workflow)
        voice_transport = (ROOT / "firmware/components/voice_transport/voice_transport.c").read_text(
            encoding="utf-8"
        )
        self.assertIn('ESP_LOGI(TAG, "capture opened epoch=%" PRIu32', voice_transport)


if __name__ == "__main__":
    unittest.main()
