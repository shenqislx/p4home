#!/usr/bin/env python3
"""Apply validation or persistent product Voice transport configuration."""

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
VALIDATION_PROFILE_COMMENT = "# Ephemeral Phase 5B Voice hardware validation profile."
PRODUCT_PROFILE_COMMENT = "# Persistent Human-only Voice product profile."
PROFILE_MODES = ("validation", "product")


def validate_transport_uri(uri: str, path: str, label: str) -> None:
    parsed = urllib.parse.urlsplit(uri)
    if (
        parsed.scheme != "wss"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != path
        or parsed.query
        or parsed.fragment
        or len(uri.encode()) >= 256
    ):
        raise ValueError(f"invalid {label} WSS URI")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError(f"invalid {label} WSS URI port") from error


def validate(uri: str, device_id: str, token: str, spki: str) -> None:
    validate_transport_uri(uri, "/v1/voice", "Voice")
    if DEVICE_ID_RE.fullmatch(device_id) is None:
        raise ValueError("invalid Voice device id")
    if not 32 <= len(token.encode()) < 256 or "\r" in token or "\n" in token:
        raise ValueError("invalid Voice device token")
    if SPKI_RE.fullmatch(spki) is None:
        raise ValueError("invalid Voice SPKI pin")


def apply_profile(
    path: pathlib.Path,
    uri: str,
    device_id: str,
    token: str,
    spki: str,
    profile: str = "validation",
    device_uri: str | None = None,
) -> None:
    validate(uri, device_id, token, spki)
    if profile not in PROFILE_MODES:
        raise ValueError("invalid Voice profile mode")
    if profile == "product":
        if device_uri is None:
            raise ValueError("product profile requires Human avatar Device WSS URI")
        validate_transport_uri(device_uri, "/v1/device", "Human avatar Device")
        voice_endpoint = urllib.parse.urlsplit(uri)
        device_endpoint = urllib.parse.urlsplit(device_uri)
        if voice_endpoint.hostname != device_endpoint.hostname or voice_endpoint.port == device_endpoint.port:
            raise ValueError("product Voice and Device endpoints must use one host and distinct ports")
    elif device_uri is not None:
        raise ValueError("validation profile forbids Human avatar Device WSS URI")
    if not path.is_file() or path.is_symlink():
        raise ValueError("Phase 5B sdkconfig must be a non-symlink regular file")
    original_mode = path.stat().st_mode & 0o777
    replacements = {
        "CONFIG_ESP_MAIN_TASK_STACK_SIZE": "CONFIG_ESP_MAIN_TASK_STACK_SIZE=8192",
        "CONFIG_P4HOME_SR_ENABLE": "CONFIG_P4HOME_SR_ENABLE=y",
        "CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST": (
            "CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST=y"
            if profile == "validation"
            else "# CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST is not set"
        ),
        "CONFIG_P4HOME_PHASE5A_VALIDATION": (
            "CONFIG_P4HOME_PHASE5A_VALIDATION=y"
            if profile == "validation"
            else "# CONFIG_P4HOME_PHASE5A_VALIDATION is not set"
        ),
        "CONFIG_P4HOME_PHASE5B_VALIDATION": (
            "CONFIG_P4HOME_PHASE5B_VALIDATION=y"
            if profile == "validation"
            else "# CONFIG_P4HOME_PHASE5B_VALIDATION is not set"
        ),
        "CONFIG_P4HOME_BACKGROUND_TASKS_EXTERNAL_STACK": "CONFIG_P4HOME_BACKGROUND_TASKS_EXTERNAL_STACK=y",
        "CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED": (
            "CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED=y"
            if profile == "product"
            else "# CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED is not set"
        ),
        "CONFIG_P4HOME_AGENT_TRANSPORT_URI": f"CONFIG_P4HOME_AGENT_TRANSPORT_URI={json.dumps(device_uri)}",
        "CONFIG_P4HOME_AGENT_DEVICE_ID": f"CONFIG_P4HOME_AGENT_DEVICE_ID={json.dumps(device_id)}",
        "CONFIG_P4HOME_AGENT_DEVICE_TOKEN": f"CONFIG_P4HOME_AGENT_DEVICE_TOKEN={json.dumps(token)}",
        "CONFIG_P4HOME_AGENT_SPKI_SHA256": f"CONFIG_P4HOME_AGENT_SPKI_SHA256={json.dumps(spki)}",
        "CONFIG_P4HOME_AGENT_PROTOCOL_VERSION": "CONFIG_P4HOME_AGENT_PROTOCOL_VERSION=3",
        "CONFIG_P4HOME_AGENT_TRANSPORT_TASK_STACK": "CONFIG_P4HOME_AGENT_TRANSPORT_TASK_STACK=12288",
        "CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC": "# CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC is not set",
        "CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC": "CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y",
        "CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED": "CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED=y",
        "CONFIG_P4HOME_VOICE_TRANSPORT_URI": f"CONFIG_P4HOME_VOICE_TRANSPORT_URI={json.dumps(uri)}",
        "CONFIG_P4HOME_VOICE_DEVICE_ID": f"CONFIG_P4HOME_VOICE_DEVICE_ID={json.dumps(device_id)}",
        "CONFIG_P4HOME_VOICE_DEVICE_TOKEN": f"CONFIG_P4HOME_VOICE_DEVICE_TOKEN={json.dumps(token)}",
        "CONFIG_P4HOME_VOICE_SPKI_SHA256": f"CONFIG_P4HOME_VOICE_SPKI_SHA256={json.dumps(spki)}",
        "CONFIG_P4HOME_VOICE_TRANSPORT_TASK_STACK": "CONFIG_P4HOME_VOICE_TRANSPORT_TASK_STACK=12288",
        "CONFIG_P4HOME_VOICE_WEBSOCKET_TASK_STACK": "CONFIG_P4HOME_VOICE_WEBSOCKET_TASK_STACK=6144",
        "CONFIG_P4HOME_VOICE_RECONNECT_TIMEOUT_MS": "CONFIG_P4HOME_VOICE_RECONNECT_TIMEOUT_MS=10000",
        "CONFIG_P4HOME_HA_CLIENT_WS_TASK_STACK": "CONFIG_P4HOME_HA_CLIENT_WS_TASK_STACK=8192",
    }
    managed_keys = frozenset(replacements)
    if profile != "product":
        for key in (
            "CONFIG_P4HOME_AGENT_TRANSPORT_URI",
            "CONFIG_P4HOME_AGENT_DEVICE_ID",
            "CONFIG_P4HOME_AGENT_DEVICE_TOKEN",
            "CONFIG_P4HOME_AGENT_SPKI_SHA256",
            "CONFIG_P4HOME_AGENT_PROTOCOL_VERSION",
            "CONFIG_P4HOME_AGENT_TRANSPORT_TASK_STACK",
        ):
            replacements.pop(key)
    lines = path.read_text(encoding="utf-8").splitlines()
    retained = [
        line for line in lines
        if line not in {VALIDATION_PROFILE_COMMENT, PRODUCT_PROFILE_COMMENT}
        and not any(
            line.startswith(f"{key}=") or line == f"# {key} is not set"
            for key in managed_keys
        )
    ]
    while retained and retained[-1] == "":
        retained.pop()
    retained.extend(("", (
        VALIDATION_PROFILE_COMMENT if profile == "validation" else PRODUCT_PROFILE_COMMENT
    )))
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
    parser.add_argument("--profile", choices=PROFILE_MODES, default="validation")
    parser.add_argument("--device-uri")
    args = parser.parse_args()
    apply_profile(
        args.sdkconfig,
        args.uri,
        args.device_id,
        args.token_file.read_text(encoding="utf-8").strip(),
        args.spki_file.read_text(encoding="utf-8").strip(),
        args.profile,
        args.device_uri,
    )


if __name__ == "__main__":
    main()
