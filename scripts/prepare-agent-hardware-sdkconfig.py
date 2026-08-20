#!/usr/bin/env python3
"""Overlay ephemeral Agent hardware credentials onto a private sdkconfig."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import tempfile
import urllib.parse
from dataclasses import dataclass


DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SPKI_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class AgentHardwareConfig:
    uri: str
    device_id: str
    device_token: str
    spki_sha256: str
    protocol_version: int = 1


def validate(config: AgentHardwareConfig) -> None:
    parsed = urllib.parse.urlsplit(config.uri)
    if (
        parsed.scheme != "wss"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/v1/device"
        or parsed.query
        or parsed.fragment
        or len(config.uri.encode("utf-8")) >= 256
    ):
        raise ValueError("invalid Agent WSS URI")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError("invalid Agent WSS URI port") from error
    if DEVICE_ID_RE.fullmatch(config.device_id) is None:
        raise ValueError("invalid Agent device id")
    token_bytes = config.device_token.encode("utf-8")
    if (
        len(token_bytes) < 32
        or len(token_bytes) >= 256
        or "\r" in config.device_token
        or "\n" in config.device_token
    ):
        raise ValueError("invalid Agent device token")
    if SPKI_RE.fullmatch(config.spki_sha256) is None:
        raise ValueError("invalid Agent SPKI pin")
    if config.protocol_version not in {1, 2}:
        raise ValueError("invalid Agent protocol version")


def apply_profile(path: pathlib.Path, config: AgentHardwareConfig) -> None:
    validate(config)
    replacements = {
        "CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED": "CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED=y",
        "CONFIG_P4HOME_AGENT_TRANSPORT_URI": (
            f"CONFIG_P4HOME_AGENT_TRANSPORT_URI={json.dumps(config.uri)}"
        ),
        "CONFIG_P4HOME_AGENT_DEVICE_ID": (
            f"CONFIG_P4HOME_AGENT_DEVICE_ID={json.dumps(config.device_id)}"
        ),
        "CONFIG_P4HOME_AGENT_DEVICE_TOKEN": (
            f"CONFIG_P4HOME_AGENT_DEVICE_TOKEN={json.dumps(config.device_token)}"
        ),
        "CONFIG_P4HOME_AGENT_SPKI_SHA256": (
            f"CONFIG_P4HOME_AGENT_SPKI_SHA256={json.dumps(config.spki_sha256)}"
        ),
        "CONFIG_P4HOME_AGENT_PROTOCOL_VERSION": (
            f"CONFIG_P4HOME_AGENT_PROTOCOL_VERSION={config.protocol_version}"
        ),
    }
    lines = path.read_text(encoding="utf-8").splitlines()
    retained: list[str] = []
    for line in lines:
        if any(
            line.startswith(f"{key}=") or line == f"# {key} is not set"
            for key in replacements
        ):
            continue
        retained.append(line)
    retained.extend(("", "# Ephemeral Agent hardware validation profile."))
    retained.extend(replacements.values())
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write("\n".join(retained) + "\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sdkconfig", required=True, type=pathlib.Path)
    parser.add_argument("--uri", required=True)
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--token-file", required=True, type=pathlib.Path)
    parser.add_argument("--spki-file", required=True, type=pathlib.Path)
    parser.add_argument("--protocol-version", type=int, choices=(1, 2), default=1)
    args = parser.parse_args()
    config = AgentHardwareConfig(
        uri=args.uri,
        device_id=args.device_id,
        device_token=args.token_file.read_text(encoding="utf-8").strip(),
        spki_sha256=args.spki_file.read_text(encoding="utf-8").strip(),
        protocol_version=args.protocol_version,
    )
    apply_profile(args.sdkconfig, config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
