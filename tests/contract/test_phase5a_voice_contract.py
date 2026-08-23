import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]


class Phase5AVoiceContractTest(unittest.TestCase):
    def test_voice_contract_and_firmware_constants_match(self):
        readme = (ROOT / "contracts/voice/v1/README.md").read_text(encoding="utf-8")
        header = (
            ROOT / "firmware/components/voice_protocol/include/voice_protocol.h"
        ).read_text(encoding="utf-8")
        self.assertIn("> Status: candidate in Phase 5A", readme)
        for expected in (
            "#define VOICE_PROTOCOL_VERSION 1U",
            "#define VOICE_PROTOCOL_HEADER_BYTES 56U",
            "#define VOICE_PROTOCOL_SAMPLE_RATE_HZ 16000U",
            "#define VOICE_PROTOCOL_FRAME_SAMPLES 320U",
            "#define VOICE_PROTOCOL_FRAME_PAYLOAD_BYTES 640U",
            "voice_protocol_decode_frame(",
        ):
            self.assertIn(expected, header)

    def test_control_schema_is_strict_and_audio_free(self):
        schema = json.loads(
            (ROOT / "contracts/voice/v1/control-message.schema.json").read_text(encoding="utf-8")
        )
        rendered = json.dumps(schema, sort_keys=True)
        self.assertNotIn('"audio"', rendered)
        self.assertNotIn('"token"', rendered)
        self.assertEqual(schema["$defs"]["format"]["properties"]["sample_rate_hz"]["const"], 16000)
        self.assertEqual(
            schema["$defs"]["sessionId"]["not"]["const"],
            "00000000000000000000000000000000",
        )
        self.assertEqual(schema["$defs"]["sessionOpen"]["allOf"][1]["additionalProperties"], False)

    def test_audio_codec_io_is_serialized_and_faults_are_quarantined(self):
        source = (
            ROOT / "firmware/components/audio_service/audio_service.c"
        ).read_text(encoding="utf-8")
        lease = (
            ROOT / "firmware/components/audio_service/audio_service_lease.c"
        ).read_text(encoding="utf-8")
        self.assertIn("xSemaphoreTake(s_io_mutex, portMAX_DELAY)", source)
        self.assertIn("audio_service_quarantine_action", source)
        self.assertIn("audio_service_lease_fault", lease)
        self.assertIn("state->faulted", lease)

    def test_workflow_exposes_isolated_phase5a_profile(self):
        workflow = (
            ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("- phase5a_voice", workflow)
        self.assertIn("Prepare Phase 5A voice profile", workflow)
        self.assertIn("scripts/prepare-phase5a-voice-profile.py", workflow)
        self.assertIn('profile == "phase5a_voice" and seconds < 180', workflow)
        self.assertIn('"phase5a_validation_enabled": phase5a_validation_enabled', workflow)
        self.assertIn('"phase5a_agent_transport_disabled": phase5a_agent_transport_disabled', workflow)


if __name__ == "__main__":
    unittest.main()
