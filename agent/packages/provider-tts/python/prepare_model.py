#!/usr/bin/env python3
"""Download one immutable Kokoro snapshot and write a hash manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import stat
import sys
import tempfile
import time
from collections.abc import Callable
from typing import Any

MODEL_ID = "mlx-community/Kokoro-82M-bf16"
MODEL_REVISION = "a71e4d38b236d968966a2002c4c895dbd12b1c3c"
PROVIDER_VERSION = "0.4.8"
REQUIRED_FILES = (
    "config.json",
    "kokoro-v1_0.safetensors",
    "voices/zf_xiaobei.safetensors",
    "voices/zm_yunxi.safetensors",
)
MANIFEST_NAME = "p4home-model-manifest.json"
DOWNLOAD_ATTEMPTS = 3
EXPECTED_SHA256 = {
    "config.json": "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f",
    "kokoro-v1_0.safetensors": "4e9ecdf03b8b6cf906070390237feda473dc13327cb8d56a43deaa374c02acd8",
    "voices/zf_xiaobei.safetensors": "cbda378bbe266c735aa13c94c20b6224f2f8d0e16cf3abe612a4e6d93ebeab51",
    "voices/zm_yunxi.safetensors": "78d8bb5ba4a2ea75a7f22c6148214a7434b436db85dc791a2ddf2aa7f6cc6fab",
}


def prepare_private_cache(cache_dir: pathlib.Path) -> None:
    try:
        cache_dir.mkdir(mode=0o700)
    except FileExistsError:
        pass
    try:
        cache_stat = cache_dir.lstat()
    except OSError as error:
        raise SystemExit("model cache directory is unavailable") from error
    if (
        not stat.S_ISDIR(cache_stat.st_mode)
        or stat.S_ISLNK(cache_stat.st_mode)
        or cache_stat.st_uid != os.getuid()
        or stat.S_IMODE(cache_stat.st_mode) != 0o700
    ):
        raise SystemExit("model cache directory must be a private owned directory")


def download_snapshot(
    cache_dir: pathlib.Path,
    snapshot_download: Callable[..., str],
    sleep: Callable[[float], Any] = time.sleep,
) -> pathlib.Path:
    """Download into a persistent HF cache so interrupted transfers can resume."""
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            return pathlib.Path(snapshot_download(
                repo_id=MODEL_ID,
                revision=MODEL_REVISION,
                cache_dir=cache_dir,
                allow_patterns=list(REQUIRED_FILES),
            ))
        except Exception as error:
            if attempt == DOWNLOAD_ATTEMPTS:
                raise
            print(
                "model snapshot download attempt "
                f"{attempt}/{DOWNLOAD_ATTEMPTS} failed ({type(error).__name__}); "
                "retrying from the persistent cache",
                file=sys.stderr,
            )
            sleep(float(attempt))

    raise AssertionError("unreachable")


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_verified_snapshot(snapshot: pathlib.Path, destination: pathlib.Path) -> dict[str, str]:
    files: dict[str, str] = {}
    for name in REQUIRED_FILES:
        source = snapshot / name
        path = destination / name
        if not source.is_file():
            raise SystemExit(f"downloaded snapshot is missing file {name}")
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, path)
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"model snapshot is missing regular file {name}")
        actual_hash = sha256(path)
        if actual_hash != EXPECTED_SHA256[name]:
            raise SystemExit(f"downloaded snapshot hash mismatch for {name}")
        files[name] = actual_hash
    return files


def exact_tree(model: pathlib.Path) -> bool:
    try:
        root_names = {entry.name for entry in model.iterdir()}
        voices = model / "voices"
        return (
            model.is_dir()
            and not model.is_symlink()
            and root_names == {
                "config.json",
                "kokoro-v1_0.safetensors",
                "voices",
                MANIFEST_NAME,
            }
            and voices.is_dir()
            and not voices.is_symlink()
            and {entry.name for entry in voices.iterdir()}
            == {"zf_xiaobei.safetensors", "zm_yunxi.safetensors"}
        )
    except OSError:
        return False


def verified_manifest(model: pathlib.Path) -> dict[str, object] | None:
    try:
        if not exact_tree(model):
            return None
        manifest_path = model / MANIFEST_NAME
        if not manifest_path.is_file() or manifest_path.is_symlink():
            return None
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (
            not isinstance(manifest, dict)
            or manifest.get("schema_version") != 1
            or manifest.get("provider") != "mlx-audio"
            or manifest.get("provider_version") != PROVIDER_VERSION
            or manifest.get("model_id") != MODEL_ID
            or manifest.get("revision") != MODEL_REVISION
            or not isinstance(manifest.get("files"), dict)
        ):
            return None
        files = manifest["files"]
        for name in REQUIRED_FILES:
            path = model / name
            expected_hash = EXPECTED_SHA256[name]
            if (
                not path.is_file()
                or path.is_symlink()
                or files.get(name) != expected_hash
                or sha256(path) != expected_hash
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

        cache_dir = output.parent / ".huggingface-cache"
        prepare_private_cache(cache_dir)
        snapshot = download_snapshot(cache_dir, snapshot_download)
        files = copy_verified_snapshot(snapshot, temporary)
        manifest_path = temporary / MANIFEST_NAME
        manifest_path.write_text(
            json.dumps({
                "schema_version": 1,
                "provider": "mlx-audio",
                "provider_version": PROVIDER_VERSION,
                "model_id": MODEL_ID,
                "revision": MODEL_REVISION,
                "files": files,
            }, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        if not exact_tree(temporary):
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
