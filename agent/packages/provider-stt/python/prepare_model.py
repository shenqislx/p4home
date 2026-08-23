#!/usr/bin/env python3
"""Download one immutable MLX Whisper model snapshot and write a hash manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import tempfile

MODEL_ID = "mlx-community/whisper-small-mlx"
MODEL_REVISION = "45f3915923c7a79a5a5b5a7d909d39aeb0e5630e"
REQUIRED_FILES = ("config.json", "weights.npz")
MANIFEST_NAME = "p4home-model-manifest.json"


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verified_manifest(model: pathlib.Path) -> dict[str, object] | None:
    try:
        expected_entries = {*REQUIRED_FILES, MANIFEST_NAME}
        if (
            not model.is_dir()
            or model.is_symlink()
            or {entry.name for entry in model.iterdir()} != expected_entries
        ):
            return None
        manifest_path = model / MANIFEST_NAME
        if not manifest_path.is_file() or manifest_path.is_symlink():
            return None
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (
            not isinstance(manifest, dict)
            or manifest.get("schema_version") != 1
            or manifest.get("provider") != "mlx-whisper"
            or manifest.get("provider_version") != "0.4.3"
            or manifest.get("model_id") != MODEL_ID
            or manifest.get("revision") != MODEL_REVISION
            or not isinstance(manifest.get("files"), dict)
        ):
            return None
        files = manifest["files"]
        for name in REQUIRED_FILES:
            path = model / name
            if (
                not path.is_file()
                or path.is_symlink()
                or files.get(name) != sha256(path)
            ):
                return None
        return manifest
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--output", type=pathlib.Path)
    operation.add_argument("--verify", type=pathlib.Path)
    args = parser.parse_args()
    if args.verify is not None:
        model = args.verify.resolve()
        manifest = verified_manifest(model)
        if manifest is None:
            raise SystemExit("model snapshot verification failed")
        print(json.dumps({
            "status": "verified",
            "model_id": MODEL_ID,
            "revision": MODEL_REVISION,
            "files": manifest["files"],
        }, sort_keys=True, separators=(",", ":")))
        return

    assert args.output is not None
    output = args.output.resolve()
    if output.exists() or output.is_symlink() or not output.parent.is_dir():
        raise SystemExit("output must be a new path below an existing directory")

    temporary = pathlib.Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(
            repo_id=MODEL_ID,
            revision=MODEL_REVISION,
            local_dir=temporary,
            allow_patterns=list(REQUIRED_FILES),
        )
        shutil.rmtree(temporary / ".cache", ignore_errors=True)
        files: dict[str, str] = {}
        for name in REQUIRED_FILES:
            path = temporary / name
            if not path.is_file() or path.is_symlink():
                raise SystemExit(f"model snapshot is missing regular file {name}")
            files[name] = sha256(path)
        manifest = {
            "schema_version": 1,
            "provider": "mlx-whisper",
            "provider_version": "0.4.3",
            "model_id": MODEL_ID,
            "revision": MODEL_REVISION,
            "files": files,
        }
        manifest_path = temporary / MANIFEST_NAME
        manifest_path.write_text(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        expected_entries = {*REQUIRED_FILES, manifest_path.name}
        if {entry.name for entry in temporary.iterdir()} != expected_entries:
            raise SystemExit("model snapshot contains unexpected files")
        os.replace(temporary, output)
        if verified_manifest(output) is None:
            shutil.rmtree(output)
            raise SystemExit("created model snapshot failed verification")
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


if __name__ == "__main__":
    main()
