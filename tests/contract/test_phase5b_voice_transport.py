from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VOICE_SOURCE = ROOT / "firmware/components/voice_transport/voice_transport.c"
VOICE_HEADER = ROOT / "firmware/components/voice_transport/include/voice_transport.h"
VOICE_KCONFIG = ROOT / "firmware/components/voice_transport/Kconfig.projbuild"
BOARD_SOURCE = ROOT / "firmware/components/board_support/board_support.c"
SR_SOURCE = ROOT / "firmware/components/sr_service/sr_service.c"
RUNTIME_SOURCE = ROOT / "agent/apps/runtime/src/voice-websocket-server.ts"


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
        self.assertIn("s_voice.outstanding_sequences[ack_index] != ack", firmware)
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

    def test_sr_capture_registration_precedes_runtime_start(self) -> None:
        board = BOARD_SOURCE.read_text(encoding="utf-8")
        sr = SR_SOURCE.read_text(encoding="utf-8")

        self.assertLess(board.index("voice_transport_init(NULL)"), board.index("sr_service_init()"))
        self.assertLess(board.index("sr_service_init()"), board.index("voice_transport_start()"))
        self.assertIn("sr_service_register_capture_listener", sr)
        self.assertIn("s_capture_listener.offer_pcm", sr)
        self.assertIn("s_capture_listener.end_capture", sr)

    def test_defaults_remain_disabled_and_diagnostics_are_aggregate_only(self) -> None:
        defaults = (ROOT / "firmware/sdkconfig.defaults").read_text(encoding="utf-8")
        kconfig = VOICE_KCONFIG.read_text(encoding="utf-8")
        firmware = VOICE_SOURCE.read_text(encoding="utf-8")
        header = VOICE_HEADER.read_text(encoding="utf-8")

        self.assertIn("CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED=n", defaults)
        self.assertIn("default n", kconfig)
        self.assertIn("depends on P4HOME_SR_ENABLE", kconfig)
        self.assertIn("queue_high_water", header)
        self.assertIn("worker_stack_high_water_bytes", header)
        self.assertNotIn("ESP_LOG_BUFFER", firmware)
        self.assertIsNone(re.search(r"ESP_LOG\w*\([^;]*s_voice\.token", firmware))
        self.assertIn("raw_audio_retained=false", (
            ROOT / "agent/apps/device-harness/src/voice-cli.ts"
        ).read_text(encoding="utf-8"))

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
