#!/usr/bin/env python3
"""Drive speakerless Phase 5E UI prompts through the Mac test-input speaker."""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import time

CAPTURE_MARKER = "voice_transport: capture opened epoch="
HA_INITIAL_SYNC_READY_MARKER = "VERIFY:ha:initial_sync_ready:PASS"
HA_READINESS_TIMEOUT_SECONDS = 300
WAKE_ATTEMPTS = 3
WAKE_RETRY_DELAY_SECONDS = 1


def count_marker(path: pathlib.Path, marker: str) -> int:
    try:
        return path.read_text(encoding="utf-8", errors="replace").count(marker)
    except FileNotFoundError:
        return 0


def progress_state(path: pathlib.Path) -> tuple[int, int]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        completed = value["completed_interactions"]
        attempts = value["capture_attempts"]
        if (isinstance(completed, int) and 0 <= completed <= 3
                and isinstance(attempts, int) and attempts >= 0):
            return completed, attempts
        return -1, -1
    except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return -1, -1


def wait_until(predicate, timeout: float, reason: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise RuntimeError(reason)


def wait_for_ha_readiness(monitor: pathlib.Path) -> None:
    wait_until(
        lambda: count_marker(monitor, HA_INITIAL_SYNC_READY_MARKER) > 0,
        HA_READINESS_TIMEOUT_SECONDS,
        "ha_initial_sync_readiness_timeout",
    )


def wait_attempt(
    progress_file: pathlib.Path, target: int, timeout: float = 180
) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        completed, _attempts = progress_state(progress_file)
        if completed >= target:
            return True
        # capture_attempts advances after STT, before model execution and the
        # required UI ACK. It is not a terminal signal for this interaction.
        time.sleep(0.05)
    return False


def say(text: str, voice: str) -> None:
    if not isinstance(text, str) or not text or len(text) > 128 or "\x00" in text:
        raise RuntimeError("invalid_private_prompt")
    subprocess.run(["/usr/bin/say", "-v", voice, text], check=True, timeout=30)


def open_capture(monitor: pathlib.Path) -> None:
    before = count_marker(monitor, CAPTURE_MARKER)
    for attempt in range(WAKE_ATTEMPTS):
        if count_marker(monitor, CAPTURE_MARKER) > before:
            return
        say("Hi ESP", "Samantha")
        try:
            wait_until(
                lambda: count_marker(monitor, CAPTURE_MARKER) > before,
                8,
                "wake_capture_timeout",
            )
            return
        except RuntimeError:
            if count_marker(monitor, CAPTURE_MARKER) > before:
                return
            if attempt + 1 == WAKE_ATTEMPTS:
                raise
            time.sleep(WAKE_RETRY_DELAY_SECONDS)


def speak_interaction(monitor: pathlib.Path, prompt: str) -> None:
    open_capture(monitor)
    say(prompt, "Tingting")


def speak_until_progress(
    monitor: pathlib.Path, progress_file: pathlib.Path, prompt: str, target: int
) -> None:
    for _attempt in range(3):
        speak_interaction(monitor, prompt)
        if wait_attempt(progress_file, target):
            return
    raise RuntimeError("voice_attempts_exhausted")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", required=True, type=pathlib.Path)
    parser.add_argument("--progress-file", required=True, type=pathlib.Path)
    parser.add_argument("--monitor-log", required=True, type=pathlib.Path)
    parser.add_argument("--status-file", required=True, type=pathlib.Path)
    args = parser.parse_args()
    try:
        payload = json.loads(args.prompt_file.read_text(encoding="utf-8"))
        prompts = payload["prompts"]
        if payload.get("schema_version") != 1 or set(prompts) != {
            "read", "write", "barge", "followup"
        }:
            raise RuntimeError("invalid_prompt_plan")
        # HA startup is intentionally delayed. Never inject a wake or private
        # prompt before the exact device-side capture gate is ready.
        wait_for_ha_readiness(args.monitor_log)
        speak_until_progress(args.monitor_log, args.progress_file, prompts["read"], 1)

        speak_interaction(args.monitor_log, prompts["write"])
        # A write is never replayed: its HA side effect may have crossed the
        # boundary even when the terminal observation or UI ACK is delayed.
        if not wait_attempt(args.progress_file, 2, timeout=420):
            raise RuntimeError("write_attempt_not_completed_no_replay")

        speak_until_progress(args.monitor_log, args.progress_file, prompts["barge"], 3)
        args.status_file.write_text("0\n", encoding="ascii")
        return 0
    except Exception as error:  # bounded evidence; never print private prompt text
        args.status_file.write_text("1\n", encoding="ascii")
        print(f"PHASE5E_UI_INPUT_DRIVER:FAIL reason={type(error).__name__}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
