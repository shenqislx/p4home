#include "conversation_service.h"

#include <ctype.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

typedef struct {
    SemaphoreHandle_t mutex;
    conversation_snapshot_t snapshot;
    conversation_observer_fn observer;
    void *observer_context;
    conversation_rendered_fn rendered_observer;
    void *rendered_context;
    uint32_t rendered_epoch;
    uint32_t rendered_revision;
} conversation_service_state_t;

static conversation_service_state_t s_conversation;

static bool valid_session_id(const char *value)
{
    if (value == NULL || strnlen(value, CONVERSATION_UI_SESSION_ID_HEX_BYTES + 1U) !=
                             CONVERSATION_UI_SESSION_ID_HEX_BYTES) {
        return false;
    }
    bool nonzero = false;
    for (size_t i = 0U; i < CONVERSATION_UI_SESSION_ID_HEX_BYTES; ++i) {
        unsigned char c = (unsigned char)value[i];
        if (!isxdigit(c) || (isalpha(c) && !islower(c))) return false;
        nonzero |= c != '0';
    }
    return nonzero;
}

static bool bounded_text(const char *value, size_t maximum_bytes, size_t maximum_chars)
{
    if (value == NULL || strnlen(value, maximum_bytes + 1U) > maximum_bytes) return false;
    size_t chars = 0U;
    const unsigned char *cursor = (const unsigned char *)value;
    while (*cursor != '\0') {
        if (*cursor < 0x20U && *cursor != '\n' && *cursor != '\t') return false;
        if (*cursor == 0x7fU) return false;
        size_t sequence = 1U;
        if ((*cursor & 0x80U) == 0U) {
            sequence = 1U;
        } else if ((*cursor & 0xe0U) == 0xc0U && *cursor >= 0xc2U) {
            sequence = 2U;
        } else if ((*cursor & 0xf0U) == 0xe0U) {
            sequence = 3U;
        } else if ((*cursor & 0xf8U) == 0xf0U && *cursor <= 0xf4U) {
            sequence = 4U;
        } else {
            return false;
        }
        for (size_t index = 1U; index < sequence; ++index) {
            if ((cursor[index] & 0xc0U) != 0x80U) return false;
        }
        if ((sequence == 3U && *cursor == 0xe0U && cursor[1] < 0xa0U) ||
            (sequence == 3U && *cursor == 0xedU && cursor[1] > 0x9fU) ||
            (sequence == 4U && *cursor == 0xf0U && cursor[1] < 0x90U) ||
            (sequence == 4U && *cursor == 0xf4U && cursor[1] > 0x8fU)) {
            return false;
        }
        cursor += sequence;
        if (++chars > maximum_chars) return false;
    }
    return true;
}

static bool has_text_content(const char *value)
{
    const unsigned char *cursor = (const unsigned char *)value;
    while (*cursor != '\0') {
        if (*cursor >= 0x80U || !isspace(*cursor)) return true;
        cursor++;
    }
    return false;
}

static bool stage_valid(const conversation_update_t *update)
{
    const bool has_user = has_text_content(update->user_text);
    const bool has_response = has_text_content(update->response_text);
    switch (update->stage) {
    case CONVERSATION_STAGE_LISTENING:
        return !has_user && !has_response && update->response_role == CONVERSATION_ROLE_NONE &&
               update->execution_status == CONVERSATION_EXECUTION_NOT_APPLICABLE;
    case CONVERSATION_STAGE_TRANSCRIBING:
        return !has_response && update->response_role == CONVERSATION_ROLE_NONE &&
               update->execution_status == CONVERSATION_EXECUTION_NOT_APPLICABLE;
    case CONVERSATION_STAGE_THINKING:
        return has_user && !has_response && update->response_role == CONVERSATION_ROLE_NONE &&
               update->execution_status == CONVERSATION_EXECUTION_PENDING;
    case CONVERSATION_STAGE_COMPLETED:
        return has_user && has_response &&
               update->response_role >= CONVERSATION_ROLE_HUMAN &&
               update->response_role <= CONVERSATION_ROLE_MIXED &&
               update->execution_status != CONVERSATION_EXECUTION_PENDING;
    case CONVERSATION_STAGE_FAILED:
        return has_response && update->response_role == CONVERSATION_ROLE_SYSTEM &&
               (update->execution_status == CONVERSATION_EXECUTION_FAILED ||
                update->execution_status == CONVERSATION_EXECUTION_UNKNOWN);
    case CONVERSATION_STAGE_CANCELLED:
        return has_response && update->response_role == CONVERSATION_ROLE_SYSTEM &&
               update->execution_status == CONVERSATION_EXECUTION_NOT_APPLICABLE;
    default:
        return false;
    }
}

