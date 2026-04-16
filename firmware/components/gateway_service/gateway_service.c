#include "gateway_service.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

static const char *TAG = "gateway_service";

static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;

typedef struct {
    bool initialized;
    bool registered;
    bool state_synced;
    bool command_mailbox_ready;
    uint32_t registration_generation;
    uint32_t state_generation;
    char board_name[48];
    char device_id[24];
    char hostname[32];
    char app_version[32];
    char capabilities[96];
    bool network_ready;
    bool display_ready;
    bool backlight_enabled;
    bool touch_ready;
    bool audio_busy;
    bool sr_ready;
    char active_page[16];
    char startup_page[16];
    char audio_owner[24];
    char voice_state[24];
    char last_sync_reason[32];
    bool pending_command_valid;
    uint32_t pending_command_id;
    gateway_service_command_type_t pending_command_type;
    char pending_command_source[24];
    char pending_command_argument[24];
    uint32_t next_command_id;
    uint32_t last_command_id;
    gateway_service_command_type_t last_command_type;
    char last_command_status[16];
    char last_command_detail[64];
} gateway_service_state_t;

static gateway_service_state_t s_state;

static const char *gateway_service_safe_text(const char *value, const char *fallback)
{
    return (value != NULL && value[0] != '\0') ? value : fallback;
}

static void gateway_service_copy_text(char *destination, size_t destination_size, const char *source)
{
    if (destination == NULL || destination_size == 0U) {
        return;
    }

    snprintf(destination, destination_size, "%s", gateway_service_safe_text(source, "unset"));
}

/** Caller must hold `s_state_lock` (taskENTER_CRITICAL). */
static bool gateway_service_state_matches_locked(const gateway_service_panel_state_t *state, const char *reason)
{
    return s_state.network_ready == state->network_ready
           && s_state.display_ready == state->display_ready
           && s_state.backlight_enabled == state->backlight_enabled
           && s_state.touch_ready == state->touch_ready
           && s_state.audio_busy == state->audio_busy
           && s_state.sr_ready == state->sr_ready
           && strcmp(s_state.active_page, gateway_service_safe_text(state->active_page, "unset")) == 0
           && strcmp(s_state.startup_page, gateway_service_safe_text(state->startup_page, "unset")) == 0
           && strcmp(s_state.audio_owner, gateway_service_safe_text(state->audio_owner, "unset")) == 0
           && strcmp(s_state.voice_state, gateway_service_safe_text(state->voice_state, "unset")) == 0
           && strcmp(s_state.last_sync_reason, gateway_service_safe_text(reason, "unset")) == 0;
}

const char *gateway_service_command_type_text(gateway_service_command_type_t type)
{
    switch (type) {
    case GATEWAY_SERVICE_COMMAND_SYNC_STATE:
        return "sync_state";
    case GATEWAY_SERVICE_COMMAND_SHOW_HOME:
        return "show_home";
    case GATEWAY_SERVICE_COMMAND_SHOW_SETTINGS:
        return "show_settings";
    default:
        return "unknown";
    }
}

esp_err_t gateway_service_init(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    if (s_state.initialized) {
        taskEXIT_CRITICAL(&s_state_lock);
        ESP_LOGI(TAG, "gateway service already initialized");
        return ESP_OK;
    }

    memset(&s_state, 0, sizeof(s_state));
    gateway_service_copy_text(s_state.last_sync_reason, sizeof(s_state.last_sync_reason), "none");
    gateway_service_copy_text(s_state.last_command_status, sizeof(s_state.last_command_status), "none");
    gateway_service_copy_text(s_state.last_command_detail, sizeof(s_state.last_command_detail), "none");
    s_state.command_mailbox_ready = true;
    s_state.next_command_id = 1U;
    s_state.initialized = true;
    taskEXIT_CRITICAL(&s_state_lock);

    ESP_LOGI(TAG, "gateway service ready");
    return ESP_OK;
}

bool gateway_service_is_ready(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    bool ready = s_state.initialized;
    taskEXIT_CRITICAL(&s_state_lock);
    return ready;
}

bool gateway_service_is_registered(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    bool registered = s_state.registered;
    taskEXIT_CRITICAL(&s_state_lock);
    return registered;
}

