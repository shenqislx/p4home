#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

typedef enum {
    GATEWAY_SERVICE_COMMAND_SYNC_STATE = 0,
    GATEWAY_SERVICE_COMMAND_SHOW_HOME = 1,
    GATEWAY_SERVICE_COMMAND_SHOW_SETTINGS = 2,
} gateway_service_command_type_t;

typedef struct {
    const char *board_name;
    const char *device_id;
    const char *hostname;
    const char *app_version;
    const char *capabilities;
} gateway_service_registration_t;

typedef struct {
    bool network_ready;
    bool display_ready;
    bool backlight_enabled;
    bool touch_ready;
    bool audio_busy;
    bool sr_ready;
    const char *active_page;
    const char *startup_page;
    const char *audio_owner;
    const char *voice_state;
} gateway_service_panel_state_t;

typedef struct {
    uint32_t id;
    gateway_service_command_type_t type;
    const char *type_text;
    char source[24];
    char argument[24];
} gateway_service_command_t;

typedef struct {
    bool ready;
    bool registered;
    bool state_synced;
    bool command_mailbox_ready;
    uint32_t registration_generation;
    uint32_t state_generation;
    const char *board_name;
    const char *device_id;
    const char *hostname;
    const char *app_version;
    const char *capabilities;
    bool network_ready;
    bool display_ready;
    bool backlight_enabled;
    bool touch_ready;
    bool audio_busy;
    bool sr_ready;
    const char *active_page;
    const char *startup_page;
    const char *audio_owner;
    const char *voice_state;
    const char *last_sync_reason;
    uint32_t pending_command_id;
    const char *pending_command_type;
    const char *pending_command_source;
    uint32_t last_command_id;
    const char *last_command_type;
    const char *last_command_status;
    const char *last_command_detail;
} gateway_service_snapshot_t;

esp_err_t gateway_service_init(void);
bool gateway_service_is_ready(void);
bool gateway_service_is_registered(void);
bool gateway_service_state_synced(void);
bool gateway_service_command_mailbox_ready(void);
esp_err_t gateway_service_register_device(const gateway_service_registration_t *registration);
esp_err_t gateway_service_publish_panel_state(const gateway_service_panel_state_t *state,
                                             const char *reason);
esp_err_t gateway_service_enqueue_command(gateway_service_command_type_t type,
                                         const char *source,
                                         const char *argument);
bool gateway_service_take_pending_command(gateway_service_command_t *command);
void gateway_service_complete_command(const gateway_service_command_t *command,
                                     bool success,
                                     const char *detail);
const char *gateway_service_command_type_text(gateway_service_command_type_t type);
void gateway_service_get_snapshot(gateway_service_snapshot_t *snapshot);
void gateway_service_log_summary(void);
