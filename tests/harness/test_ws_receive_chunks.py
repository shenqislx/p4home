"""Compile actual receivers: WS FIN is not the end of a client buffer chunk."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
COMMON = r'''
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
typedef struct { const char *data_ptr; int data_len, payload_len, payload_offset;
    unsigned op_code; bool fin; } esp_websocket_event_data_t;
static int delivered, errors, reconnects;
static char expected[4097];
static void check(const char *data, size_t len) {
    assert(len == 2048); assert(memcmp(data, expected, len) == 0); delivered++;
}
'''
VOICE = r'''
#define VOICE_WS_OPCODE_BINARY 2
#define VOICE_PROTOCOL_HEADER_BYTES 32
#define VOICE_PROTOCOL_FRAME_PAYLOAD_BYTES 640
#define VOICE_TRANSPORT_CONTROL_MAX_BYTES 4096
#define ESP_OK 0
typedef struct { bool active; } voice_playback_snapshot_t;
static struct { size_t rx_expected, rx_received; bool rx_binary; char rx_control[4097]; } s_voice;
static void voice_metric_protocol_error(void) { errors++; }
static void voice_request_reconnect(void) { reconnects++; }
static void voice_playback_receiver_get_snapshot(voice_playback_snapshot_t *p) { p->active = true; }
static int voice_playback_receiver_frame(const uint8_t *p, size_t n) { (void)p; (void)n; return 0; }
static void voice_playback_receiver_fail(void) { errors++; }
static void voice_handle_control(const char *p, size_t n) { check(p, n); }
'''
AGENT = r'''
#define AGENT_RECEIVER 1
#define AGENT_TRANSPORT_MAX_JSON_FRAME_BYTES 16384
static struct { size_t rx_expected, rx_received; bool rx_dropping; char *rx_frame; } s_agent;
static void agent_metric_protocol_error(void) { errors++; }
static void agent_request_reconnect(void) { reconnects++; }
static int agent_send_protocol_error(const char *a, const char *b, const char *c) {
    (void)a; (void)b; (void)c; errors++; return 0;
}
static void agent_handle_frame(const char *p, size_t n) { check(p, n); }
'''
MAIN = r'''
int main(void) {
    memset(expected, 'x', 2048);
    esp_websocket_event_data_t d = {expected, 1024, 2048, 0, 1, true};
    RECEIVE(&d);
    assert(delivered == 0 && errors == 0 && reconnects == 0);
    d.payload_offset = 1024; d.data_ptr = expected + 1024;
    RECEIVE(&d);
    assert(delivered == 1 && errors == 0);
    /* Missing first chunk, gaps and duplicate chunks cannot expose stale data. */
    RECEIVE(&d); assert(delivered == 1 && errors == 1);
    d.payload_offset = 0; d.data_ptr = expected; RECEIVE(&d);
    d.payload_offset = 1536; d.data_len = 512; RECEIVE(&d);
    assert(delivered == 1 && errors == 2);
    d.payload_offset = 0; d.data_len = 1024; RECEIVE(&d);
    d.payload_offset = 512; RECEIVE(&d);
    assert(delivered == 1 && errors == 3);
    /* Full frame after malformed chunks must recover cleanly. */
    d.payload_offset = 0; d.data_len = 2048; RECEIVE(&d);
    assert(delivered == 2 && errors == 3);
#ifdef AGENT_RECEIVER
    /* FIN on early chunks cannot end the oversized-frame discard window. */
    d.payload_len = 20000; d.data_len = 1024; RECEIVE(&d);
    assert(s_agent.rx_dropping && errors == 4);
    d.payload_offset = 1024; RECEIVE(&d);
    assert(s_agent.rx_dropping && errors == 4);
    d.payload_offset = 19456; d.data_len = 544; RECEIVE(&d);
    assert(!s_agent.rx_dropping && errors == 4);
    d.payload_len = 2048; d.payload_offset = 0; d.data_len = 2048; RECEIVE(&d);
    assert(delivered == 3 && errors == 4);
#endif
    return 0;
}
'''


class ReceiveChunkTests(unittest.TestCase):
    def test_real_receivers(self):
        compiler = shutil.which('cc')
        if not compiler:
            self.skipTest('C compiler unavailable')
        for kind, prefix in [('voice', VOICE), ('agent', AGENT)]:
            with self.subTest(receiver=kind), tempfile.TemporaryDirectory() as directory:
                source = (ROOT / f'firmware/components/{kind}_transport/{kind}_transport.c').read_text()
                start = f'static void {kind}_handle_ws_data('
                end = 'static void voice_ws_event(' if kind == 'voice' else 'static esp_err_t agent_send_handshake('
                if kind == 'agent':
                    start = 'static void agent_reset_rx('
                receiver = source[source.index(start):source.index(end)]
                path = pathlib.Path(directory)
                (path / 'test.c').write_text(COMMON + prefix + receiver +
                    MAIN.replace('RECEIVE', f'{kind}_handle_ws_data'))
                subprocess.run([compiler, '-std=c11', '-Wall', '-Wextra', '-Werror',
                                str(path / 'test.c'), '-o', str(path / 'test')], check=True)
                subprocess.run([str(path / 'test')], check=True)


if __name__ == '__main__':
    unittest.main()
