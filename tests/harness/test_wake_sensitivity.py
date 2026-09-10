"""Execute the board AFE policy for both sensitivity settings."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class WakeSensitivityTests(unittest.TestCase):
    def test_sensitivity_only_changes_wakenet_operating_point(self):
        compiler = shutil.which('cc')
        if compiler is None:
            self.skipTest('C compiler unavailable')
        source = (ROOT / 'firmware/components/sr_service/sr_service.c').read_text()
        start = source.index('static void sr_service_apply_board_afe_policy(')
        end = source.index('static const char *sr_service_command_id_to_text', start)
        policy = source[start:end]
        prefix = '''
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#define DET_MODE_95 1
#define AFE_MEMORY_ALLOC_MORE_PSRAM 2
typedef struct {
 bool aec_init, agc_init, ns_init;
 int memory_alloc_mode, wakenet_mode, vad_mode;
 float afe_linear_gain;
 struct { int total_ch_num, mic_num, ref_num; int *mic_ids; } pcm_config;
} afe_config_t;
'''
        main = '''
int main(void) {
 int mic = 0;
 afe_config_t config = {.aec_init=true, .agc_init=true, .ns_init=true,
   .wakenet_mode=0, .vad_mode=3, .afe_linear_gain=1.0,
   .pcm_config={.total_ch_num=1,.mic_num=1,.ref_num=0,.mic_ids=&mic}};
 sr_service_apply_board_afe_policy(NULL);
 sr_service_apply_board_afe_policy(&config);
 assert(sr_service_board_afe_policy_valid(&config));
 assert(config.wakenet_mode == (CONFIG_P4HOME_SR_WAKE_SENSITIVE ? DET_MODE_95 : 0));
 assert(config.ns_init && config.vad_mode == 3 && config.afe_linear_gain == 1.0);
 config.pcm_config.ref_num = 1;
 assert(!sr_service_board_afe_policy_valid(&config));
 assert(!sr_service_board_afe_policy_valid(NULL));
 return 0;
}
'''
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d)
            (p/'test.c').write_text(prefix+policy+main)
            for sensitive in (0, 1):
                with self.subTest(sensitive=sensitive):
                    subprocess.run([compiler,'-std=c11','-Wall','-Wextra','-Werror',
                        f'-DCONFIG_P4HOME_SR_WAKE_SENSITIVE={sensitive}',str(p/'test.c'),'-o',str(p/'test')],check=True)
                    subprocess.run([str(p/'test')],check=True)
