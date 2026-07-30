#pragma once

/* Host shim for the ESP_RETURN_ON_* macro family. Same control flow as ESP-IDF
 * so the firmware sources compile unmodified. */

#include "esp_err.h"
#include "esp_log.h"

#define ESP_RETURN_ON_ERROR(x, tag, format, ...)                    \
    do {                                                            \
        esp_err_t err_rc_ = (x);                                    \
        if (err_rc_ != ESP_OK) {                                    \
            ESP_LOGE(tag, format, ##__VA_ARGS__);                   \
            return err_rc_;                                         \
        }                                                           \
    } while (0)

#define ESP_RETURN_ON_FALSE(a, err_code, tag, format, ...)          \
    do {                                                            \
        if (!(a)) {                                                 \
            ESP_LOGE(tag, format, ##__VA_ARGS__);                   \
            return err_code;                                        \
        }                                                           \
    } while (0)

#define ESP_GOTO_ON_ERROR(x, goto_tag, tag, format, ...)            \
    do {                                                            \
        esp_err_t err_rc_ = (x);                                    \
        if (err_rc_ != ESP_OK) {                                    \
            ret = err_rc_;                                          \
            ESP_LOGE(tag, format, ##__VA_ARGS__);                   \
            goto goto_tag;                                          \
        }                                                           \
    } while (0)

#define ESP_GOTO_ON_FALSE(a, err_code, goto_tag, tag, format, ...)  \
    do {                                                            \
        if (!(a)) {                                                 \
            ret = err_code;                                         \
            ESP_LOGE(tag, format, ##__VA_ARGS__);                   \
            goto goto_tag;                                          \
        }                                                           \
    } while (0)

#define ESP_ERROR_CHECK(x) (void)(x)
