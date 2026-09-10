#!/usr/bin/env python3
"""Install and verify the exact Qwen3 Chinese TTS snapshot, without runtime downloads."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import tempfile

MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit"
MODEL_REVISION = "1c6c0ff58c43afa8df571facde2efa077efd85e2"
PROVIDER_VERSION = "0.4.8"
MANIFEST_NAME = "p4home-model-manifest.json"
# Derived from the fixed upstream commit: LFS SHA-256 for weights and
# verified Git blob IDs for tokenizer/config files. Never trust local hashes alone.
EXPECTED_SHA256 = {'config.json': '25ec849dd2502e11f66accb903e9c069e49724925f4755c52deaa5134b44d5a9',
 'generation_config.json': 'f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa',
 'merges.txt': '599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3',
 'model.safetensors': '097b66a8c63570b88abc2fb393d1dc2360394ca7741c818455ba9da257ac2f3b',
 'model.safetensors.index.json': '4665ebf9c3566d4072268b265de621342ad3c1676cc344dfdb63f7a173bd0bd6',
 'preprocessor_config.json': 'efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119',
 'speech_tokenizer/config.json': 'ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167',
 'speech_tokenizer/configuration.json': '6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd',
 'speech_tokenizer/model.safetensors': '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258',
 'speech_tokenizer/preprocessor_config.json': 'fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb',
 'tokenizer_config.json': 'dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670',
 'vocab.json': 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910'}
REQUIRED_FILES = tuple(EXPECTED_SHA256)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def exact_tree(model: pathlib.Path) -> bool:
    try:
        expected = set(REQUIRED_FILES) | {MANIFEST_NAME, "speech_tokenizer"}
        return model.is_dir() and not model.is_symlink() and all(
            not p.is_symlink() and (p.is_file() or p.is_dir()) for p in model.rglob("*")
        ) and {p.relative_to(model).as_posix() for p in model.rglob("*")} == expected
    except OSError:
        return False


def verified_manifest(model: pathlib.Path) -> dict | None:
    try:
        if not exact_tree(model):
            return None
        manifest = json.loads((model / MANIFEST_NAME).read_text())
        if not isinstance(manifest, dict) or any(manifest.get(k) != v for k, v in {
            "schema_version": 1, "provider": "mlx-audio", "provider_version": PROVIDER_VERSION,
            "model_id": MODEL_ID, "revision": MODEL_REVISION, "files": EXPECTED_SHA256,
        }.items()):
            return None
        if any(sha256(model / name) != digest for name, digest in EXPECTED_SHA256.items()):
            return None
        return manifest
    except (OSError, ValueError, TypeError):
        return None


def install_snapshot(source: pathlib.Path, output: pathlib.Path) -> None:
    if output.exists() or output.is_symlink() or not output.parent.is_dir():
        raise ValueError("output must be a new path below an existing directory")
    temporary = pathlib.Path(tempfile.mkdtemp(prefix=".qwen3-tts-", dir=output.parent))
    try:
        for name, digest in EXPECTED_SHA256.items():
            target = temporary / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)
            if sha256(target) != digest:
                raise ValueError("downloaded Qwen3 snapshot hash mismatch: " + name)
        (temporary / MANIFEST_NAME).write_text(json.dumps({
            "schema_version": 1, "provider": "mlx-audio", "provider_version": PROVIDER_VERSION,
            "model_id": MODEL_ID, "revision": MODEL_REVISION, "files": EXPECTED_SHA256,
        }, sort_keys=True) + "\n")
        if verified_manifest(temporary) is None:
            raise ValueError("created Qwen3 snapshot failed verification")
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main() -> None:
    parser = argparse.ArgumentParser()
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--output", type=pathlib.Path)
    operation.add_argument("--verify", type=pathlib.Path)
    parser.add_argument("--source", type=pathlib.Path)
    args = parser.parse_args()
    if args.verify is not None:
        if verified_manifest(args.verify.absolute()) is None:
            raise SystemExit("model snapshot verification failed")
        print(json.dumps({"status": "verified", "model_id": MODEL_ID, "revision": MODEL_REVISION}))
        return
    output = args.output.absolute()
    if args.source is None:
        from huggingface_hub import snapshot_download
        source = pathlib.Path(snapshot_download(repo_id=MODEL_ID, revision=MODEL_REVISION,
                                               allow_patterns=list(REQUIRED_FILES)))
    else:
        source = args.source.absolute()
    install_snapshot(source, output)


if __name__ == "__main__":
    main()
