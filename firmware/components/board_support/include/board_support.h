#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

esp_err_t board_support_init(void);
const char *board_support_get_name(void);
void board_support_log_summary(void);
bool board_support_display_ready(void);
bool board_support_display_backlight_enabled(void);
bool board_support_network_ready(void);
bool board_support_network_stack_ready(void);
bool board_support_network_event_loop_ready(void);
bool board_support_network_sta_netif_ready(void);
const char *board_support_network_hostname(void);
const char *board_support_network_device_id(void);
const char *board_support_network_mac_text(void);
bool board_support_settings_ready(void);
uint32_t board_support_boot_count(void);
const char *board_support_startup_page_text(void);
bool board_support_touch_ready(void);
bool board_support_touch_detected(void);
bool board_support_touch_indev_ready(void);
bool board_support_audio_speaker_ready(void);
bool board_support_audio_microphone_ready(void);
bool board_support_audio_tone_played(void);
bool board_support_audio_microphone_capture_ready(void);
bool board_support_audio_busy(void);
const char *board_support_audio_owner_text(void);
bool board_support_gateway_ready(void);
bool board_support_gateway_registered(void);
bool board_support_gateway_state_synced(void);
bool board_support_gateway_command_mailbox_ready(void);
bool board_support_gateway_command_selftest_passed(void);
const char *board_support_gateway_last_sync_reason(void);
const char *board_support_gateway_last_command_type_text(void);
const char *board_support_gateway_last_command_status_text(void);
esp_err_t board_support_gateway_publish_state(const char *reason);
esp_err_t board_support_gateway_process_pending_command(void);
bool board_support_sr_dependency_declared(void);
bool board_support_sr_models_available(void);
unsigned int board_support_sr_model_count(void);
bool board_support_sr_afe_config_ready(void);
bool board_support_sr_afe_ready(void);
bool board_support_sr_afe_runtime_ready(void);
bool board_support_sr_runtime_loop_started(void);
bool board_support_sr_runtime_loop_active(void);
bool board_support_sr_wake_state_machine_started(void);
bool board_support_sr_command_model_ready(void);
bool board_support_sr_command_set_ready(void);
const char *board_support_sr_voice_state_text(void);
const char *board_support_sr_command_text(void);
const char *board_support_sr_status_text(void);
