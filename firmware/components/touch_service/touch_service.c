#include "touch_service.h"

#include <stdio.h>
#include <string.h>

#include "bsp/esp32_p4_function_ev_board.h"
#include "bsp/touch.h"
#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_lcd_touch.h"
#include "esp_lcd_touch_gt911.h"
#include "esp_log.h"

static const char *TAG = "touch_service";
static const uint8_t GT911_ADDR_PRIMARY = ESP_LCD_TOUCH_IO_I2C_GT911_ADDRESS;
static const uint8_t GT911_ADDR_BACKUP = ESP_LCD_TOUCH_IO_I2C_GT911_ADDRESS_BACKUP;
static const uint16_t GT911_PRODUCT_ID_REG = 0x8140;
static const int I2C_XFER_TIMEOUT_MS = 50;

typedef struct {
    bool diagnostics_ran;
    bool i2c_ready;
    uint8_t devices_found;
    bool addr_5d_responded;
    bool addr_14_responded;
    bool gt911_detected;
    bool gt911_product_id_valid;
    bool bsp_touch_ready;
    uint8_t gt911_addr;
    char gt911_product_id[5];
} touch_diag_state_t;

static touch_diag_state_t s_state;

static esp_err_t touch_service_read_gt911_product_id(i2c_master_bus_handle_t bus,
                                                     uint8_t addr,
                                                     char out_product_id[5])
{
    const i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = 100000,
    };
    i2c_master_dev_handle_t dev_handle = NULL;
    uint8_t reg_buf[2] = {
        (uint8_t)(GT911_PRODUCT_ID_REG >> 8),
        (uint8_t)(GT911_PRODUCT_ID_REG & 0xFF),
    };
    uint8_t product_id[4] = {0};

    ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(bus, &dev_cfg, &dev_handle), TAG,
                        "failed to add temporary I2C device 0x%02x", addr);

    esp_err_t ret = i2c_master_transmit_receive(dev_handle,
                                                reg_buf,
                                                sizeof(reg_buf),
                                                product_id,
                                                sizeof(product_id),
                                                I2C_XFER_TIMEOUT_MS);
    i2c_master_bus_rm_device(dev_handle);
    ESP_RETURN_ON_ERROR(ret, TAG, "failed to read GT911 product id at 0x%02x", addr);

    memcpy(out_product_id, product_id, sizeof(product_id));
    out_product_id[4] = '\0';
    return ESP_OK;
}

static void touch_service_scan_bus(i2c_master_bus_handle_t bus)
{
    ESP_LOGI(TAG, "scanning BSP I2C bus on SDA=%d SCL=%d",
             BSP_I2C_SDA,
             BSP_I2C_SCL);

    for (uint8_t addr = 0x03; addr < 0x78; ++addr) {
        esp_err_t ret = i2c_master_probe(bus, addr, I2C_XFER_TIMEOUT_MS);
        if (ret == ESP_OK) {
            ++s_state.devices_found;
            ESP_LOGI(TAG, "i2c device responded at 0x%02x", addr);

            if (addr == GT911_ADDR_PRIMARY) {
                s_state.addr_5d_responded = true;
            } else if (addr == GT911_ADDR_BACKUP) {
                s_state.addr_14_responded = true;
            }
        }
    }
}

static void touch_service_attempt_gt911_probe(i2c_master_bus_handle_t bus, uint8_t addr)
{
    char product_id[5] = {0};
    esp_err_t ret = touch_service_read_gt911_product_id(bus, addr, product_id);
    if (ret == ESP_OK) {
        s_state.gt911_detected = true;
        s_state.gt911_product_id_valid = true;
        s_state.gt911_addr = addr;
        memcpy(s_state.gt911_product_id, product_id, sizeof(s_state.gt911_product_id));
        ESP_LOGI(TAG, "GT911 responded at 0x%02x with product_id=%s", addr, product_id);
        return;
    }

    ESP_LOGW(TAG, "device at 0x%02x responded to probe but GT911 product id read failed: %s",
             addr, esp_err_to_name(ret));
}

static void touch_service_attempt_bsp_touch_init(void)
{
    esp_lcd_touch_handle_t tp = NULL;
    esp_err_t ret = bsp_touch_new(NULL, &tp);
    if (ret == ESP_OK) {
        s_state.bsp_touch_ready = true;
        ESP_LOGI(TAG, "BSP touch init succeeded");
        if (tp != NULL) {
            bsp_touch_delete();
        }
        return;
    }

    ESP_LOGW(TAG, "BSP touch init failed: %s", esp_err_to_name(ret));
}

esp_err_t touch_service_run_diagnostics(void)
{
    if (s_state.diagnostics_ran) {
        ESP_LOGI(TAG, "touch diagnostics already completed");
        return ESP_OK;
    }

    memset(&s_state, 0, sizeof(s_state));
    s_state.gt911_addr = 0x00;
    strcpy(s_state.gt911_product_id, "n/a");

    ESP_RETURN_ON_ERROR(bsp_i2c_init(), TAG, "failed to init BSP I2C bus");
    s_state.i2c_ready = true;

    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    ESP_RETURN_ON_FALSE(bus != NULL, ESP_ERR_INVALID_STATE, TAG,
                        "BSP I2C handle unavailable");

    ESP_LOGI(TAG,
             "touch gpio assumptions: rst=%d int=%d; BSP 1024x600 path leaves both as NC, so GT911 address selection/reset is not actively driven",
             BSP_LCD_TOUCH_RST,
             BSP_LCD_TOUCH_INT);

    touch_service_scan_bus(bus);

    if (s_state.addr_5d_responded) {
        touch_service_attempt_gt911_probe(bus, GT911_ADDR_PRIMARY);
    }
    if (!s_state.gt911_detected && s_state.addr_14_responded) {
        touch_service_attempt_gt911_probe(bus, GT911_ADDR_BACKUP);
    }

    touch_service_attempt_bsp_touch_init();
    s_state.diagnostics_ran = true;
    touch_service_log_summary();
    return ESP_OK;
}

bool touch_service_gt911_detected(void)
{
    return s_state.gt911_detected;
}

bool touch_service_bsp_touch_ready(void)
{
    return s_state.bsp_touch_ready;
}

uint8_t touch_service_get_gt911_address(void)
{
    return s_state.gt911_addr;
}

void touch_service_log_summary(void)
{
    ESP_LOGI(TAG,
             "touch diagnostics ran=%s i2c_ready=%s devices_found=%u gt911_0x5d=%s gt911_0x14=%s gt911_detected=%s gt911_addr=%s product_id=%s bsp_touch_ready=%s",
             s_state.diagnostics_ran ? "yes" : "no",
             s_state.i2c_ready ? "yes" : "no",
             s_state.devices_found,
             s_state.addr_5d_responded ? "yes" : "no",
             s_state.addr_14_responded ? "yes" : "no",
             s_state.gt911_detected ? "yes" : "no",
             s_state.gt911_detected ? (s_state.gt911_addr == GT911_ADDR_PRIMARY ? "0x5d" : "0x14") : "n/a",
             s_state.gt911_product_id,
             s_state.bsp_touch_ready ? "yes" : "no");
}
