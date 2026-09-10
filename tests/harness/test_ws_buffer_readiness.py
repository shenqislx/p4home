"""Compile actual IDF receive functions with a coalesced HTTP/WS first frame."""
import importlib.util
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("ws_patch", ROOT / "scripts/patch-idf-ws-buffer.py")
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)

STUBS = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#define ESP_LOGE(...)
#define ESP_LOGW(...)
#define ESP_LOGV(...)
#define ESP_LOGD(...)
#define ESP_STATIC_ANALYZER_CHECK(condition, result) if (condition) return result
#define MAX_WEBSOCKET_HEADER_SIZE 16
typedef void *esp_transport_handle_t;
static int polls, reads, poll_result;
static const unsigned char *network;
static size_t network_len;
static void *esp_transport_get_context_data(void *p) { return p; }
static int esp_transport_poll_read(void *p, int timeout) {
    (void)p; (void)timeout; polls++; return poll_result;
}
static int esp_transport_read(void *p, char *out, int len, int timeout) {
    (void)p; (void)timeout; reads++;
    size_t count = network_len < (size_t)len ? network_len : (size_t)len;
    if (count) { memcpy(out, network, count); network += count; network_len -= count; }
    return (int)count;
}
'''
MAIN = r'''
int main(int argc, char **argv) {
    (void)argv;
    /* The network has no new bytes after a coalesced upgrade + auth_required. */
    const char body[] = "{\"type\":\"auth_required\"}";
    unsigned char frame[128] = {0x81, sizeof(body)-1};
    memcpy(frame+2, body, sizeof(body)-1);
    size_t size = sizeof(body)+1;
    transport_ws_t ws = {0};
    ws.buffer=malloc(size); memcpy(ws.buffer,frame,size); ws.buffer_len=size;
    char output[128]={0};
    /* Run each gate separately so fixing just one cannot hide the other. */
    if (argc == 1) assert(ws_poll_read(&ws, 1000) == 1);
    else assert(ws_read_header(&ws, output, sizeof(output), 1000) == sizeof(body)-1);
    if (argc == 1) assert(ws_read_header(&ws, output, sizeof(output), 1000) == sizeof(body)-1);
    assert(ws_read_payload(&ws, output, sizeof(output), 1000) == sizeof(body)-1);
    assert(memcmp(output,body,sizeof(body)-1)==0 && ws.buffer_len==0);
    assert(polls==0 && reads==0);
    /* Empty cache delegates timeouts and errors unchanged. */
    poll_result=0; assert(ws_poll_read(&ws,1000)==0);
    poll_result=-1; assert(ws_poll_read(&ws,1000)==-1);
    assert(ws_read_header(&ws,output,sizeof(output),1000)==-1);
    /* A partial cached header drains first, then continues from the network. */
    ws.buffer=malloc(1); ws.buffer[0]=(char)frame[0]; ws.buffer_len=1;
    network=frame+1; network_len=size-1; polls=0; reads=0; poll_result=0;
    assert(ws_poll_read(&ws,1000)==1);
    assert(ws_read_header(&ws,output,sizeof(output),1000)==sizeof(body)-1);
    assert(ws_read_payload(&ws,output,sizeof(output),1000)==sizeof(body)-1);
    assert(memcmp(output,body,sizeof(body)-1)==0 && network_len==0);
    assert(polls==0 && reads==2);
    /* Ordinary frames with no upgrade cache still use the parent transport. */
    network=frame; network_len=size; poll_result=1;
    assert(ws_poll_read(&ws,1000)==1);
    assert(ws_read_header(&ws,output,sizeof(output),1000)==sizeof(body)-1);
    assert(ws_read_payload(&ws,output,sizeof(output),1000)==sizeof(body)-1);
    assert(network_len==0 && memcmp(output,body,sizeof(body)-1)==0);
    return 0;
}
'''


def function(source, name):
    start = source.index("static int " + name + "(")
    end = source.index("\n}", start) + 2
    return source[start:end]


class WsBufferReadinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        idf = Path(os.environ.get("IDF_PATH", Path.home() / ".espressif/v5.5.4/esp-idf"))
        source = idf / "components/tcp_transport/transport_ws.c"
        if not source.exists() or not shutil.which("cc"):
            raise unittest.SkipTest("ESP-IDF 5.5.4 source and host C compiler required")
        cls.source = source.read_text()

    def compile(self, source, path):
        types = source[source.index("typedef struct {"):source.index("} transport_ws_t;")+len("} transport_ws_t;")]
        names = ["esp_transport_read_internal", "esp_transport_read_exact_size", "ws_read_header", "ws_read_payload", "ws_poll_read"]
        (path / "test.c").write_text(STUBS + types + "\n" + "\n".join(function(source,n) for n in names) + MAIN)
        subprocess.run(["cc","-std=c11","-Wall","-Wextra","-Werror","-Wno-sign-compare","-Wno-unused-parameter",str(path/"test.c"),"-o",str(path/"test")],check=True)

    def test_original_stalls_at_both_readiness_gates(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory); self.compile(self.source,path)
            for args in [[],["header"]]:
                result=subprocess.run([str(path/"test"),*args],capture_output=True)
                self.assertEqual(result.returncode,-signal.SIGABRT)
                self.assertIn(b"assert",result.stderr.lower())

    def test_patched_drains_cache_and_preserves_parent_behavior(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory); self.compile(PATCH.patch_source(self.source),path)
            for args in [[],["header"]]:
                subprocess.run([str(path/"test"),*args],check=True)

    def test_unreviewed_sdk_source_is_rejected(self):
        with self.assertRaises(ValueError):
            PATCH.patch_source(self.source+"\n/* changed SDK */\n")


if __name__ == "__main__":
    unittest.main()
