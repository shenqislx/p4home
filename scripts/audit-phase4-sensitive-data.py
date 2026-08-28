#!/usr/bin/env python3
"""Fail-closed Phase 4 secret and runtime-output scanner.

The report contains counts and category names only. Secret values, matching
lines, entity IDs, and raw attributes are never printed or persisted.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import stat
import subprocess
import tarfile
from collections.abc import Iterable


COMPACT_OUTPUT_PATTERNS = {
    "authorization_header": re.compile(rb"authorization:bearer", re.I),
    "ha_token_field": re.compile(rb'"(?:access_token|refresh_token|token)":', re.I),
    "sensitive_attribute": re.compile(
        rb'"(?:latitude|longitude|gps_accuracy|device_tracker|user_id)":',
        re.I,
    ),
}

RAW_OUTPUT_PATTERNS = {
    "raw_entity_id": re.compile(
        rb"\b(?:light|switch|scene|climate|lock|alarm_control_panel|sensor|binary_sensor)"
        rb"\.[a-z0-9_]{1,255}\b",
        re.I,
    ),
}
OUTPUT_PATTERN_NAMES = (*COMPACT_OUTPUT_PATTERNS, *RAW_OUTPUT_PATTERNS)
MAX_SOURCE_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_SOURCE_ARCHIVE_MEMBERS = 100_000
MAX_SOURCE_ARCHIVE_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
MAX_SOURCE_ARCHIVE_MEMBER_BYTES = 512 * 1024 * 1024


def secure_secret(path: pathlib.Path) -> bytes:
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        raise RuntimeError("O_NOFOLLOW is required for token safety")
    try:
        descriptor = os.open(path, os.O_RDONLY | nofollow | os.O_NONBLOCK)
    except OSError as error:
        raise ValueError("token file must be a non-symlink regular file") from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("token file must be a regular 0600 file")
        if info.st_size < 16 or info.st_size > 16_384:
            raise ValueError("token file size is outside the safe range")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            value = handle.read(16_385).strip()
    finally:
        os.close(descriptor)
    if len(value) < 16 or any(byte < 0x21 or byte > 0x7E for byte in value):
        raise ValueError("token file content is invalid")
    return value


def chunks_contain(chunks: Iterable[bytes], needle: bytes) -> bool:
    carry = b""
    for chunk in chunks:
        combined = carry + chunk
        if needle in combined:
            return True
        carry = combined[-max(0, len(needle) - 1) :]
    return False


def scan_git_objects(repo: pathlib.Path, secret: bytes) -> tuple[int, int]:
    object_ids = subprocess.run(
        ["git", "cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
        cwd=repo,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ).stdout.splitlines()
    unique = list(dict.fromkeys(line for line in object_ids if line))
    process = subprocess.Popen(
        ["git", "cat-file", "--batch"],
        cwd=repo,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if process.stdin is None or process.stdout is None:
        raise RuntimeError("git cat-file pipes were not created")
    matches = 0
    scanned = 0
    try:
        for object_id in unique:
            process.stdin.write(object_id + b"\n")
            process.stdin.flush()
            header = process.stdout.readline().split()
            if len(header) != 3 or header[1] == b"missing":
                raise RuntimeError("git cat-file returned an invalid object header")
            size = int(header[2])
            remaining = size
            found = False
            carry = b""
            while remaining > 0:
                chunk = process.stdout.read(min(65_536, remaining))
                if not chunk:
                    raise RuntimeError("git cat-file truncated an object")
                remaining -= len(chunk)
                combined = carry + chunk
                found = found or secret in combined
                carry = combined[-max(0, len(secret) - 1) :]
            if process.stdout.read(1) != b"\n":
                raise RuntimeError("git cat-file object terminator is invalid")
            scanned += 1
            matches += int(found)
    finally:
        try:
            process.stdin.close()
        finally:
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired as error:
                process.kill()
                process.wait()
                raise RuntimeError("git cat-file timed out") from error
            finally:
                process.stdout.close()
    if process.returncode != 0:
        raise RuntimeError("git cat-file failed")
    return scanned, matches


def scan_source_archive(path: pathlib.Path, secret: bytes) -> tuple[int, int]:
    """Scan one bounded GitHub source tarball without extracting or following links."""
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        raise RuntimeError("O_NOFOLLOW is required for source archive safety")
    try:
        descriptor = os.open(path, os.O_RDONLY | nofollow | os.O_NONBLOCK)
    except OSError as error:
        raise ValueError("source archive must be a non-symlink regular file") from error
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_size < 1
                or info.st_size > MAX_SOURCE_ARCHIVE_BYTES):
            raise ValueError("source archive size or type is invalid")
        scanned = 0
        regular_files = 0
        matches = 0
        expanded_bytes = 0
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            try:
                with tarfile.open(fileobj=handle, mode="r:gz") as archive:
                    for member in archive:
                        scanned += 1
                        if scanned > MAX_SOURCE_ARCHIVE_MEMBERS:
                            raise ValueError("source archive has too many members")
                        if member.size < 0 or member.size > MAX_SOURCE_ARCHIVE_MEMBER_BYTES:
                            raise ValueError("source archive member is outside its size bound")
                        expanded_bytes += member.size
                        if expanded_bytes > MAX_SOURCE_ARCHIVE_EXPANDED_BYTES:
                            raise ValueError("source archive expansion exceeds its bound")
                        if not (member.isfile() or member.isdir()):
                            raise ValueError("source archive contains an unsupported member type")
                        metadata = (
                            member.name,
                            member.linkname,
                            *member.pax_headers.keys(),
                            *member.pax_headers.values(),
                        )
                        found = any(secret in value.encode("utf-8") for value in metadata)
                        if member.isfile():
                            regular_files += 1
                            extracted = archive.extractfile(member)
                            if extracted is None:
                                raise ValueError("source archive member could not be read")
                            with extracted:
                                found = found or chunks_contain(
                                    iter(lambda: extracted.read(65_536), b""), secret,
                                )
                        matches += int(found)
            except (tarfile.TarError, UnicodeError) as error:
                raise ValueError("source archive is malformed") from error
        if regular_files == 0:
            raise ValueError("source archive contains no regular source files")
        return scanned, matches
    finally:
        os.close(descriptor)


def scan_file(path: pathlib.Path, secret: bytes) -> dict[str, int]:
    counts = {"exact_token": 0, **{name: 0 for name in OUTPUT_PATTERN_NAMES}}
    carry = b""
    compact_carry = b""
    maximum = max(len(secret), 512)
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        raise RuntimeError("O_NOFOLLOW is required for scan safety")
    try:
        descriptor = os.open(path, os.O_RDONLY | nofollow | os.O_NONBLOCK)
    except OSError as error:
        raise ValueError("scan target must be a non-symlink regular file") from error
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode):
        os.close(descriptor)
        raise ValueError("scan target must be a regular file")
    with os.fdopen(descriptor, "rb") as handle:
        while True:
            chunk = handle.read(65_536)
            if not chunk:
                break
            combined = carry + chunk
            boundary = len(carry)
            start = 0
            while True:
                index = combined.find(secret, start)
                if index < 0:
                    break
                if index + len(secret) > boundary:
                    counts["exact_token"] += 1
                start = index + len(secret)
            for name, pattern in RAW_OUTPUT_PATTERNS.items():
                counts[name] += sum(match.end() > boundary for match in pattern.finditer(combined))
            compact = compact_carry + re.sub(rb"\s+", b"", chunk)
            compact_boundary = len(compact_carry)
            for name, pattern in COMPACT_OUTPUT_PATTERNS.items():
                counts[name] += sum(
                    match.end() > compact_boundary
                    for match in pattern.finditer(compact)
                )
            carry = combined[-maximum:]
            compact_carry = compact[-maximum:]
    return counts


def iter_files(paths: Iterable[pathlib.Path]) -> Iterable[pathlib.Path]:
    for path in paths:
        try:
            info = path.lstat()
        except FileNotFoundError as error:
            raise ValueError("scan target does not exist") from error
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("scan targets must not contain symlinks")
        if stat.S_ISREG(info.st_mode):
            yield path
        elif stat.S_ISDIR(info.st_mode):
            for child in sorted(path.rglob("*")):
                child_info = child.lstat()
                if stat.S_ISLNK(child_info.st_mode):
                    raise ValueError("scan targets must not contain symlinks")
                if stat.S_ISREG(child_info.st_mode):
                    yield child
                elif not stat.S_ISDIR(child_info.st_mode):
                    raise ValueError("scan targets must contain only regular files")
        else:
            raise ValueError("scan target must be a regular file or directory")


def reject_symlink_parents(path: pathlib.Path) -> pathlib.Path:
    absolute = pathlib.Path(os.path.abspath(path))
    current = pathlib.Path(absolute.anchor)
    for part in absolute.parent.parts[1:]:
        current /= part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ValueError("output parent path must contain only real directories")
    return absolute


def write_report(path: pathlib.Path, report: dict[str, object]) -> None:
    output = reject_symlink_parents(path)
    if output.is_symlink():
        raise ValueError("output path must not be a symlink")
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        raise RuntimeError("O_NOFOLLOW is required for output safety")
    try:
        descriptor = os.open(
            output,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC | nofollow | os.O_NONBLOCK,
            0o600,
        )
    except OSError as error:
        raise ValueError("output path must be a non-symlink regular file") from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("output path must be a regular file")
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=False) as handle:
            json.dump(report, handle, ensure_ascii=True, indent=2)
            handle.write("\n")
    finally:
        os.close(descriptor)


def process_contains_secret(secret: bytes) -> bool:
    listing = subprocess.run(
        ["ps", "-axo", "command="],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ).stdout
    return secret in listing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=pathlib.Path)
    parser.add_argument("--token-file", required=True, type=pathlib.Path)
    parser.add_argument("--scan", action="append", default=[], type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()

    repo = args.repo.resolve(strict=True)
    token = secure_secret(args.token_file)
    git_objects, git_matches = scan_git_objects(repo, token)
    totals = {"exact_token": 0, **{name: 0 for name in OUTPUT_PATTERN_NAMES}}
    files = list(iter_files(args.scan))
    for path in files:
        found = scan_file(path, token)
        for name, count in found.items():
            totals[name] += count
    process_match = process_contains_secret(token)
    passed = git_matches == 0 and not process_match and all(count == 0 for count in totals.values())
    report = {
        "schema_version": 1,
        "passed": passed,
        "git_objects_scanned": git_objects,
        "git_exact_token_matches": git_matches,
        "runtime_files_scanned": len(files),
        "runtime_findings": totals,
        "process_argument_exact_token_matches": int(process_match),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_report(args.output, report)
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
