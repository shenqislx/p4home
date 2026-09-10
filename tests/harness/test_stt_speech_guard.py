"""Pinned-model speech/noise regression. Opt in with P4HOME_STT_QUALITY_LIVE=1."""
import importlib.util
import json
import os
import pathlib
import unittest
import wave
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.environ.get('P4HOME_STT_QUALITY_LIVE') == '1', 'requires local pinned MLX model')
class SttSpeechGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import mlx_whisper
        import numpy as np
        cls.mlx_whisper = mlx_whisper
        cls.np = np
        path = ROOT / 'agent/packages/provider-stt/python/p4home_stt_worker.py'
        spec = importlib.util.spec_from_file_location('stt_worker', path)
        cls.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.worker)
        cls.model = pathlib.Path(os.environ['P4HOME_STT_MODEL'])
        if not cls.worker.model_verified(cls.model):
            raise ValueError('model snapshot is not verified')

    def transcribe(self, audio):
        messages = []
        with mock.patch.object(self.worker, 'emit', side_effect=messages.append):
            self.worker.transcribe(self.mlx_whisper, self.model,
                {'session_id':'speech-guard-test', 'stream_id':1, 'epoch':1}, audio)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]['status'], 'completed')
        self.assertFalse(self.np.any(audio))
        return messages[0]['text']

    def test_silence_and_noise_do_not_become_instructions(self):
        np = self.np
        for amplitude in (0, .003, .015):
            for seed in (10, 42):
                with self.subTest(amplitude=amplitude, seed=seed):
                    audio = np.random.default_rng(seed).normal(0, amplitude, 32000).astype(np.float32)
                    self.assertEqual(self.transcribe(audio).strip(), '')

    def test_negation_and_mixed_language_survive(self):
        fixtures = pathlib.Path(os.environ['P4HOME_STT_QUALITY_FIXTURES'])
        for name, expected in [('synthetic-2.wav', ['不要','书房','灯']),
                               ('synthetic-7.wav', ['Human','Robot'])]:
            with self.subTest(name=name):
                with wave.open(str(fixtures/name), 'rb') as f:
                    self.assertEqual((f.getnchannels(),f.getsampwidth(),f.getframerate()),(1,2,16000))
                    audio = self.np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').astype(self.np.float32)/32768
                text = self.transcribe(audio)
                for word in expected: self.assertIn(word, text)

    def test_audio_is_zeroed_on_inference_failure(self):
        audio = self.np.ones(16000, dtype=self.np.float32)
        with mock.patch.object(self.mlx_whisper, 'transcribe', side_effect=RuntimeError('inference failed')):
            with self.assertRaises(RuntimeError): self.transcribe(audio)
        self.assertFalse(self.np.any(audio))
