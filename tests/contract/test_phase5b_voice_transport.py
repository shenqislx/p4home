from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VOICE_SOURCE = ROOT / "firmware/components/voice_transport/voice_transport.c"
VOICE_CREDIT_POLICY = ROOT / "firmware/components/voice_transport/voice_credit_policy.h"
PLAYBACK_SOURCE = ROOT / "firmware/components/voice_transport/voice_playback_receiver.c"
VOICE_HEADER = ROOT / "firmware/components/voice_transport/include/voice_transport.h"
VOICE_KCONFIG = ROOT / "firmware/components/voice_transport/Kconfig.projbuild"
VOICE_CMAKE = ROOT / "firmware/components/voice_transport/CMakeLists.txt"
BOARD_KCONFIG = ROOT / "firmware/components/board_support/Kconfig.projbuild"
BOARD_SOURCE = ROOT / "firmware/components/board_support/board_support.c"
HA_SOURCE = ROOT / "firmware/components/ha_client/ha_client.c"
SR_SOURCE = ROOT / "firmware/components/sr_service/sr_service.c"
RUNTIME_SOURCE = ROOT / "agent/apps/runtime/src/voice-websocket-server.ts"
WEATHER_SOURCE = ROOT / "firmware/components/weather_service/weather_service.c"
ENERGY_SOURCE = ROOT / "firmware/components/ui_pages/ui_page_energy.c"


