# p4home_host_test

Standalone ESP-IDF app for on-target Unity smoke tests.

Build (from this directory, with ESP-IDF v5.5.4 active):

```bash
idf.py set-target esp32p4
idf.py build flash monitor
```

Future work: add component tests that link `gateway_service` / `settings_service` with NVS mocks or run scenarios on hardware.
