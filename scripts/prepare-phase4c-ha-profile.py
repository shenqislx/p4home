#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


ENTITY_PATTERN = re.compile(r"(light|switch)\.([a-z0-9_]+)")


def prepare_profile(
    sdkconfig_path: Path,
    policy_path: Path,
    panel_entities_path: Path,
    entity_path: Path,
    binding_path: Path,
    alias: str,
    firmware_validation: bool = True,
) -> None:
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    entities = policy.get("entities") if isinstance(policy, dict) else None
    if not isinstance(entities, list) or len(entities) != 1:
        raise ValueError("Phase 4C requires exactly one private policy entity")
    entity = entities[0]
    if not isinstance(entity, dict):
        raise ValueError("Phase 4C private policy entity must be an object")
    entity_id = entity.get("entity_id")
    match = ENTITY_PATTERN.fullmatch(entity_id) if isinstance(entity_id, str) else None
    if (
        entity.get("alias") != alias
        or entity.get("domain") not in {"light", "switch"}
        or entity.get("read") is not True
        or entity.get("write_actions") != ["turn_on", "turn_off"]
        or match is None
        or match.group(1) != entity.get("domain")
    ):
        raise ValueError("Phase 4C private policy has an unsafe shape")
    panel_document = json.loads(panel_entities_path.read_text(encoding="utf-8"))
    panel_entities = panel_document.get("entities") if isinstance(panel_document, dict) else None
    tracked = [
        candidate
        for candidate in panel_entities
        if isinstance(candidate, dict) and candidate.get("entity_id") == entity_id
    ] if isinstance(panel_entities, list) else []
    if len(tracked) != 1 or tracked[0].get("kind") != "binary":
        raise ValueError("Phase 4C private policy entity is not one tracked binary panel entity")

    lines = [
        line
        for line in sdkconfig_path.read_text(encoding="utf-8").splitlines()
        if not line.startswith("CONFIG_P4HOME_PHASE4C_VALIDATION=")
        and not line.startswith("# CONFIG_P4HOME_PHASE4C_VALIDATION is not set")
        and not line.startswith("CONFIG_P4HOME_PHASE4C_VALIDATION_ENTITY_ID=")
        and not line.startswith("CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED=")
        and not line.startswith("# CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED is not set")
    ]
    lines.extend(
        [
            (
                "CONFIG_P4HOME_PHASE4C_VALIDATION=y"
                if firmware_validation
                else "# CONFIG_P4HOME_PHASE4C_VALIDATION is not set"
            ),
            "# CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED is not set",
        ]
    )
    if firmware_validation:
        lines.append(f'CONFIG_P4HOME_PHASE4C_VALIDATION_ENTITY_ID="{entity_id}"')
    sdkconfig_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    sdkconfig_path.chmod(0o600)
    entity_path.write_text(f"{entity_id}\n", encoding="utf-8")
    entity_path.chmod(0o600)
    binding_path.write_text("1\n", encoding="utf-8")
    binding_path.chmod(0o600)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sdkconfig", required=True, type=Path)
    parser.add_argument("--policy", required=True, type=Path)
    parser.add_argument("--panel-entities", required=True, type=Path)
    parser.add_argument("--entity-output", required=True, type=Path)
    parser.add_argument("--binding-output", required=True, type=Path)
    parser.add_argument("--alias", default="study_ceiling_light")
    parser.add_argument("--agent-ha-only", action="store_true")
    args = parser.parse_args()
    prepare_profile(
        args.sdkconfig,
        args.policy,
        args.panel_entities,
        args.entity_output,
        args.binding_output,
        args.alias,
        not args.agent_ha_only,
    )


if __name__ == "__main__":
    main()
