#!/usr/bin/env python3
"""Apply the Phase 5B voice transport profile and ephemeral credentials."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import tempfile
import urllib.parse


DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SPKI_RE = re.compile(r"^[0-9a-f]{64}$")
PROFILE_COMMENT = "# Ephemeral Phase 5B Voice hardware validation profile."


def validate(uri: str, device_id: str, token: str, spki: str) -> None:
    parsed = urllib.parse.urlsplit(uri)
    if (
        parsed.scheme != "wss"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/v1/voice"
        or parsed.query
        or parsed.fragment
        or len(uri.encode()) >= 256
    ):
        raise ValueError("invalid Voice WSS URI")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError("invalid Voice WSS URI port") from error
    if DEVICE_ID_RE.fullmatch(device_id) is None:
        raise ValueError("invalid Voice device id")
    if not 32 <= len(token.encode()) < 256 or "\r" in token or "\n" in token:
        raise ValueError("invalid Voice device token")
    if SPKI_RE.fullmatch(spki) is None:
        raise ValueError("invalid Voice SPKI pin")


def apply_profile(path: pathlib.Path, uri: str, device_id: str, token: str, spki: str) -> None:
    validate(uri, device_id, token, spki)
    if not path.is_file() or path.is_symlink():
        raise ValueError("Phase 5B sdkconfig must be a non-symlink regular file")
    original_mode = path.stat().st_mode & 0o777
    replacements = {
        "CONFIG_ESP_MAIN_TASK_STACK_SIZE": "CONFIG_ESP_MAIN_TASK_STACK_SIZE=12288",
        "CONFIG_P4HOME_SR_ENABLE": "CONFIG_P4HOME_SR_ENABLE=y",
        "CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST": "CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST=y",
        "CONFIG_P4HOME_PHASE5A_VALIDATION": "CONFIG_P4HOME_PHASE5A_VALIDATION=y",
        "CONFIG_P4HOME_PHASE5B_VALIDATION": "CONFIG_P4HOME_PHASE5B_VALIDATION=y",
        "CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED": "# CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED is not set",
        "CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC": "# CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC is not set",
        "CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC": "CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y",
        "CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED": "CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED=y",
        "CONFIG_P4HOME_VOICE_TRANSPORT_URI": f"CONFIG_P4HOME_VOICE_TRANSPORT_URI={json.dumps(uri)}",
        "CONFIG_P4HOME_VOICE_DEVICE_ID": f"CONFIG_P4HOME_VOICE_DEVICE_ID={json.dumps(device_id)}",
        "CONFIG_P4HOME_VOICE_DEVICE_TOKEN": f"CONFIG_P4HOME_VOICE_DEVICE_TOKEN={json.dumps(token)}",
        "CONFIG_P4HOME_VOICE_SPKI_SHA256": f"CONFIG_P4HOME_VOICE_SPKI_SHA256={json.dumps(spki)}",
        "CONFIG_P4HOME_VOICE_TRANSPORT_TASK_STACK": "CONFIG_P4HOME_VOICE_TRANSPORT_TASK_STACK=12288",
        "CONFIG_P4HOME_VOICE_WEBSOCKET_TASK_STACK": "CONFIG_P4HOME_VOICE_WEBSOCKET_TASK_STACK=6144",
    }
    lines = path.read_text(encoding="utf-8").splitlines()
    retained = [
        line for line in lines
        if line != PROFILE_COMMENT
        and not any(line.startswith(f"{key}=") or line == f"# {key} is not set" for key in replacements)
    ]
    while retained and retained[-1] == "":
        retained.pop()
    retained.extend(("", PROFILE_COMMENT))
    retained.extend(replacements.values())
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write("\n".join(retained) + "\n")
        os.chmod(temporary, original_mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sdkconfig", required=True, type=pathlib.Path)
    parser.add_argument("--uri", required=True)
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--token-file", required=True, type=pathlib.Path)
    parser.add_argument("--spki-file", required=True, type=pathlib.Path)
    args = parser.parse_args()
    apply_profile(
        args.sdkconfig,
        args.uri,
        args.device_id,
        args.token_file.read_text(encoding="utf-8").strip(),
        args.spki_file.read_text(encoding="utf-8").strip(),
    )


if __name__ == "__main__":
    main()