bool gateway_service_state_synced(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    bool synced = s_state.state_synced;
    taskEXIT_CRITICAL(&s_state_lock);
    return synced;
}

bool gateway_service_command_mailbox_ready(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    bool mailbox = s_state.command_mailbox_ready;
    taskEXIT_CRITICAL(&s_state_lock);
    return mailbox;
}

esp_err_t gateway_service_register_device(const gateway_service_registration_t *registration)
{
    ESP_RETURN_ON_FALSE(registration != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "registration is required");

    taskENTER_CRITICAL(&s_state_lock);
    if (!s_state.initialized) {
        taskEXIT_CRITICAL(&s_state_lock);
        ESP_LOGE(TAG, "gateway service not initialized");
        return ESP_ERR_INVALID_STATE;
    }

    gateway_service_copy_text(s_state.board_name, sizeof(s_state.board_name), registration->board_name);
    gateway_service_copy_text(s_state.device_id, sizeof(s_state.device_id), registration->device_id);
    gateway_service_copy_text(s_state.hostname, sizeof(s_state.hostname), registration->hostname);
    gateway_service_copy_text(s_state.app_version, sizeof(s_state.app_version), registration->app_version);
    gateway_service_copy_text(s_state.capabilities, sizeof(s_state.capabilities), registration->capabilities);

    s_state.registered = true;
    s_state.registration_generation++;

    uint32_t gen = s_state.registration_generation;
    char device_id_copy[sizeof(s_state.device_id)];
    char hostname_copy[sizeof(s_state.hostname)];
    char capabilities_copy[sizeof(s_state.capabilities)];
    memcpy(device_id_copy, s_state.device_id, sizeof(device_id_copy));
    memcpy(hostname_copy, s_state.hostname, sizeof(hostname_copy));
    memcpy(capabilities_copy, s_state.capabilities, sizeof(capabilities_copy));
    taskEXIT_CRITICAL(&s_state_lock);

    ESP_LOGI(TAG,
             "device registered gen=%" PRIu32 " device_id=%s hostname=%s capabilities=%s",
             gen,
             device_id_copy,
             hostname_copy,
             capabilities_copy);
    return ESP_OK;
}

esp_err_t gateway_service_publish_panel_state(const gateway_service_panel_state_t *state,
                                             const char *reason)
{
    ESP_RETURN_ON_FALSE(state != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "panel state is required");

    taskENTER_CRITICAL(&s_state_lock);
    if (!s_state.initialized) {
        taskEXIT_CRITICAL(&s_state_lock);
        ESP_LOGE(TAG, "gateway service not initialized");
        return ESP_ERR_INVALID_STATE;
    }

    if (s_state.state_synced && gateway_service_state_matches_locked(state, reason)) {
        taskEXIT_CRITICAL(&s_state_lock);
        return ESP_OK;
    }

    s_state.network_ready = state->network_ready;
    s_state.display_ready = state->display_ready;
    s_state.backlight_enabled = state->backlight_enabled;
    s_state.touch_ready = state->touch_ready;
    s_state.audio_busy = state->audio_busy;
    s_state.sr_ready = state->sr_ready;
    gateway_service_copy_text(s_state.active_page, sizeof(s_state.active_page), state->active_page);
    gateway_service_copy_text(s_state.startup_page, sizeof(s_state.startup_page), state->startup_page);
    gateway_service_copy_text(s_state.audio_owner, sizeof(s_state.audio_owner), state->audio_owner);
    gateway_service_copy_text(s_state.voice_state, sizeof(s_state.voice_state), state->voice_state);
    gateway_service_copy_text(s_state.last_sync_reason, sizeof(s_state.last_sync_reason), reason);

    s_state.state_synced = true;
    s_state.state_generation++;

    uint32_t gen = s_state.state_generation;
    char last_reason[sizeof(s_state.last_sync_reason)];
    char active[sizeof(s_state.active_page)];
    char startup[sizeof(s_state.startup_page)];
    memcpy(last_reason, s_state.last_sync_reason, sizeof(last_reason));
    memcpy(active, s_state.active_page, sizeof(active));
    memcpy(startup, s_state.startup_page, sizeof(startup));
    bool net = s_state.network_ready;
    bool disp = s_state.display_ready;
    bool touch = s_state.touch_ready;
    bool bl = s_state.backlight_enabled;
    bool audio = s_state.audio_busy;
    char voice[sizeof(s_state.voice_state)];
    memcpy(voice, s_state.voice_state, sizeof(voice));
    taskEXIT_CRITICAL(&s_state_lock);

    ESP_LOGI(TAG,
             "state synced gen=%" PRIu32 " reason=%s page=%s startup=%s network=%s display=%s touch=%s backlight=%s audio_busy=%s voice=%s",
             gen,
             last_reason,
             active,
             startup,
             net ? "yes" : "no",
             disp ? "yes" : "no",
             touch ? "yes" : "no",
             bl ? "on" : "off",
             audio ? "yes" : "no",
             voice);
    return ESP_OK;
}

