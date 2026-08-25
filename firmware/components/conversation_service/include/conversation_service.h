#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define CONVERSATION_UI_PROTOCOL_VERSION 1U
#define CONVERSATION_UI_SESSION_ID_HEX_BYTES 32U
#define CONVERSATION_UI_USER_TEXT_MAX_CHARS 256U
#define CONVERSATION_UI_USER_TEXT_MAX_BYTES 1024U
#define CONVERSATION_UI_RESPONSE_TEXT_MAX_CHARS 512U
#define CONVERSATION_UI_RESPONSE_TEXT_MAX_BYTES 2048U
#define CONVERSATION_UI_DIALOG_TEXT_MAX_BYTES 3136U

typedef enum {
    CONVERSATION_STAGE_LISTENING = 0,
    CONVERSATION_STAGE_TRANSCRIBING,
    CONVERSATION_STAGE_THINKING,
    CONVERSATION_STAGE_COMPLETED,
    CONVERSATION_STAGE_FAILED,
    CONVERSATION_STAGE_CANCELLED,
} conversation_stage_t;

typedef enum {
    CONVERSATION_ROLE_NONE = 0,
    CONVERSATION_ROLE_HUMAN,
    CONVERSATION_ROLE_ROBOT,
    CONVERSATION_ROLE_MIXED,
    CONVERSATION_ROLE_SYSTEM,
} conversation_response_role_t;

typedef enum {
    CONVERSATION_EXECUTION_PENDING = 0,
    CONVERSATION_EXECUTION_COMPLETED,
    CONVERSATION_EXECUTION_FAILED,
    CONVERSATION_EXECUTION_UNKNOWN,
    CONVERSATION_EXECUTION_NOT_APPLICABLE,
} conversation_execution_status_t;

typedef struct {
    char session_id[CONVERSATION_UI_SESSION_ID_HEX_BYTES + 1U];
    uint32_t stream_id;
    uint32_t epoch;
    uint32_t revision;
    conversation_stage_t stage;
    char user_text[CONVERSATION_UI_USER_TEXT_MAX_BYTES + 1U];
    char response_text[CONVERSATION_UI_RESPONSE_TEXT_MAX_BYTES + 1U];
    conversation_response_role_t response_role;
    conversation_execution_status_t execution_status;
} conversation_update_t;

typedef struct {
    bool initialized;
    bool available;
    conversation_update_t update;
    uint32_t updates_applied;
    uint32_t stale_updates_rejected;
} conversation_snapshot_t;

typedef void (*conversation_observer_fn)(void *context);
typedef void (*conversation_rendered_fn)(const conversation_update_t *update, void *context);

esp_err_t conversation_service_init(void);
esp_err_t conversation_service_apply(const conversation_update_t *update);
esp_err_t conversation_service_add_observer(conversation_observer_fn observer, void *context);
esp_err_t conversation_service_set_rendered_observer(conversation_rendered_fn observer,
                                                     void *context);
esp_err_t conversation_service_mark_rendered(const conversation_update_t *update);
void conversation_service_get_snapshot(conversation_snapshot_t *snapshot);
const char *conversation_service_stage_text(conversation_stage_t stage);
const char *conversation_service_role_text(conversation_response_role_t role);
const char *conversation_service_execution_text(conversation_execution_status_t status);
