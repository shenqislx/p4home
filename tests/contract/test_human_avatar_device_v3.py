from __future__ import annotations

import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
V3_PAYLOADS = ROOT / "contracts/device-protocol/v3/messages/payloads.schema.json"
V2_PAYLOADS = ROOT / "contracts/device-protocol/v2/messages/payloads.schema.json"
TRANSPORT_HEADER = ROOT / "firmware/components/agent_transport/include/agent_transport.h"
TRANSPORT_SOURCE = ROOT / "firmware/components/agent_transport/agent_transport.c"
TRANSPORT_KCONFIG = ROOT / "firmware/components/agent_transport/Kconfig.projbuild"


class HumanAvatarDeviceV3ContractTest(unittest.TestCase):
    def test_v3_binds_all_authoritative_payloads_to_human_avatar(self) -> None:
        payloads = json.loads(V3_PAYLOADS.read_text(encoding="utf-8"))
        self.assertEqual("human_avatar", payloads["$defs"]["actorId"]["const"])
        for definition in (
            "deviceCapabilities",
            "worldSnapshot",
            "worldChanged",
            "actionRequest",
            "actionAccepted",
            "actionStarted",
            "actionCompleted",
            "actionFailed",
            "actionCancel",
            "worldSnapshotResult",
        ):
            self.assertIn("actor_id", payloads["$defs"][definition]["required"])

    def test_frozen_v2_does_not_gain_actor_binding(self) -> None:
        payloads = json.loads(V2_PAYLOADS.read_text(encoding="utf-8"))
        self.assertNotIn("actorId", payloads["$defs"])
        for definition in ("deviceCapabilities", "worldSnapshot", "actionRequest"):
            self.assertNotIn("actor_id", payloads["$defs"][definition]["properties"])

    def test_firmware_selects_v3_and_rejects_any_other_actor(self) -> None:
        header = TRANSPORT_HEADER.read_text(encoding="utf-8")
        source = TRANSPORT_SOURCE.read_text(encoding="utf-8")
        kconfig = TRANSPORT_KCONFIG.read_text(encoding="utf-8")
        self.assertIn("AGENT_TRANSPORT_PROTOCOL_V3 3U", header)
        self.assertIn('AGENT_TRANSPORT_HUMAN_AVATAR_ID "human_avatar"', header)
        self.assertIn("range 1 3", kconfig)
        self.assertIn("agent_uses_human_avatar_runtime()", source)
        self.assertIn('cJSON_GetObjectItemCaseSensitive(payload, "actor_id")', source)
        self.assertGreaterEqual(
            source.count("strcmp(actor_id->valuestring, AGENT_TRANSPORT_HUMAN_AVATAR_ID) != 0"),
            2,
        )
        self.assertIn("agent_add_actor_id(payload)", source)


if __name__ == "__main__":
    unittest.main()
