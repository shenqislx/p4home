#pragma once

/* Host shim for the Kconfig symbols the UI layer reads. Values mirror
 * firmware/sdkconfig.defaults so the simulated layout matches the device. */

#define CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT 36
#define CONFIG_P4HOME_UI_STATUS_BANNER_ENABLE_IP_SUFFIX 1
#define CONFIG_P4HOME_DASHBOARD_COLUMNS 3
#define CONFIG_P4HOME_DASHBOARD_DEFAULT_PAGE ""
#define CONFIG_P4HOME_DASHBOARD_STALE_VISUAL 1
#define CONFIG_P4HOME_UI_PIXEL_CRT_OVERLAY 1
#define CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES 48