esp_err_t gateway_service_enqueue_command(gateway_service_command_type_t type,
                                         const char *source,
                                         const char *argument)
{
    taskENTER_CRITICAL(&s_state_lock);
    if (!s_state.initialized) {
        taskEXIT_CRITICAL(&s_state_lock);
        ESP_LOGE(TAG, "gateway service not initialized");
        return ESP_ERR_INVALID_STATE;
    }
    if (!s_state.command_mailbox_ready) {
        taskEXIT_CRITICAL(&s_state_lock);
        ESP_LOGE(TAG, "command mailbox unavailable");
        return ESP_ERR_INVALID_STATE;
    }
    if (s_state.pending_command_valid) {
        taskEXIT_CRITICAL(&s_state_lock);
        ESP_LOGE(TAG, "command mailbox already has a pending command");
        return ESP_ERR_INVALID_STATE;
    }

    s_state.pending_command_id = s_state.next_command_id++;
    s_state.pending_command_type = type;
    gateway_service_copy_text(s_state.pending_command_source,
                              sizeof(s_state.pending_command_source),
                              source);
    gateway_service_copy_text(s_state.pending_command_argument,
                              sizeof(s_state.pending_command_argument),
                              argument);
    s_state.pending_command_valid = true;

    uint32_t cmd_id = s_state.pending_command_id;
    char src_copy[sizeof(s_state.pending_command_source)];
    char arg_copy[sizeof(s_state.pending_command_argument)];
    memcpy(src_copy, s_state.pending_command_source, sizeof(src_copy));
    memcpy(arg_copy, s_state.pending_command_argument, sizeof(arg_copy));
    taskEXIT_CRITICAL(&s_state_lock);

    ESP_LOGI(TAG, "command queued id=%" PRIu32 " type=%s source=%s arg=%s",
             cmd_id,
             gateway_service_command_type_text(type),
             src_copy,
             arg_copy);
    return ESP_OK;
}

bool gateway_service_take_pending_command(gateway_service_command_t *command)
{
    if (command == NULL) {
        return false;
    }

    taskENTER_CRITICAL(&s_state_lock);
    if (!s_state.pending_command_valid) {
        taskEXIT_CRITICAL(&s_state_lock);
        return false;
    }

    memset(command, 0, sizeof(*command));
    command->id = s_state.pending_command_id;
    command->type = s_state.pending_command_type;
    command->type_text = gateway_service_command_type_text(s_state.pending_command_type);
    snprintf(command->source, sizeof(command->source), "%s", s_state.pending_command_source);
    snprintf(command->argument, sizeof(command->argument), "%s", s_state.pending_command_argument);

    s_state.pending_command_valid = false;
    s_state.pending_command_id = 0;
    s_state.pending_command_type = GATEWAY_SERVICE_COMMAND_SYNC_STATE;
    gateway_service_copy_text(s_state.pending_command_source, sizeof(s_state.pending_command_source), "none");
    gateway_service_copy_text(s_state.pending_command_argument, sizeof(s_state.pending_command_argument), "none");
    taskEXIT_CRITICAL(&s_state_lock);
    return true;
}

