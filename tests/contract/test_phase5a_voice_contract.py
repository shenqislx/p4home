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

    def test_p4_afe_policy_matches_the_single_microphone_board(self):
        source = (
            ROOT / "firmware/components/sr_service/sr_service.c"
        ).read_text(encoding="utf-8")
        self.assertIn('#define SR_SERVICE_INPUT_FORMAT "M"', source)
        self.assertIn("afe_config->aec_init = false;", source)
        self.assertIn("afe_config->agc_init = false;", source)
        self.assertIn(
            "afe_config->memory_alloc_mode = AFE_MEMORY_ALLOC_MORE_PSRAM;",
            source,
        )
        self.assertIn("sr_service_apply_board_afe_policy(afe_config);", source)
        self.assertIn("afe_config->pcm_config.total_ch_num == 1", source)
        self.assertIn("afe_config->pcm_config.mic_num == 1", source)
        self.assertIn("afe_config->pcm_config.ref_num == 0", source)

        config_init = source.index("afe_config_t *afe_config = afe_config_init(")
        apply_policy = source.index("sr_service_apply_board_afe_policy(afe_config);")
        validate_policy = source.index("sr_service_board_afe_policy_valid(afe_config)")
        resolve_handle = source.index("esp_afe_handle_from_config(afe_config)")
        self.assertLess(config_init, apply_policy)
        self.assertLess(apply_policy, validate_policy)
        self.assertLess(validate_policy, resolve_handle)

    def test_runtime_readiness_cannot_survive_second_create_failure(self):
        source = (
            ROOT / "firmware/components/sr_service/sr_service.c"
        ).read_text(encoding="utf-8")
        start = source.rindex("static esp_err_t sr_service_start_runtime_loop(")
        create = source.index("afe_iface->create_from_config(afe_config);", start)
        clear_ready = source.index("s_status.afe_runtime_ready = false;", start, create)
        null_check = source.index("if (s_runtime_afe_data == NULL)", create)
        set_ready = source.index("s_status.afe_runtime_ready = true;", null_check)
        create_task = source.index("if (xTaskCreate(sr_service_runtime_task,", set_ready)
        task_created = source.index("s_status.runtime_loop_started = true;", set_ready)
        rollback = source.index("s_status.afe_runtime_ready = false;", create_task)
        self.assertLess(start, clear_ready)
        self.assertLess(clear_ready, create)
        self.assertLess(create, null_check)
        self.assertLess(null_check, set_ready)
        self.assertLess(set_ready, task_created)
        self.assertLess(task_created, create_task)
        self.assertLess(create_task, rollback)

        task_create_end = source.index("return ESP_OK;", create_task)
        self.assertNotIn("s_status.afe_runtime_ready = true;", source[create_task:task_create_end])
        self.assertNotIn("runtime loop task created", source[create_task:task_create_end])


if __name__ == "__main__":
    unittest.main()