esp_err_t conversation_service_init(void)
{
    if (s_conversation.mutex != NULL) return ESP_OK;
    s_conversation.mutex = xSemaphoreCreateMutex();
    if (s_conversation.mutex == NULL) return ESP_ERR_NO_MEM;
    memset(&s_conversation.snapshot, 0, sizeof(s_conversation.snapshot));
    s_conversation.snapshot.initialized = true;
    return ESP_OK;
}

esp_err_t conversation_service_apply(const conversation_update_t *update)
{
    if (s_conversation.mutex == NULL) return ESP_ERR_INVALID_STATE;
    if (update == NULL || !valid_session_id(update->session_id) || update->stream_id == 0U ||
        update->epoch == 0U || update->revision == 0U ||
        !bounded_text(update->user_text, CONVERSATION_UI_USER_TEXT_MAX_BYTES,
                      CONVERSATION_UI_USER_TEXT_MAX_CHARS) ||
        !bounded_text(update->response_text, CONVERSATION_UI_RESPONSE_TEXT_MAX_BYTES,
                      CONVERSATION_UI_RESPONSE_TEXT_MAX_CHARS) ||
        !stage_valid(update)) {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(s_conversation.mutex, pdMS_TO_TICKS(250)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    const conversation_update_t *current = &s_conversation.snapshot.update;
    const bool stale = s_conversation.snapshot.available &&
                       (update->epoch < current->epoch ||
                        (update->epoch == current->epoch &&
                         (update->stream_id != current->stream_id ||
                          strcmp(update->session_id, current->session_id) != 0 ||
                          update->revision <= current->revision)));
    if (stale) {
        s_conversation.snapshot.stale_updates_rejected++;
        xSemaphoreGive(s_conversation.mutex);
        return ESP_ERR_INVALID_STATE;
    }
    memset(&s_conversation.snapshot.update, 0, sizeof(s_conversation.snapshot.update));
    memcpy(&s_conversation.snapshot.update, update, sizeof(*update));
    s_conversation.snapshot.available = true;
    s_conversation.snapshot.local_stage = CONVERSATION_LOCAL_STAGE_IDLE;
    s_conversation.snapshot.local_revision++;
    s_conversation.snapshot.updates_applied++;
    conversation_observer_fn observer = s_conversation.observer;
    void *observer_context = s_conversation.observer_context;
    xSemaphoreGive(s_conversation.mutex);
    if (observer != NULL) observer(observer_context);
    return ESP_OK;
}

esp_err_t conversation_service_set_local_stage(conversation_local_stage_t stage)
{
    if (s_conversation.mutex == NULL) return ESP_ERR_INVALID_STATE;
    if (stage < CONVERSATION_LOCAL_STAGE_IDLE ||
        stage > CONVERSATION_LOCAL_STAGE_TRANSCRIBING) {
        return ESP_ERR_INVALID_ARG;
    }
    if (xSemaphoreTake(s_conversation.mutex, pdMS_TO_TICKS(250)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if (s_conversation.snapshot.local_stage == stage) {
        xSemaphoreGive(s_conversation.mutex);
        return ESP_OK;
    }
    s_conversation.snapshot.local_stage = stage;
    s_conversation.snapshot.local_revision++;
    conversation_observer_fn observer = s_conversation.observer;
    void *observer_context = s_conversation.observer_context;
    xSemaphoreGive(s_conversation.mutex);
    if (observer != NULL) observer(observer_context);
    return ESP_OK;
}

esp_err_t conversation_service_set_rendered_observer(conversation_rendered_fn observer,
                                                     void *context)
{
    if (s_conversation.mutex == NULL) return ESP_ERR_INVALID_STATE;
    if (xSemaphoreTake(s_conversation.mutex, pdMS_TO_TICKS(250)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if (observer == NULL) {
        s_conversation.rendered_observer = NULL;
        s_conversation.rendered_context = NULL;
        xSemaphoreGive(s_conversation.mutex);
        return ESP_OK;
    }
    if (s_conversation.rendered_observer != NULL &&
        s_conversation.rendered_observer != observer) {
        xSemaphoreGive(s_conversation.mutex);
        return ESP_ERR_INVALID_STATE;
    }
    s_conversation.rendered_observer = observer;
    s_conversation.rendered_context = context;
    xSemaphoreGive(s_conversation.mutex);
    return ESP_OK;
}

esp_err_t conversation_service_mark_rendered(const conversation_update_t *update)
{
    if (s_conversation.mutex == NULL || update == NULL) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_conversation.mutex, pdMS_TO_TICKS(250)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    const conversation_update_t *current = &s_conversation.snapshot.update;
    const bool matches = s_conversation.snapshot.available &&
                         update->epoch == current->epoch &&
                         update->revision == current->revision &&
                         update->stream_id == current->stream_id &&
                         strcmp(update->session_id, current->session_id) == 0;
    if (!matches) {
        xSemaphoreGive(s_conversation.mutex);
        return ESP_ERR_INVALID_STATE;
    }
    const bool already_rendered = s_conversation.rendered_epoch == update->epoch &&
                                  s_conversation.rendered_revision == update->revision;
    if (!already_rendered) {
        s_conversation.rendered_epoch = update->epoch;
        s_conversation.rendered_revision = update->revision;
    }
    conversation_rendered_fn observer = s_conversation.rendered_observer;
    void *context = s_conversation.rendered_context;
    xSemaphoreGive(s_conversation.mutex);
    if (!already_rendered && observer != NULL) observer(update, context);
    return ESP_OK;
}

esp_err_t conversation_service_add_observer(conversation_observer_fn observer, void *context)
{
    if (s_conversation.mutex == NULL || observer == NULL) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_conversation.mutex, pdMS_TO_TICKS(250)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if (s_conversation.observer != NULL && s_conversation.observer != observer) {
        xSemaphoreGive(s_conversation.mutex);
        return ESP_ERR_INVALID_STATE;
    }
    s_conversation.observer = observer;
    s_conversation.observer_context = context;
    xSemaphoreGive(s_conversation.mutex);
    return ESP_OK;
}

void conversation_service_get_snapshot(conversation_snapshot_t *snapshot)
{
    if (snapshot == NULL) return;
    memset(snapshot, 0, sizeof(*snapshot));
    if (s_conversation.mutex == NULL ||
        xSemaphoreTake(s_conversation.mutex, pdMS_TO_TICKS(250)) != pdTRUE) {
        return;
    }
    memcpy(snapshot, &s_conversation.snapshot, sizeof(*snapshot));
    xSemaphoreGive(s_conversation.mutex);
}

const char *conversation_service_stage_text(conversation_stage_t stage)
{
    static const char *const values[] = {
        "listening", "transcribing", "thinking", "completed", "failed", "cancelled",
    };
    return stage >= CONVERSATION_STAGE_LISTENING && stage <= CONVERSATION_STAGE_CANCELLED
               ? values[stage]
               : "invalid";
}

const char *conversation_service_local_stage_text(conversation_local_stage_t stage)
{
    static const char *const values[] = {
        "idle", "connecting", "prompting", "listening", "transcribing",
    };
    return stage >= CONVERSATION_LOCAL_STAGE_IDLE &&
                   stage <= CONVERSATION_LOCAL_STAGE_TRANSCRIBING
               ? values[stage]
               : "invalid";
}

const char *conversation_service_role_text(conversation_response_role_t role)
{
    static const char *const values[] = {"none", "human", "robot", "mixed", "system"};
    return role >= CONVERSATION_ROLE_NONE && role <= CONVERSATION_ROLE_SYSTEM
               ? values[role]
               : "invalid";
}

const char *conversation_service_execution_text(conversation_execution_status_t status)
{
    static const char *const values[] = {
        "pending", "completed", "failed", "unknown", "not_applicable",
    };
    return status >= CONVERSATION_EXECUTION_PENDING &&
                   status <= CONVERSATION_EXECUTION_NOT_APPLICABLE
               ? values[status]
               : "invalid";
}
