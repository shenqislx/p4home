from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class Phase4CHaHardwareGateContractTests(unittest.TestCase):
    def test_workflow_runs_robot_gate_only_after_p4_subscription(self) -> None:
        workflow = (
            ROOT / ".github/workflows/firmware-self-hosted-flash-serial.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("- phase4c_ha", workflow)
        self.assertIn('profile == "phase4c_ha" and seconds < 120', workflow)
        self.assertIn("Prepare Phase 4C HA profile", workflow)
        self.assertIn("robot-ha.token", workflow)
        self.assertIn("robot-ha-policy.json", workflow)
        self.assertIn("robot-ha.url", workflow)
        self.assertIn("CONFIG_P4HOME_PHASE4C_VALIDATION=y", workflow)
        self.assertIn("Validate Robot while P4 application is offline", workflow)
        self.assertIn("--after no_reset", workflow)
        self.assertIn("PHASE4C_OFFLINE_RESULT_FILE", workflow)
        self.assertIn("PHASE4C_POST_ROBOT_OFFSET_FILE", workflow)
        self.assertIn("PHASE4C_RAW_MONITOR_LOG", workflow)
        self.assertIn("Sanitize Phase 4C serial artifact", workflow)
        self.assertEqual(workflow.count('PNPM_BIN="$(command -v pnpm || true)"'), 2)
        self.assertEqual(workflow.count("-x /opt/homebrew/bin/pnpm"), 2)
        self.assertEqual(
            workflow.count('test "$("$PNPM_BIN" --version)" = "11.19.0"'),
            2,
        )
        self.assertEqual(workflow.count('"$PNPM_BIN" install --frozen-lockfile'), 2)
        self.assertNotIn("corepack enable", workflow)
        self.assertNotIn("npx --yes pnpm", workflow)
        self.assertIn('test "$("$phase4c_node_bin" --version)" = "v24.19.0"', workflow)
        self.assertIn('echo "PHASE4C_NODE_BIN=$phase4c_node_bin" >> "$GITHUB_ENV"', workflow)
        self.assertEqual(
            workflow.count(
                '"$PHASE4C_NODE_BIN" --import tsx apps/runtime/src/phase4c-ha-gate.ts'
            ),
            2,
        )
        self.assertIn("scripts/prepare-phase4c-ha-profile.py", workflow)
        self.assertIn("--panel-entities firmware/components/panel_data_store/panel_entities.json", workflow)
        self.assertIn("scripts/sanitize-phase4c-monitor.py", workflow)
        self.assertIn("phase4c_policy_binding_verified", workflow)
        self.assertIn("phase4c_post_robot_p4_standalone", workflow)
        self.assertIn("phase4c_post_robot_ui_8fps", workflow)
        self.assertIn("phase4c_agent_transport_disabled", workflow)
        self.assertIn('chmod 400 "$FROZEN_ROBOT_TOKEN_FILE" "$FROZEN_ROBOT_POLICY_FILE"', workflow)
        self.assertIn('P4HOME_PHASE4C_POLICY_FILE=$FROZEN_ROBOT_POLICY_FILE', workflow)
        self.assertIn('CAPTURE_SECONDS=$((MONITOR_SECONDS + 180))', workflow)
        self.assertIn('post_robot_started_at=$SECONDS', workflow)
        self.assertIn('test "$((SECONDS - post_robot_started_at))" -ge 60', workflow)
        self.assertIn(
            'if [[ "${{ inputs.validation_profile }}" == "phase2d_agent" ||',
            workflow,
        )
        append = workflow.index("Append Agent harness evidence")
        sanitize = workflow.index("Sanitize Phase 4C serial artifact")
        manifest = workflow.index("Write hardware validation manifest")
        self.assertLess(append, sanitize)
        self.assertLess(sanitize, manifest)
        subscribed = workflow.index(
            'grep -q "VERIFY:phase4c:p4_standalone:PASS"'
        )
        gate = workflow.rindex("apps/runtime/src/phase4c-ha-gate.ts")
        self.assertLess(subscribed, gate)
        self.assertNotIn('test "$gate_exit_code" = "0"', workflow)
        self.assertIn('if: always() && inputs.validation_profile != \'generic\'', workflow)
        self.assertIn('"phase4c_validation_enabled": phase4c_validation_enabled', workflow)
        build = workflow.index("- name: Build firmware")
        runtime_harness = workflow.index("- name: Start Agent Runtime harness")
        install = workflow.index("- name: Install Phase 4C gate dependencies")
        offline = workflow.index("- name: Validate Robot while P4 application is offline")
        flash = workflow.index("- name: Flash firmware and capture serial")
        build_section = workflow[build:flash]
        runtime_harness_section = workflow[runtime_harness:install]
        install_section = workflow[install:offline]
        offline_section = workflow[offline:flash]
        flash_section = workflow[flash:append]
        self.assertNotIn('monitor_log="firmware/monitor.log"', build_section)
        self.assertNotIn("PHASE4C_NODE_BIN", runtime_harness_section)
        self.assertIn('echo "PHASE4C_NODE_BIN=$phase4c_node_bin"', install_section)
        self.assertNotIn("shell: zsh {0}", offline_section)
        self.assertNotIn(
            'if [[ "${{ inputs.validation_profile }}" != "generic" ]]; then',
            build_section,
        )
        monitor_init = flash_section.index('monitor_log="firmware/monitor.log"')
        flash_redirect = flash_section.index('flash > "$monitor_log"')
        self.assertLess(monitor_init, flash_redirect)
        phase4c_capture = flash_section.index('--seconds "$CAPTURE_SECONDS"')
        capture_wait = flash_section.index('wait "$capture_pid"')
        self.assertLess(phase4c_capture, capture_wait)
        self.assertNotIn('--seconds 60', flash_section)

    def test_firmware_marker_is_gated_and_target_specific(self) -> None:
        kconfig = (
            ROOT / "firmware/components/panel_data_store/Kconfig.projbuild"
        ).read_text(encoding="utf-8")
        store = (
            ROOT / "firmware/components/panel_data_store/panel_data_store.c"
        ).read_text(encoding="utf-8")
        defaults = (ROOT / "firmware/sdkconfig.defaults").read_text(encoding="utf-8")
        self.assertIn("config P4HOME_PHASE4C_VALIDATION", kconfig)
        self.assertIn("config P4HOME_PHASE4C_VALIDATION_ENTITY_ID", kconfig)
        self.assertIn('default ""', kconfig)
        self.assertIn("CONFIG_P4HOME_PHASE4C_VALIDATION=n", defaults)
        self.assertIn("#if CONFIG_P4HOME_PHASE4C_VALIDATION", store)
        self.assertIn("CONFIG_P4HOME_PHASE4C_VALIDATION_ENTITY_ID", store)
        self.assertIn("sensor.available", store)
        self.assertIn("strcmp(sensor.value_text, change->state_text) != 0", store)
        self.assertIn("VERIFY:phase4c:p4_ha_state:PASS state=%s", store)
        main = (ROOT / "firmware/main/app_main.c").read_text(encoding="utf-8")
        self.assertIn('log_verify_marker("phase4c", "p4_standalone"', main)
        self.assertIn(
            "board_support_ha_ready() && board_support_ha_subscription_ready()",
            main,
        )
        self.assertIn("!agent_snapshot.enabled && !agent_snapshot.connected", main)

    def test_robot_gate_is_non_admin_allowlisted_and_restores_state(self) -> None:
        gate = (
            ROOT / "agent/apps/runtime/src/phase4c-ha-gate.ts"
        ).read_text(encoding="utf-8")
        core = (
            ROOT / "agent/apps/runtime/src/phase4c-ha-gate-core.ts"
        ).read_text(encoding="utf-8")
        identity = (
            ROOT / "agent/apps/runtime/src/phase4c-ha-identity.ts"
        ).read_text(encoding="utf-8")
        self.assertIn('requiredEnv("AGENT_HARNESS_RESULT_FILE")', gate)
        self.assertNotIn('requiredEnv("P4HOME_HARNESS_RESULT_FILE")', gate)
        self.assertIn('type: "auth/current_user"', identity)
        self.assertIn("const attempts = options.attempts ?? 3", identity)
        self.assertIn('reason === "identity_transport"', identity)
        self.assertIn('reason === "identity_timeout"', identity)
        self.assertIn('socket.on("error", ignoreLateError)', identity)
        self.assertIn('socket.once("close", complete)', identity)
        self.assertIn("safeFailureReason(error, reason)", gate)
        self.assertIn("identity.is_admin === false && identity.is_owner === false", gate)
        self.assertIn('typeof record.is_admin !== "boolean"', core)
        self.assertIn('typeof record.is_owner !== "boolean"', core)
        self.assertIn("policyEntities !== 1", gate)
        self.assertIn('entity?.alias !== ALIAS', gate)
        self.assertIn('entity.write_actions.includes("turn_on")', gate)
        self.assertIn('entity.write_actions.includes("turn_off")', gate)
        self.assertIn("reconcileState", core)
        self.assertIn("observation.sequence > cursor.sequence", core)
        self.assertIn('restoreClient.state !== "ready"', gate)
        self.assertIn("await restoreClient.connect()", gate)
        self.assertIn("restoreClient = createClient", gate)
        self.assertIn("restoreRobotState", gate)
        self.assertIn("restore_attempts", gate)
        self.assertIn("restore_error", gate)
        self.assertIn("attempts += 1", core)
        self.assertIn("&& finalState.available", core)
        self.assertIn('error: "dispatch_unknown"', core)
        self.assertIn('error: "reconcile_unknown"', core)
        self.assertIn("VERIFY:phase4c:robot_identity:PASS", gate)
        self.assertIn("VERIFY:phase4c:robot_write:PASS", gate)
        self.assertIn("VERIFY:phase4c:robot_restore:PASS", gate)
        self.assertNotIn("get_states", gate)
        behavior_test = (
            ROOT / "agent/tests/runtime/phase-4c-ha-gate.test.ts"
        ).read_text(encoding="utf-8")
        self.assertIn("identity gate rejects absent", behavior_test)
        self.assertIn("causal write ignores cache", behavior_test)
        self.assertIn("restoration always dispatches", behavior_test)
        self.assertIn("gate entrypoint consumes", behavior_test)


if __name__ == "__main__":
    unittest.main()
