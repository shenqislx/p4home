"""Exercise real conversation service timeout and late local-stage fencing."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class RecognitionUiRecoveryTests(unittest.TestCase):
    def test_real_service(self):
        cc = shutil.which('cc')
        if not cc:
            self.skipTest('C compiler unavailable')
        source = r'''
#include <assert.h>
#include <string.h>
#include "conversation_service.h"
int main(void) {
    conversation_snapshot_t s;
    assert(conversation_service_init() == ESP_OK);
    assert(conversation_service_begin_capture(1) == ESP_OK);
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_TRANSCRIBING) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(100));
    assert(!conversation_service_check_recognition_timeout(125000099));
    assert(conversation_service_check_recognition_timeout(125000100));
    conversation_service_get_snapshot(&s);
    assert(s.local_stage == CONVERSATION_LOCAL_STAGE_TIMED_OUT);
    assert(!conversation_service_check_recognition_timeout(250000100));
    /* New capture starts a fresh deadline. */
    assert(conversation_service_begin_capture(2) == ESP_OK);
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_LISTENING) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(500000000));
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_TRANSCRIBING) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(500000100));
    conversation_update_t u = {.stream_id=1, .epoch=2, .revision=1,
        .stage=CONVERSATION_STAGE_FAILED, .response_role=CONVERSATION_ROLE_SYSTEM,
        .execution_status=CONVERSATION_EXECUTION_FAILED};
    strcpy(u.session_id, "00112233445566778899aabbccddeeff");
    strcpy(u.response_text, "Please wake again");
    assert(conversation_service_apply(&u) == ESP_OK);
    /* Fast remote failure followed by delayed local event stays terminal. */
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_TRANSCRIBING) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(800000000));
    conversation_service_get_snapshot(&s);
    assert(s.local_stage == CONVERSATION_LOCAL_STAGE_IDLE && s.update.stage == CONVERSATION_STAGE_FAILED);
    assert(conversation_service_begin_capture(3) == ESP_OK);
    u.revision++;
    assert(conversation_service_apply(&u) == ESP_ERR_INVALID_STATE);
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_TRANSCRIBING) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(900000000));
    u.epoch=3; u.stage=CONVERSATION_STAGE_THINKING; u.response_role=CONVERSATION_ROLE_NONE;
    u.execution_status=CONVERSATION_EXECUTION_PENDING; u.response_text[0]=0; strcpy(u.user_text, "Hello");
    assert(conversation_service_apply(&u) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(1200000000));
    conversation_service_get_snapshot(&s);
    assert(s.local_stage == CONVERSATION_LOCAL_STAGE_IDLE && s.update.stage == CONVERSATION_STAGE_THINKING);

    /* Same-epoch remote revisions cannot extend the recognition deadline. */
    assert(conversation_service_begin_capture(4) == ESP_OK);
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_TRANSCRIBING) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(1300000000));
    u.epoch=4; u.revision=1; u.stage=CONVERSATION_STAGE_TRANSCRIBING;
    u.user_text[0]=0; u.execution_status=CONVERSATION_EXECUTION_NOT_APPLICABLE;
    assert(conversation_service_apply(&u) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(1400000000));
    u.revision++;
    assert(conversation_service_apply(&u) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(1424999999));
    assert(conversation_service_check_recognition_timeout(1425000000));
    /* A higher revision is still the same timed-out recognition attempt. */
    u.revision++;
    assert(conversation_service_apply(&u) == ESP_ERR_INVALID_STATE);
    u.stage=CONVERSATION_STAGE_LISTENING;
    assert(conversation_service_apply(&u) == ESP_ERR_INVALID_STATE);
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_TRANSCRIBING) == ESP_OK);
    conversation_service_get_snapshot(&s);
    assert(s.local_stage == CONVERSATION_LOCAL_STAGE_TIMED_OUT);

    /* Actual remote progress is still accepted; no playback cancellation. */
    u.stage=CONVERSATION_STAGE_THINKING; u.execution_status=CONVERSATION_EXECUTION_PENDING;
    strcpy(u.user_text, "Hello");
    assert(conversation_service_apply(&u) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(1600000000));

    /* Duplicate capture notifications cannot restart the local deadline. */
    assert(conversation_service_begin_capture(5) == ESP_OK);
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_TRANSCRIBING) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(1700000000));
    assert(conversation_service_begin_capture(5) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(1824999999));
    assert(conversation_service_check_recognition_timeout(1825000000));
    assert(conversation_service_begin_capture(5) == ESP_OK);
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_TRANSCRIBING) == ESP_OK);
    conversation_service_get_snapshot(&s);
    assert(s.local_stage == CONVERSATION_LOCAL_STAGE_TIMED_OUT);

    /* Timeout before any remote snapshot also fences a late local event. */
    assert(conversation_service_begin_capture(6) == ESP_OK);
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_LISTENING) == ESP_OK);
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_TRANSCRIBING) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(1900000000));
    assert(conversation_service_check_recognition_timeout(2025000000));
    assert(conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_TRANSCRIBING) == ESP_OK);
    conversation_service_get_snapshot(&s);
    assert(s.local_stage == CONVERSATION_LOCAL_STAGE_TIMED_OUT);

    /* A new remote epoch can recover even before its local begin notification. */
    u.epoch=7; u.revision=1; u.stage=CONVERSATION_STAGE_TRANSCRIBING;
    u.user_text[0]=0; u.execution_status=CONVERSATION_EXECUTION_NOT_APPLICABLE;
    assert(conversation_service_apply(&u) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(2100000000));
    assert(conversation_service_begin_capture(6) == ESP_ERR_INVALID_STATE);
    assert(conversation_service_begin_capture(7) == ESP_OK);
    assert(!conversation_service_check_recognition_timeout(2224999999));
    assert(conversation_service_check_recognition_timeout(2225000000));
    return 0;
}
'''
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)
            (path / 'test.c').write_text(source)
            subprocess.run([cc, '-std=c11', '-Wall', '-Wextra', '-Werror',
                '-I' + str(ROOT / 'sim/shim'),
                '-I' + str(ROOT / 'firmware/components/conversation_service/include'),
                str(ROOT / 'firmware/components/conversation_service/conversation_service.c'),
                str(path / 'test.c'), '-o', str(path / 'test')], check=True)
            subprocess.run([str(path / 'test')], check=True)


if __name__ == '__main__':
    unittest.main()