void gateway_service_complete_command(const gateway_service_command_t *command,
                                     bool success,
                                     const char *detail)
{
    if (command == NULL) {
        return;
    }

    taskENTER_CRITICAL(&s_state_lock);
    s_state.last_command_id = command->id;
    s_state.last_command_type = command->type;
    gateway_service_copy_text(s_state.last_command_status,
                              sizeof(s_state.last_command_status),
                              success ? "applied" : "failed");
    gateway_service_copy_text(s_state.last_command_detail,
                              sizeof(s_state.last_command_detail),
                              detail);

    uint32_t last_id = s_state.last_command_id;
    gateway_service_command_type_t last_type = s_state.last_command_type;
    char status_copy[sizeof(s_state.last_command_status)];
    char detail_copy[sizeof(s_state.last_command_detail)];
    memcpy(status_copy, s_state.last_command_status, sizeof(status_copy));
    memcpy(detail_copy, s_state.last_command_detail, sizeof(detail_copy));
    taskEXIT_CRITICAL(&s_state_lock);

    ESP_LOGI(TAG, "command complete id=%" PRIu32 " type=%s status=%s detail=%s",
             last_id,
             gateway_service_command_type_text(last_type),
             status_copy,
             detail_copy);
}

void gateway_service_get_snapshot(gateway_service_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }

    taskENTER_CRITICAL(&s_state_lock);
    memset(snapshot, 0, sizeof(*snapshot));
    snapshot->ready = s_state.initialized;
    snapshot->registered = s_state.registered;
    snapshot->state_synced = s_state.state_synced;
    snapshot->command_mailbox_ready = s_state.command_mailbox_ready;
    snapshot->registration_generation = s_state.registration_generation;
    snapshot->state_generation = s_state.state_generation;
    snapshot->board_name = gateway_service_safe_text(s_state.board_name, "unset");
    snapshot->device_id = gateway_service_safe_text(s_state.device_id, "unset");
    snapshot->hostname = gateway_service_safe_text(s_state.hostname, "unset");
    snapshot->app_version = gateway_service_safe_text(s_state.app_version, "unset");
    snapshot->capabilities = gateway_service_safe_text(s_state.capabilities, "unset");
    snapshot->network_ready = s_state.network_ready;
    snapshot->display_ready = s_state.display_ready;
    snapshot->backlight_enabled = s_state.backlight_enabled;
    snapshot->touch_ready = s_state.touch_ready;
    snapshot->audio_busy = s_state.audio_busy;
    snapshot->sr_ready = s_state.sr_ready;
    snapshot->active_page = gateway_service_safe_text(s_state.active_page, "unset");
    snapshot->startup_page = gateway_service_safe_text(s_state.startup_page, "unset");
    snapshot->audio_owner = gateway_service_safe_text(s_state.audio_owner, "unset");
    snapshot->voice_state = gateway_service_safe_text(s_state.voice_state, "unset");
    snapshot->last_sync_reason = gateway_service_safe_text(s_state.last_sync_reason, "none");
    snapshot->pending_command_id = s_state.pending_command_valid ? s_state.pending_command_id : 0U;
    snapshot->pending_command_type = s_state.pending_command_valid
                                         ? gateway_service_command_type_text(s_state.pending_command_type)
                                         : "none";
    snapshot->pending_command_source = s_state.pending_command_valid
                                           ? gateway_service_safe_text(s_state.pending_command_source, "unset")
                                           : "none";
    snapshot->last_command_id = s_state.last_command_id;
    snapshot->last_command_type = s_state.last_command_id != 0U
                                      ? gateway_service_command_type_text(s_state.last_command_type)
                                      : "none";
    snapshot->last_command_status = gateway_service_safe_text(s_state.last_command_status, "none");
    snapshot->last_command_detail = gateway_service_safe_text(s_state.last_command_detail, "none");
    taskEXIT_CRITICAL(&s_state_lock);
}

void gateway_service_log_summary(void)
{
    gateway_service_snapshot_t snapshot = {0};
    gateway_service_get_snapshot(&snapshot);

    ESP_LOGI(TAG,
             "gateway ready=%s registered=%s state_synced=%s command_mailbox=%s device_id=%s hostname=%s page=%s startup=%s pending=%s last_command=%s/%s",
             snapshot.ready ? "yes" : "no",
             snapshot.registered ? "yes" : "no",
             snapshot.state_synced ? "yes" : "no",
             snapshot.command_mailbox_ready ? "yes" : "no",
             snapshot.device_id,
             snapshot.hostname,
             snapshot.active_page,
             snapshot.startup_page,
             snapshot.pending_command_type,
             snapshot.last_command_type,
             snapshot.last_command_status);
}
