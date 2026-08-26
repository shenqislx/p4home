#!/usr/bin/env python3
"""Install stable private credentials and a launchd service for Human-only Voice."""

from __future__ import annotations

import argparse
import hashlib
import os
import pathlib
import plistlib
import re
import secrets
import shutil
import subprocess
import tempfile


DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]+$")
MODEL_REVISION_RE = re.compile(r'^MODEL_REVISION = "([0-9a-f]{40})"$', re.MULTILINE)
LABEL = "local.p4home.product-human-voice"


def atomic_write(path: pathlib.Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def private_regular(path: pathlib.Path) -> bool:
    return path.is_file() and not path.is_symlink() and (path.stat().st_mode & 0o077) == 0


def generate_identity(config_dir: pathlib.Path) -> None:
    token = config_dir / "device-token"
    key = config_dir / "agent-key.pem"
    cert = config_dir / "agent-cert.pem"
    existing = [item.exists() for item in (token, key, cert)]
    if any(existing) and not all(existing):
        raise RuntimeError("partial product Voice identity exists; refusing implicit rotation")
    if all(existing):
        if not all(private_regular(item) for item in (token, key, cert)):
            raise RuntimeError("product Voice identity files must be private regular files")
        return
    atomic_write(token, (secrets.token_hex(32) + "\n").encode())
    subprocess.run(
        [
            "/usr/bin/openssl", "req", "-x509", "-newkey", "ec",
            "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
            "-keyout", str(key), "-out", str(cert), "-days", "3650",
            "-subj", "/CN=p4home-product-human",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    os.chmod(key, 0o600)
    os.chmod(cert, 0o600)


def spki_sha256(key: pathlib.Path) -> str:
    public_der = subprocess.run(
        ["/usr/bin/openssl", "pkey", "-in", str(key), "-pubout", "-outform", "DER"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ).stdout
    return hashlib.sha256(public_der).hexdigest()


def resolve_stt_model(repo_root: pathlib.Path) -> pathlib.Path:
    prepare_model = repo_root / "agent/packages/provider-stt/python/prepare_model.py"
    match = MODEL_REVISION_RE.search(prepare_model.read_text(encoding="utf-8"))
    if match is None:
        raise RuntimeError("cannot resolve pinned STT model revision")
    model = pathlib.Path.home() / "Library/Caches/p4home/stt" / f"whisper-small-{match.group(1)}"
    if not model.is_dir():
        raise RuntimeError("pinned STT model is not installed")
    return model


def install(args: argparse.Namespace) -> pathlib.Path:
    repo_root = pathlib.Path(args.repo_root).resolve()
    wrapper = repo_root / "scripts/run-product-human-voice.sh"
    if not wrapper.is_file() or wrapper.is_symlink():
        raise RuntimeError("product Voice wrapper is unavailable")
    if DEVICE_ID_RE.fullmatch(args.device_id) is None:
        raise ValueError("invalid product Voice device id")
    if HOST_RE.fullmatch(args.agent_host) is None:
        raise ValueError("invalid product Voice Agent host")
    if not 1 <= args.agent_port <= 65535:
        raise ValueError("invalid product Voice Agent port")

    config_dir = pathlib.Path(args.config_dir).expanduser().resolve()
    state_dir = pathlib.Path(args.state_dir).expanduser().resolve()
    log_dir = pathlib.Path(args.log_dir).expanduser().resolve()
    launch_agent = pathlib.Path(args.launch_agent).expanduser().resolve()
    for directory in (config_dir, state_dir, log_dir, launch_agent.parent):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(config_dir, 0o700)
    os.chmod(state_dir, 0o700)
    os.chmod(log_dir, 0o700)

    generate_identity(config_dir)
    model = resolve_stt_model(repo_root)
    atomic_write(config_dir / "device-id", f"{args.device_id}\n".encode())
    atomic_write(config_dir / "agent-host", f"{args.agent_host}\n".encode())
    atomic_write(config_dir / "agent-port", f"{args.agent_port}\n".encode())
    atomic_write(config_dir / "stt-model-path", f"{model}\n".encode())
    atomic_write(config_dir / "spki-sha256", f"{spki_sha256(config_dir / 'agent-key.pem')}\n".encode())

    node = pathlib.Path(args.node_bin).expanduser().resolve()
    if not node.is_file() or subprocess.run(
        [str(node), "--version"], check=True, capture_output=True, text=True
    ).stdout.strip() != "v24.19.0":
        raise RuntimeError("Node v24.19.0 is required")
    plist = {
        "Label": LABEL,
        "ProgramArguments": [str(wrapper)],
        "WorkingDirectory": str(repo_root / "agent"),
        "EnvironmentVariables": {
            "P4HOME_NODE_BIN": str(node),
            "P4HOME_PRODUCT_VOICE_CONFIG_DIR": str(config_dir),
            "P4HOME_PRODUCT_VOICE_STATE_DIR": str(state_dir),
        },
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 10,
        "StandardOutPath": str(log_dir / "product-human-voice.log"),
        "StandardErrorPath": str(log_dir / "product-human-voice.err.log"),
        "ProcessType": "Interactive",
    }
    atomic_write(launch_agent, plistlib.dumps(plist, sort_keys=True))
    return launch_agent


def main() -> None:
    repo_root = pathlib.Path(__file__).resolve().parents[1]
    home = pathlib.Path.home()
    node_default = shutil.which("node") or str(home / ".nvm/versions/node/v24.19.0/bin/node")
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=str(repo_root))
    parser.add_argument("--agent-host", required=True)
    parser.add_argument("--agent-port", type=int, default=18443)
    parser.add_argument("--device-id", default="p4-product-human")
    parser.add_argument("--node-bin", default=node_default)
    parser.add_argument("--config-dir", default=str(home / ".config/p4home/product-voice"))
    parser.add_argument(
        "--state-dir", default=str(home / "Library/Application Support/p4home/product-voice")
    )
    parser.add_argument("--log-dir", default=str(home / "Library/Logs/p4home"))
    parser.add_argument(
        "--launch-agent",
        default=str(home / f"Library/LaunchAgents/{LABEL}.plist"),
    )
    args = parser.parse_args()
    print(install(args))


if __name__ == "__main__":
    main()
