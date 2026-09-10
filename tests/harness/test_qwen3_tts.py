"""Qwen3 snapshot trust and continuous resampling regressions."""
import importlib.util
import json
import io
import os
import types
import pathlib
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKER = ROOT / "agent/packages/provider-tts/python"
def load(name):
    spec = importlib.util.spec_from_file_location(name, WORKER / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
prepare = load('prepare_qwen3_model')
resampler = load('tts_resampler')

class Qwen3SnapshotTests(unittest.TestCase):
    def fixture(self, root):
        hashes = {}
        for name in prepare.REQUIRED_FILES:
            p = root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(('fixture:' + name).encode())
            hashes[name] = prepare.sha256(p)
        (root / prepare.MANIFEST_NAME).write_text(json.dumps({
            'schema_version': 1, 'provider': 'mlx-audio', 'provider_version': prepare.PROVIDER_VERSION,
            'model_id': prepare.MODEL_ID, 'revision': prepare.MODEL_REVISION, 'files': hashes,
        }))
        return hashes

    def test_untrusted_and_tampered_snapshot_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d); hashes = self.fixture(root)
            self.assertIsNone(prepare.verified_manifest(root))
            with mock.patch.dict(prepare.EXPECTED_SHA256, hashes, clear=True):
                self.assertIsNotNone(prepare.verified_manifest(root))
                (root / 'speech_tokenizer/model.safetensors').write_bytes(b'corrupt')
                self.assertIsNone(prepare.verified_manifest(root))

    def test_symlinks_and_extra_tokenizer_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d) / 'model'; hashes = self.fixture(root)
            with mock.patch.dict(prepare.EXPECTED_SHA256, hashes, clear=True):
                extra = root / 'tokenizer.json'; extra.write_text('{}')
                self.assertIsNone(prepare.verified_manifest(root)); extra.unlink()
                p = root / 'vocab.json'; data = p.read_bytes(); p.unlink()
                outside = root.parent / 'vocab'; outside.write_bytes(data); p.symlink_to(outside)
                self.assertIsNone(prepare.verified_manifest(root))

    def test_failed_install_does_not_publish_partial_snapshot(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d); source = root / 'source'; self.fixture(source)
            with self.assertRaises(ValueError):
                prepare.install_snapshot(source, root / 'target')
            self.assertFalse((root / 'target').exists())
            self.assertFalse(list(root.glob('.qwen3-tts-*')))

@unittest.skipUnless(importlib.util.find_spec("numpy") and importlib.util.find_spec("scipy"),
                     "run numerical checks with the pinned TTS venv")
class StreamingResamplerTests(unittest.TestCase):
    def test_irregular_chunks_match_full_signal_without_boundary_discontinuities(self):
        import numpy as np
        from scipy.signal import resample_poly
        rng = np.random.default_rng(7)
        for length in (1, 2, 31, 79, 24001):
            data = rng.normal(0, .1, length).astype(np.float32)
            converter = resampler.StreamingResampler24To16(); parts=[]; offset=0
            for n in (1, 2, 7, 31, 400, 1201, 9999, length):
                chunk = data[offset:offset+n]; offset += len(chunk)
                parts.append(converter.push(chunk))
            parts.append(converter.push(np.empty(0, dtype=np.float32), final=True))
            actual = np.concatenate(parts)
            np.testing.assert_allclose(actual, resample_poly(data, 2, 3), atol=1e-7)
            self.assertEqual(len(converter.buffer), 0)
            with self.assertRaises(ValueError): converter.push(data)

    def test_nonfinite_input_rejected(self):
        import numpy as np
        with self.assertRaises(ValueError):
            resampler.StreamingResampler24To16().push(np.array([np.nan]))

@unittest.skipUnless(importlib.util.find_spec("numpy") and importlib.util.find_spec("scipy"),
                     "run numerical checks with the pinned TTS venv")
class Qwen3WorkerTests(unittest.TestCase):
    def worker(self):
        with mock.patch.dict(os.environ, {"P4HOME_TTS_MODEL_REVISION": prepare.MODEL_REVISION}):
            return load("p4home_tts_worker")

    def request(self):
        return {'schema_version': 2, 'interaction_id': 'tts:test', 'assignment_id': 'assignment:test',
                'segment_index': 0, 'role_id': 'human', 'voice': 'Serena', 'text': '你好。',
                'language': 'zh', 'sample_rate_hz': 16000, 'channels': 1, 'sample_bits': 16}

    def test_worker_binds_qwen_voice_and_preserves_stream_sample_totals(self):
        import numpy as np
        worker = self.worker(); request = self.request()
        self.assertEqual(worker.MODEL_REVISION, prepare.MODEL_REVISION)
        worker.parse_request((json.dumps(request) + '\n').encode())
        with self.assertRaises(ValueError):
            worker.parse_request((json.dumps({**request, 'voice': 'zf_xiaoxiao'}) + '\n').encode())
        options = {}
        def generate(**kwargs):
            options.update(kwargs)
            for n, count in [(11520, 6), (960, 1)]:
                yield types.SimpleNamespace(audio=np.ones(n, dtype=np.float32) * .1,
                                            sample_rate=24000, token_count=count)
        output = io.StringIO(); worker.PROTOCOL_STDOUT = output
        worker.synthesize(types.SimpleNamespace(generate_custom_voice=generate), pathlib.Path('/unused'), request)
        records = [json.loads(x) for x in output.getvalue().splitlines()]
        self.assertEqual(records[-1]['status'], 'completed')
        self.assertEqual(records[-1]['samples'], 8320)
        self.assertEqual(sum(x['samples'] for x in records[:-1]), 8320)
        self.assertEqual(options['speaker'], 'Serena')
        self.assertEqual(options['language'], 'Chinese')
        self.assertTrue(options['stream'])

    def test_token_limit_cannot_be_reported_as_completed(self):
        import numpy as np
        worker = self.worker()
        model = types.SimpleNamespace(generate_custom_voice=lambda **kwargs: iter([
            types.SimpleNamespace(audio=np.ones(1920), sample_rate=24000, token_count=750)]))
        output = io.StringIO(); worker.PROTOCOL_STDOUT = output
        with self.assertRaisesRegex(ValueError, 'token limit'):
            worker.synthesize(model, pathlib.Path('/unused'), self.request())
        self.assertNotIn('completed', output.getvalue())

if __name__ == '__main__': unittest.main()
