from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
UI_COMPONENT = ROOT / "firmware" / "components" / "ui_pages"


class FirmwareUiAsyncSafetyContract(unittest.TestCase):
    def test_every_ui_async_submission_uses_the_bsp_display_mutex(self) -> None:
        helper = (UI_COMPONENT / "ui_async.c").read_text()
        self.assertLess(helper.index("bsp_display_lock(0)"), helper.index("lv_async_call("))
        self.assertLess(helper.index("lv_async_call("), helper.index("bsp_display_unlock()"))
        self.assertIn("if (result != LV_RESULT_OK)", helper)
        self.assertLess(helper.index("callback(user_data)"), helper.index("bsp_display_unlock()"))
        self.assertIn('"ui_async.c"', (UI_COMPONENT / "CMakeLists.txt").read_text())

        direct_callers = []
        for source in UI_COMPONENT.rglob("*.c"):
            if source.name != "ui_async.c" and "lv_async_call(" in source.read_text():
                direct_callers.append(str(source.relative_to(ROOT)))
        self.assertEqual([], direct_callers)

    def test_initial_rest_snapshot_cannot_delay_websocket_subscription(self) -> None:
        source = (ROOT / "firmware" / "components" / "ha_client" / "ha_client.c").read_text()
        worker = source[source.index("static void ha_client_worker") :]

        start_socket = worker.index("ha_client_start_socket(")
        subscription_ready = worker.index("HA_CLIENT_SUB_READY_BIT", start_socket)
        initial_snapshot = worker.index("ha_client_fetch_initial_states(", subscription_ready)
        self.assertLess(start_socket, subscription_ready)
        self.assertLess(subscription_ready, initial_snapshot)
        self.assertEqual(1, worker.count("ha_client_fetch_initial_states("))

    def test_rejected_or_timed_out_subscription_never_becomes_ready(self) -> None:
        source = (ROOT / "firmware" / "components" / "ha_client" / "ha_client.c").read_text()
        handler = source[source.index("static void ha_client_handle_result") : source.index("static void ha_client_handle_event")]
        subscribe = handler[handler.index("if (pending_type == HA_PENDING_SUBSCRIBE)") : handler.index("if (pending_type == HA_PENDING_GET_STATES)")]
        worker = source[source.index("static void ha_client_worker") :]

        self.assertIn('cJSON_IsTrue(success)', subscribe)
        self.assertIn('ha_client_set_error_locked("subscribe_failed")', subscribe)
        self.assertIn("HA_CLIENT_SUB_FAILED_BIT", subscribe)
        self.assertIn("HA_CLIENT_SUB_READY_BIT |\n                                                                   HA_CLIENT_SUB_FAILED_BIT", worker)
        self.assertIn('"subscribe_timeout"', worker)

    def test_async_card_workers_hold_context_references_until_result_consumption(self) -> None:
        for name in ("ui_card_action.c", "ui_card_binary.c", "ui_card_climate.c"):
            source = (UI_COMPONENT / "cards" / name).read_text()
            with self.subTest(source=name):
                self.assertIn("atomic_uint references", source)
                self.assertIn("atomic_fetch_add_explicit", source)
                self.assertIn("atomic_fetch_sub_explicit", source)
                self.assertRegex(source, r"deleted = true;\s+ui_card_\w+_release\(ctx\);")
                self.assertRegex(source, r"ui_async_call\([\s\S]+ui_card_\w+_release\(ctx\);")

    def test_control_workers_reuse_preallocated_task_payload_for_results(self) -> None:
        sources = [
            UI_COMPONENT / "cards" / "ui_card_action.c",
            UI_COMPONENT / "cards" / "ui_card_binary.c",
            UI_COMPONENT / "cards" / "ui_card_climate.c",
            UI_COMPONENT / "ui_page_quick_modes.c",
        ]
        for path in sources:
            source = path.read_text()
            with self.subTest(source=path.name):
                self.assertIn("task_arg->result = ha_client_", source)
                self.assertNotRegex(source, r"result\s*=\s*calloc")


if __name__ == "__main__":
    unittest.main()