class Phase5BVoiceTransportContractTest(unittest.TestCase):
    def test_voice_data_plane_is_independent_authenticated_and_bounded(self) -> None:
        runtime = RUNTIME_SOURCE.read_text(encoding="utf-8")
        firmware = VOICE_SOURCE.read_text(encoding="utf-8")

        self.assertIn('const VOICE_WEBSOCKET_PATH = "/v1/voice"', runtime)
        self.assertIn("X-P4-Device-ID", firmware)
        self.assertIn('"Authorization: Bearer %s\\r\\nX-P4-Device-ID: %s\\r\\n"', firmware)
        self.assertIn("VOICE_TRANSPORT_QUEUE_FRAMES 16U", firmware)
        self.assertIn("VOICE_TRANSPORT_MAX_INFLIGHT_FRAMES 16U", firmware)
        self.assertIn("xTaskCreateWithCaps", firmware)
        self.assertIn("MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT", firmware)
        self.assertIn(".task_stack = CONFIG_P4HOME_VOICE_WEBSOCKET_TASK_STACK", firmware)
        self.assertIn("vTaskDeleteWithCaps(worker)", firmware)
        self.assertIn("eTaskGetState(worker) == eSuspended", firmware)
        self.assertIn("VOICE_MAX_FRAME_RATE_PER_SECOND = 100", runtime)
        self.assertIn("maxPayload: VOICE_MAX_CONTROL_BYTES", runtime)
        self.assertNotIn("agent_transport.h", firmware)
        self.assertNotIn("ha_client.h", firmware)

    def test_ha_readiness_is_injected_at_the_board_composition_boundary(self) -> None:
        firmware = VOICE_SOURCE.read_text(encoding="utf-8")
        header = VOICE_HEADER.read_text(encoding="utf-8")
        cmake = VOICE_CMAKE.read_text(encoding="utf-8")
        board = BOARD_SOURCE.read_text(encoding="utf-8")

        self.assertIn("voice_transport_capture_readiness_probe_t", header)
        self.assertIn("voice_transport_set_capture_readiness_probe", header)
        self.assertNotIn("ha_client", firmware)
        self.assertNotIn("ha_client", cmake)

        readiness = firmware[
            firmware.index("static bool voice_capture_dependency_ready(void)"):
            firmware.index("static bool voice_valid_uri(")
        ]
        self.assertIn(
            "return probe != NULL && probe(s_voice.capture_readiness_context);",
            readiness,
        )

        setter = firmware[
            firmware.index("esp_err_t voice_transport_set_capture_readiness_probe("):
            firmware.index("esp_err_t voice_transport_init(")
        ]
        self.assertIn("!s_voice.initialized && !s_voice.running", setter)
        self.assertIn("probe != NULL", setter)

        initialize = firmware[
            firmware.index("esp_err_t voice_transport_init("):
            firmware.index("esp_err_t voice_transport_start(")
        ]
        self.assertIn("s_voice.capture_readiness_probe != NULL", initialize)
        self.assertIn("capture readiness probe is not configured", initialize)

        wake = firmware[
            firmware.index(
                "static void voice_wake_detected(void *context, uint64_t detected_at_us)\n{"
            ):
            firmware.index("static bool voice_ready_for_capture(void *context)\n{")
        ]
        self.assertIn("s_voice.suppress_wake_session = !dependency_ready;", wake)
        self.assertIn(
            "if (dependency_ready) voice_playback_receiver_request_wake_prompt();",
            wake,
        )
        self.assertIn("else voice_playback_receiver_request_connecting_prompt();", wake)

        suppress_start = firmware.index(
            "static bool voice_suppress_wake_session(void *context)\n{"
        )
        suppress = firmware[
            suppress_start:
            firmware.index(
                "static void voice_offer_pcm(void *context, const int16_t *samples,",
                suppress_start,
            )
        ]
        self.assertIn("const bool suppress = requested || !dependency_ready;", suppress)
        self.assertIn("if (suppress) {", suppress)

        self.assertIn("return ha_client_initial_sync_ready();", board)
        inject = board.index("voice_transport_set_capture_readiness_probe(")
        initialize_call = board.index("voice_transport_init(NULL)")
        self.assertLess(inject, initialize_call)
        injection_path = board[inject:initialize_call]
        self.assertIn("board_support_voice_capture_ready, NULL", injection_path)
        self.assertIn("if (voice_ret == ESP_OK)", injection_path)

    def test_spki_pin_hashes_the_certificate_subject_public_key_info(self) -> None:
        firmware = VOICE_SOURCE.read_text(encoding="utf-8")
        verifier = firmware[firmware.index("static int voice_verify_spki("):
                            firmware.index("static esp_err_t voice_attach_spki_verifier(")]

        self.assertIn("certificate->pk_raw.p", verifier)
        self.assertIn("certificate->pk_raw.len", verifier)
        self.assertIn("Voice TLS SPKI verification failed reason=pin_mismatch", verifier)
        self.assertIn("Voice TLS SPKI verified", verifier)
        self.assertNotIn("mbedtls_pk_write_pubkey_der", verifier)

    def test_capture_lifecycle_has_explicit_eos_timeout_and_epoch_fencing(self) -> None:
        firmware = VOICE_SOURCE.read_text(encoding="utf-8")
        runtime = RUNTIME_SOURCE.read_text(encoding="utf-8")

        for marker in (
            "VOICE_SESSION_OPENING",
            "VOICE_SESSION_READY",
            "VOICE_SESSION_WAITING_CLOSE",
            "VOICE_TRANSPORT_OPEN_TIMEOUT_US",
            "VOICE_TRANSPORT_END_TIMEOUT_US",
            "VOICE_TRANSPORT_MAX_SESSION_US",
            "VOICE_PROTOCOL_FLAG_END_OF_STREAM",
            "voice_request_abort()",
        ):
            self.assertIn(marker, firmware)
        self.assertIn("outstanding_sequences", firmware)
        self.assertIn("outstanding_sequences[ack_index] != ack", (
            ROOT / "firmware/components/voice_transport/voice_credit_policy.h"
        ).read_text(encoding="utf-8"))
        end_capture = firmware[firmware.index("static void voice_end_capture("):
                               firmware.index("static void voice_worker(")]
        self.assertNotIn("xQueueReceive", end_capture)
        self.assertIn("#highestEpoch", runtime)
        self.assertIn("epoch <= previousEpoch", runtime)
        self.assertIn("VOICE_TRANSPORT_EPOCH_RESERVATION", firmware)
        self.assertIn("voice_reserve_epoch_block", firmware)
        begin_capture = firmware[firmware.index("static bool voice_begin_capture("):
                                 firmware.index("static void voice_offer_pcm(")]
        self.assertNotIn("voice_reserve_epoch_block", begin_capture)
        self.assertNotIn("nvs_", begin_capture)
        worker = firmware[firmware.index("static void voice_worker("):
                          firmware.index("esp_err_t voice_transport_init(")]
        self.assertNotIn("voice_reserve_epoch_block", worker)
        epoch_task = firmware[firmware.index("static void voice_epoch_reservation_task("):
                              firmware.index("static esp_err_t voice_send_json(")]
        self.assertIn("voice_reserve_epoch_block", epoch_task)
        self.assertIn("xTaskCreate(voice_epoch_reservation_task", worker)
        self.assertIn("session.eos must match the final EOS frame", (
            ROOT / "agent/packages/contracts/src/voice-protocol.ts"
        ).read_text(encoding="utf-8"))

    def test_late_terminal_credit_is_narrowly_consumed_without_reopening_credit(self) -> None:
        firmware = VOICE_SOURCE.read_text(encoding="utf-8")
        policy = VOICE_CREDIT_POLICY.read_text(encoding="utf-8")
        credit = firmware[
            firmware.index('} else if (strcmp(type->valuestring, "credit") == 0) {'):
            firmware.index('} else if (strcmp(type->valuestring, "session.closed") == 0) {')
        ]

        # Agent sends credits for non-EOS frames before session.closed, while
        # ESP callbacks can observe them either waiting for close or just after
        # close. Both terminal windows consume the exact acknowledgement but
        # never reopen capture credit.
        self.assertIn("voice_credit_decide(", credit)
        self.assertIn("s_voice.session_state, s_voice.end_requested, s_voice.eos_sent", credit)
        self.assertIn("voice_control_identity_matches_locked(&control_identity)", credit)
        self.assertIn("s_voice.outstanding_sequences, s_voice.outstanding_frames", credit)
        self.assertIn("if (credit_mode == VOICE_CREDIT_ACTIVE) {", credit)
        self.assertNotIn("available_credit += grant", credit[credit.index(
            "if (credit_mode == VOICE_CREDIT_TERMINAL)"
        ):credit.index("if (credit_mode == VOICE_CREDIT_ACTIVE)")])
        self.assertIn("DIAG:voice:late_terminal_credit", credit)
        self.assertIn(
            'terminal_credit_after_close ? "closed_idle" : "waiting_close"',
            credit,
        )
        self.assertRegex(
            credit,
            r"if \(!valid\) \{\s*voice_metric_protocol_error\(\);\s*"
            r"voice_request_reconnect\(\);",
        )

        # Identity validation still fences unknown sessions before the credit
        # branch, so this exception cannot accept a cross-epoch acknowledgement.
        identity_check = firmware.index(
            "if (!voice_control_identity_valid(root, &control_identity))"
        )
        credit_branch = firmware.index(
            '} else if (strcmp(type->valuestring, "credit") == 0) {'
        )
        self.assertLess(identity_check, credit_branch)
        self.assertIn(
            "voice_control_identity_matches_locked(&control_identity)",
            credit,
        )

        # EOS acknowledgements stay invalid. READY without a completed EOS is
        # the only non-terminal state that can use the normal credit path;
        # OPENING and unrelated IDLE sessions remain protocol errors.
        self.assertIn("session_state == VOICE_SESSION_READY", policy)
        self.assertIn("session_state == VOICE_SESSION_WAITING_CLOSE", policy)
        self.assertIn("session_state == VOICE_SESSION_IDLE", policy)
        self.assertIn("end_requested && eos_sent", policy)
        self.assertIn("eos_sent && ack >= final_sequence", policy)

        # Session state changes can race websocket callbacks, so the parsed
        # identity is checked again while the credit state is locked.
        identity_match = firmware[
            firmware.index("static bool voice_control_identity_matches_locked("):
            firmware.index("static bool voice_control_identity_valid(")
        ]
        self.assertIn("identity->session_id", identity_match)
        self.assertIn("identity->stream_id == s_voice.stream_id", identity_match)
        self.assertIn("identity->epoch == s_voice.epoch", identity_match)

    def test_voice_credit_policy_state_matrix(self) -> None:
        compiler = shutil.which("cc")
        if compiler is None:
            self.skipTest("C compiler unavailable")
        source = textwrap.dedent(
            r"""
            #include <assert.h>
            #include <stdbool.h>
            #include <stdint.h>
            #include "voice_credit_policy.h"

            static void expect(voice_credit_mode_t expected, uint32_t acknowledged,
                               bool identity, voice_session_state_t state,
                               bool end_requested, bool eos_sent, uint32_t final_sequence,
                               uint32_t available, const uint32_t *outstanding,
                               uint32_t outstanding_count, int64_t last_ack,
                               uint32_t ack, uint32_t grant)
            {
                const voice_credit_decision_t decision = voice_credit_decide(
                    identity, state, end_requested, eos_sent, final_sequence,
                    available, outstanding, outstanding_count, last_ack,
                    ack, grant, 16U);
                assert(decision.mode == expected);
                assert(decision.acknowledged == acknowledged);
            }

            int main(void)
            {
                const uint32_t outstanding[] = {10U, 11U};

                /* Normal READY credit conserves the negotiated window and
                 * supports cumulative acknowledgement. */
                expect(VOICE_CREDIT_ACTIVE, 1U, true, VOICE_SESSION_READY,
                       false, false, 0U, 14U, outstanding, 2U, 9, 10U, 1U);
                expect(VOICE_CREDIT_ACTIVE, 2U, true, VOICE_SESSION_READY,
                       false, false, 0U, 14U, outstanding, 2U, 9, 11U, 1U);
                expect(VOICE_CREDIT_INVALID, 0U, true, VOICE_SESSION_READY,
                       false, false, 0U, 15U, outstanding, 2U, 9, 10U, 1U);
                expect(VOICE_CREDIT_INVALID, 0U, true, VOICE_SESSION_READY,
                       false, false, 0U, UINT32_MAX, outstanding, 2U, 9, 10U, 1U);

                /* Exact pre-EOS credits are terminal only while waiting for
                 * close or in the just-closed IDLE state. Grant size remains
                 * bounded, but it is not applied to available credit. */
                expect(VOICE_CREDIT_TERMINAL, 1U, true, VOICE_SESSION_WAITING_CLOSE,
                       true, true, 12U, 16U, outstanding, 2U, 9, 10U, 16U);
                expect(VOICE_CREDIT_TERMINAL, 2U, true, VOICE_SESSION_IDLE,
                       true, true, 12U, 16U, outstanding, 2U, 9, 11U, 1U);

                /* Fail closed for identity/state/window/ack violations. */
                expect(VOICE_CREDIT_INVALID, 0U, false, VOICE_SESSION_WAITING_CLOSE,
                       true, true, 12U, 0U, outstanding, 2U, 9, 10U, 1U);
                expect(VOICE_CREDIT_INVALID, 0U, true, VOICE_SESSION_OPENING,
                       true, true, 12U, 0U, outstanding, 2U, 9, 10U, 1U);
                expect(VOICE_CREDIT_INVALID, 0U, true, VOICE_SESSION_IDLE,
                       false, false, 12U, 0U, outstanding, 2U, 9, 10U, 1U);
                expect(VOICE_CREDIT_INVALID, 0U, true, VOICE_SESSION_WAITING_CLOSE,
                       true, true, 10U, 0U, outstanding, 2U, 9, 10U, 1U);
                expect(VOICE_CREDIT_INVALID, 0U, true, VOICE_SESSION_WAITING_CLOSE,
                       true, true, 12U, 0U, outstanding, 2U, 10, 10U, 1U);
                expect(VOICE_CREDIT_INVALID, 0U, true, VOICE_SESSION_WAITING_CLOSE,
                       true, true, 12U, 0U, outstanding, 2U, 9, 8U, 1U);
                expect(VOICE_CREDIT_INVALID, 0U, true, VOICE_SESSION_WAITING_CLOSE,
                       true, true, 12U, 0U, outstanding, 2U, 9, 10U, 0U);
                expect(VOICE_CREDIT_INVALID, 0U, true, VOICE_SESSION_WAITING_CLOSE,
                       true, true, 12U, 0U, outstanding, 2U, 9, 10U, 17U);

                /* A fresh READY session still uses only its current identity. */
                expect(VOICE_CREDIT_ACTIVE, 1U, true, VOICE_SESSION_READY,
                       false, false, 0U, 14U, outstanding, 2U, 9, 10U, 1U);
                expect(VOICE_CREDIT_INVALID, 0U, false, VOICE_SESSION_READY,
                       false, false, 0U, 14U, outstanding, 2U, 9, 10U, 1U);
                return 0;
            }
            """
        )
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            source_path = temporary_path / "voice_credit_policy_test.c"
            executable = temporary_path / "voice_credit_policy_test"
            source_path.write_text(source, encoding="utf-8")
            subprocess.run(
                [
                    compiler,
                    "-std=c11",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    "-I",
                    str(VOICE_CREDIT_POLICY.parent),
                    str(source_path),
                    "-o",
                    str(executable),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run([str(executable)], check=True)

    def test_websocket_control_frames_do_not_reconnect_the_voice_channel(self) -> None:
        firmware = VOICE_SOURCE.read_text(encoding="utf-8")
        event_handler = firmware[firmware.index("static void voice_ws_event("):
                                 firmware.index("static bool voice_queue_frame(")]

        for marker in (
            "VOICE_WS_OPCODE_CLOSE",
            "VOICE_WS_OPCODE_PING",
            "VOICE_WS_OPCODE_PONG",
            "esp_websocket_client owns RFC 6455 control-frame lifecycle",
        ):
            self.assertIn(marker, event_handler)
        control_branch = event_handler[event_handler.index("VOICE_WS_OPCODE_CLOSE"):
                                       event_handler.index("else if (data != NULL) {")]
        self.assertNotIn("voice_request_reconnect", control_branch)
        self.assertNotIn("voice_metric_protocol_error", control_branch)

    def test_playback_waits_are_never_rounded_down_to_zero_ticks(self) -> None:
        playback = PLAYBACK_SOURCE.read_text(encoding="utf-8")

        self.assertIn("return ticks == 0 ? 1 : ticks;", playback)
        self.assertIn("vTaskDelay(playback_delay_ticks(1U));", playback)
        self.assertIn(
            "const TickType_t interval_ticks = "
            "playback_delay_ticks(PLAYBACK_TASK_INTERVAL_MS);",
            playback,
        )
        self.assertIn("xQueueReceive(s_playback.queue, &frame, interval_ticks)", playback)
        self.assertIn("vTaskDelay(interval_ticks);", playback)

    def test_product_playback_uses_requested_bounded_volume(self) -> None:
        playback = PLAYBACK_SOURCE.read_text(encoding="utf-8")

        self.assertIn("#define PLAYBACK_VOLUME_PERCENT 83U", playback)
        self.assertIn('"playback opened epoch=%" PRIu32 " volume=%u"', playback)
        self.assertIn("PLAYBACK_VOLUME_PERCENT,", playback)

    def test_sr_capture_registration_precedes_runtime_start(self) -> None:
        board = BOARD_SOURCE.read_text(encoding="utf-8")
        sr = SR_SOURCE.read_text(encoding="utf-8")

        self.assertLess(board.index("voice_transport_init(NULL)"), board.index("sr_service_init()"))
        self.assertLess(board.index("sr_service_init()"), board.index("voice_transport_start()"))
        self.assertIn("sr_service_register_capture_listener", sr)
        self.assertIn("s_capture_listener.offer_pcm", sr)
        self.assertIn("s_capture_listener.end_capture", sr)

    def test_phase5b_preserves_internal_dma_memory_for_ha_and_hosted_wifi(self) -> None:
        firmware = VOICE_SOURCE.read_text(encoding="utf-8")
        ha = HA_SOURCE.read_text(encoding="utf-8")
        kconfig = VOICE_KCONFIG.read_text(encoding="utf-8")
        board_kconfig = BOARD_KCONFIG.read_text(encoding="utf-8")

        self.assertIn("CONFIG_P4HOME_VOICE_WEBSOCKET_TASK_STACK 6144", firmware)
        self.assertIn("CONFIG_P4HOME_VOICE_RECONNECT_TIMEOUT_MS 10000", firmware)
        self.assertIn(".reconnect_timeout_ms = CONFIG_P4HOME_VOICE_RECONNECT_TIMEOUT_MS", firmware)
        self.assertIn("default 6144", kconfig)
        self.assertIn("config P4HOME_BACKGROUND_TASKS_EXTERNAL_STACK", board_kconfig)
        self.assertIn("depends on FREERTOS_TASK_CREATE_ALLOW_EXT_MEM", board_kconfig)
        self.assertIn("xTaskCreateWithCaps(\n        ha_client_worker", ha)
        self.assertIn("MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT", ha)
        self.assertIn("vTaskDeleteWithCaps(worker)", ha)
        self.assertIn("eTaskGetState(worker) == eSuspended", ha)
        self.assertIn("HA_CLIENT_READY_BIT | HA_CLIENT_AUTH_FAIL_BIT |\n                                                           HA_CLIENT_FATAL_ERROR_BIT | HA_CLIENT_STOP_BIT", ha)
        self.assertIn("HA_CLIENT_SUB_FAILED_BIT |\n                                                                   HA_CLIENT_STOP_BIT", ha)
        self.assertIn("HA_CLIENT_REST_OPERATION_TIMEOUT_MS 1500", ha)
        self.assertIn("HA_CLIENT_REST_REQUEST_DEADLINE_MS 5000U", ha)
        self.assertIn("esp_timer_get_time() >= deadline_us", ha)
        stop = ha[ha.index("esp_err_t ha_client_stop(void)"):
                  ha.index("esp_err_t ha_client_restart(void)")]
        self.assertNotIn("ha_client_stop_socket()", stop)
        start = ha[ha.index("esp_err_t ha_client_start(void)"):
                   ha.index("esp_err_t ha_client_stop(void)")]
        self.assertLess(start.index("s_ctx.running = true"), start.index("xTaskCreateWithCaps("))
        self.assertIn("ha_client_delete_worker_task()", start)
        worker = ha[ha.index("static void ha_client_worker("):
                    ha.index("static esp_err_t ha_client_delete_worker_task(")]
        self.assertNotIn("nvs_", worker)
        for source in (WEATHER_SOURCE, ENERGY_SOURCE):
            background = source.read_text(encoding="utf-8")
            self.assertIn("CONFIG_P4HOME_BACKGROUND_TASKS_EXTERNAL_STACK", background)
            self.assertIn("xTaskCreateWithCaps", background)
            self.assertIn("MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT", background)
            self.assertIn("VERIFY:phase5b:background_stack:PASS", background)

    def test_pcm_queues_use_psram_caps_api_with_matching_cleanup(self) -> None:
        firmware = VOICE_SOURCE.read_text(encoding="utf-8")
        playback = PLAYBACK_SOURCE.read_text(encoding="utf-8")

        initialize = firmware[
            firmware.index("esp_err_t voice_transport_init("):
            firmware.index("esp_err_t voice_transport_start(")
        ]
        self.assertIn("s_voice.frame_queue = xQueueCreateWithCaps(", initialize)
        self.assertIn("MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT", initialize)
        self.assertNotIn("s_voice.frame_queue = xQueueCreate(", initialize)
        self.assertGreaterEqual(initialize.count("vQueueDeleteWithCaps(s_voice.frame_queue)"), 4)
        self.assertNotIn("vQueueDelete(s_voice.frame_queue)", initialize)
        self.assertIn("voice_playback_receiver_deinit()", initialize)

        playback_lifecycle = playback[
            playback.index("esp_err_t voice_playback_receiver_init("):
            playback.index("esp_err_t voice_playback_receiver_start(")
        ]
        self.assertIn("s_playback.queue = xQueueCreateWithCaps(", playback_lifecycle)
        self.assertIn("MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT", playback_lifecycle)
        self.assertNotIn("s_playback.queue = xQueueCreate(", playback_lifecycle)
        self.assertIn("vQueueDeleteWithCaps(s_playback.queue)", playback_lifecycle)
        self.assertNotIn("vQueueDelete(s_playback.queue)", playback_lifecycle)
        self.assertIn("s_playback.running || s_playback.task != NULL ||", playback_lifecycle)
        self.assertIn("s_playback.state != PLAYBACK_IDLE", playback_lifecycle)
        self.assertIn("audio_service_write_speaker_samples", playback)

        start = playback[
            playback.index("esp_err_t voice_playback_receiver_start("):
            playback.index("esp_err_t voice_playback_receiver_stop(")
        ]
        stop = playback[
            playback.index("esp_err_t voice_playback_receiver_stop("):
            playback.index("bool voice_playback_receiver_matches(")
        ]
        self.assertIn("if (s_playback.task != NULL) return ESP_ERR_INVALID_STATE;", start)
        self.assertIn("s_playback.running = false;", stop)
        self.assertIn("if (s_playback.task == NULL) return ESP_OK;", stop)
        self.assertNotIn("if (!s_playback.running) return ESP_OK;", stop)
        self.assertIn("s_playback.task = NULL;", stop)

    def test_ha_auth_send_failure_is_retryable_and_diagnostic_is_aggregate_only(self) -> None:
        ha = HA_SOURCE.read_text(encoding="utf-8")
        auth = ha[
            ha.index('if (strcmp(type->valuestring, "auth_required") == 0)'):
            ha.index('} else if (strcmp(type->valuestring, "auth_ok") == 0)')
        ]

        self.assertIn("const int sent = esp_websocket_client_send_text(", auth)
        self.assertIn("if (sent != (int)auth_len)", auth)
        failure = auth[auth.index("if (sent != (int)auth_len)"):auth.index("} else {")]
        self.assertIn('"auth_send_failed", "auth_send_failed"', failure)
        self.assertNotIn("HA_CLIENT_STATE_AUTHENTICATING", failure)
        success = auth[auth.index("} else {"):]
        self.assertIn("s_ctx.auth_sent = true;", success)
        self.assertIn("HA_CLIENT_STATE_AUTHENTICATING", success)
        self.assertNotIn("portMAX_DELAY", auth)
        self.assertIn("pdMS_TO_TICKS(HA_CLIENT_AUTH_SEND_TIMEOUT_MS)", auth)
        self.assertIn("CONFIG_P4HOME_HA_CLIENT_HANDSHAKE_TIMEOUT_MS / 2U", ha)
        self.assertIn("< 3000U", ha)
        self.assertIn("mbedtls_platform_zeroize(auth_json, sizeof(auth_json))", auth)
        self.assertIn("mbedtls_platform_zeroize(token, sizeof(token))", auth)
        self.assertIn('"auth_token_unavailable", "auth_token_unavailable"', auth)

        fail_helper = ha[
            ha.index("static void ha_client_signal_handshake_failure("):
            ha.index("static void ha_client_set_call_result_locked(")
        ]
        self.assertIn("s_ctx.auth_sent = false;", fail_helper)
        self.assertIn("s_ctx.authenticated = false;", fail_helper)
        self.assertIn("HA_CLIENT_STATE_ERROR", fail_helper)
        self.assertIn("xEventGroupClearBits(s_ctx.event_group, HA_CLIENT_READY_BIT)", fail_helper)
        self.assertIn("HA_CLIENT_HANDSHAKE_FAILED_BIT", fail_helper)

        auth_ok = ha[
            ha.index('} else if (strcmp(type->valuestring, "auth_ok") == 0)'):
            ha.index('} else if (strcmp(type->valuestring, "auth_invalid") == 0)')
        ]
        for condition in (
            "source_client == s_ctx.ws",
            "s_ctx.ws_connected",
            "s_ctx.auth_sent",
            "s_ctx.state == HA_CLIENT_STATE_AUTHENTICATING",
            "(handshake_bits & HA_CLIENT_HANDSHAKE_FAILED_BIT) == 0U",
        ):
            self.assertIn(condition, auth_ok)
        self.assertIn("if (accept_auth_ok)", auth_ok)
        self.assertIn("ignored out-of-sequence HA auth_ok", auth_ok)

        worker = ha[
            ha.index("static void ha_client_worker("):
            ha.index("static esp_err_t ha_client_delete_worker_task(")
        ]
        failure_check = worker.index("if ((bits & HA_CLIENT_FAILURE_BITS) != 0U)")
        ready_check = worker.index("else if ((bits & HA_CLIENT_READY_BIT) != 0U)")
        self.assertLess(failure_check, ready_check)
        failure_mask = ha[
            ha.index("#define HA_CLIENT_FAILURE_BITS"):
            ha.index("#define HA_CLIENT_MAX_INITIAL_ENTITIES")
        ]
        for failure_bit in (
            "HA_CLIENT_AUTH_FAIL_BIT",
            "HA_CLIENT_FATAL_ERROR_BIT",
            "HA_CLIENT_HANDSHAKE_FAILED_BIT",
        ):
            with self.subTest(failure_bit=failure_bit):
                self.assertIn(failure_bit, failure_mask)

        auth_invalid = ha[
            ha.index('} else if (strcmp(type->valuestring, "auth_invalid") == 0)'):
            ha.index('} else if (strcmp(type->valuestring, "result") == 0)')
        ]
        self.assertIn("s_ctx.authenticated = false;", auth_invalid)
        self.assertIn("s_ctx.auth_sent = false;", auth_invalid)
        self.assertIn("ha_client_reset_subscription_locked();", auth_invalid)
        self.assertIn("HA_CLIENT_STATE_ERROR", auth_invalid)
        self.assertIn('ha_client_set_error_locked("auth_invalid")', auth_invalid)
        self.assertIn("xEventGroupClearBits(s_ctx.event_group, HA_CLIENT_READY_BIT |", auth_invalid)

        wait_ready = ha[
            ha.index("esp_err_t ha_client_wait_ready("):
            ha.index("bool ha_client_ready(")
        ]
        self.assertGreaterEqual(
            wait_ready.count("if ((bits & HA_CLIENT_FAILURE_BITS) != 0U)"), 2
        )
        self.assertLess(
            wait_ready.index("if ((bits & HA_CLIENT_FAILURE_BITS) != 0U)"),
            wait_ready.index("if ((bits & HA_CLIENT_READY_BIT) != 0U)"),
        )
        self.assertIn("HA_CLIENT_READY_BIT | HA_CLIENT_FAILURE_BITS", wait_ready)
        self.assertIn("return ESP_FAIL;", wait_ready)

        self.assertIn("HA_CLIENT_HANDSHAKE_FAILED_BIT", ha)
        self.assertIn('ha_client_log_internal_heap("ws_init_before")', ha)
        self.assertIn('"ws_start_ok"', ha)
        self.assertIn('ha_client_log_internal_heap("ws_connected")', ha)
        self.assertIn('"auth_send_failed", "auth_send_failed"', ha)
        self.assertIn("internal_free=%u internal_largest=%u internal_min=%u", ha)
        self.assertIn("error type=%d errno=%d handshake_status=%d", ha)
        self.assertNotRegex(ha, r"HA heap[^\n]*(token|entity|url)")

    def test_defaults_remain_disabled_and_diagnostics_are_aggregate_only(self) -> None:
        defaults = (ROOT / "firmware/sdkconfig.defaults").read_text(encoding="utf-8")
        kconfig = VOICE_KCONFIG.read_text(encoding="utf-8")
        firmware = VOICE_SOURCE.read_text(encoding="utf-8")
        header = VOICE_HEADER.read_text(encoding="utf-8")

        self.assertIn("CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED=n", defaults)
        self.assertIn("default n", kconfig)
        self.assertIn("depends on P4HOME_SR_ENABLE", kconfig)
        self.assertIn("MBEDTLS_EXTERNAL_MEM_ALLOC", kconfig)
        self.assertIn("queue_high_water", header)
        self.assertIn("worker_stack_high_water_bytes", header)
        self.assertNotIn("ESP_LOG_BUFFER", firmware)
        self.assertIsNone(re.search(r"ESP_LOG\w*\([^;]*s_voice\.token", firmware))
        voice_cli = (ROOT / "agent/apps/device-harness/src/voice-cli.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn("raw_audio_retained=false", voice_cli)
        self.assertIn("DIAG:phase5b:voice_capture_summary", voice_cli)

    def test_agent_bounds_pending_connections_and_response_backpressure(self) -> None:
        runtime = RUNTIME_SOURCE.read_text(encoding="utf-8")

        self.assertIn("#pendingSockets", runtime)
        self.assertIn("server.maxConnections", runtime)
        self.assertIn("handshakeTimeout", runtime)
        self.assertIn("headersTimeout", runtime)
        self.assertIn("#maxBufferedResponseBytes", runtime)
        self.assertIn("const trySendControls", runtime)


if __name__ == "__main__":
    unittest.main()
