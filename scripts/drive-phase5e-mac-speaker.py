#!/usr/bin/env python3
"""Drive the private Phase 5E prompts through the Mac system speaker."""

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
PLAYBACK_MARKER = "voice_playback: playback opened epoch="
ATTEMPT_COMPLETED = "completed"
ATTEMPT_TERMINAL_FAILED = "terminal_failed"
ATTEMPT_TIMED_OUT = "timed_out"


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
        if (type(value.get("schema_version")) is int
                and value["schema_version"] == 1
                and type(completed) is int and 0 <= completed <= 4
                and type(attempts) is int and attempts >= completed):
            return completed, attempts
        return -1, -1
    except (AttributeError, FileNotFoundError, KeyError, TypeError, ValueError,
            json.JSONDecodeError):
        return -1, -1


def write_status(path: pathlib.Path, status: int) -> None:
    if status not in (0, 1):
        raise ValueError("invalid_status")
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(f"{status}\n", encoding="ascii")
    temporary.chmod(0o600)
    temporary.replace(path)


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
    progress_file: pathlib.Path,
    target: int,
    attempts_before: int | None = None,
    timeout: float = 150,
) -> str:
    deadline = time.monotonic() + timeout
    baseline = attempts_before
    while time.monotonic() < deadline:
        completed, attempts = progress_state(progress_file)
        if completed >= target:
            return ATTEMPT_COMPLETED
        if baseline is None and attempts >= 0:
            baseline = attempts
        elif baseline is not None and attempts > baseline:
            # The harness publishes only settled pipeline results. An attempt
            # that did not advance completed_interactions is a bounded
            # pre-dispatch failure and can be retried only for read/chat.
            return ATTEMPT_TERMINAL_FAILED
        time.sleep(0.05)
    return ATTEMPT_TIMED_OUT


def say(text: str, voice: str) -> None:
    if not isinstance(text, str) or not text or len(text) > 128 or "\x00" in text:
        raise RuntimeError("invalid_private_prompt")
    subprocess.run(["/usr/bin/say", "-v", voice, text], check=True, timeout=30)


def open_capture(monitor: pathlib.Path) -> None:
    before = count_marker(monitor, CAPTURE_MARKER)
    for attempt in range(WAKE_ATTEMPTS):
        if count_marker(monitor, CAPTURE_MARKER) > before:
            return
        say("Hi，小星", "Tingting")
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
        _completed, attempts_before = progress_state(progress_file)
        if attempts_before < 0:
            raise RuntimeError("invalid_progress_state")
        speak_interaction(monitor, prompt)
        outcome = wait_attempt(progress_file, target, attempts_before)
        if outcome == ATTEMPT_COMPLETED:
            return
        if outcome == ATTEMPT_TIMED_OUT:
            # The original capture may still be inside bounded STT/Role/TTS
            # work. Never overlap it with a replayed capture.
            raise RuntimeError("interaction_attempt_timeout_no_replay")
    raise RuntimeError("voice_attempts_exhausted")


def speak_once_no_replay(
    monitor: pathlib.Path, progress_file: pathlib.Path, prompt: str, target: int
) -> None:
    _completed, attempts_before = progress_state(progress_file)
    if attempts_before < 0:
        raise RuntimeError("invalid_progress_state")
    speak_interaction(monitor, prompt)
    # A write prompt is never replayed. The first attempt may already have
    # crossed the HA side-effect boundary even when its terminal result is slow.
    if wait_attempt(
        progress_file, target, attempts_before, timeout=390
    ) != ATTEMPT_COMPLETED:
        raise RuntimeError("write_attempt_not_completed_no_replay")


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
        if payload.get("schema_version") != 1 or set(prompts) != {"read", "write", "barge", "followup"}:
            raise RuntimeError("invalid_prompt_plan")
        # HA startup is intentionally delayed. Never inject a wake or private
        # prompt before the exact device-side capture gate is ready.
        wait_for_ha_readiness(args.monitor_log)
        speak_until_progress(args.monitor_log, args.progress_file, prompts["read"], 1)
        speak_once_no_replay(args.monitor_log, args.progress_file, prompts["write"], 2)

        for _attempt in range(3):
            _completed, attempts_before = progress_state(args.progress_file)
            if attempts_before < 0:
                raise RuntimeError("invalid_progress_state")
            playback_before = count_marker(args.monitor_log, PLAYBACK_MARKER)
            speak_interaction(args.monitor_log, prompts["barge"])
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                if count_marker(args.monitor_log, PLAYBACK_MARKER) > playback_before:
                    break
                completed, attempts = progress_state(args.progress_file)
                if completed < 3 and attempts > attempts_before:
                    break
                time.sleep(0.05)
            if count_marker(args.monitor_log, PLAYBACK_MARKER) > playback_before:
                break
        else:
            raise RuntimeError("barge_voice_attempts_exhausted")
        # A new wake while P4 playback is active must cancel that playback epoch.
        open_capture(args.monitor_log)
        wait_until(lambda: progress_state(args.progress_file)[0] >= 3, 30, "barge_cancel_timeout")
        _completed, attempts_before = progress_state(args.progress_file)
        if attempts_before < 0:
            raise RuntimeError("invalid_progress_state")
        say(prompts["followup"], "Tingting")
        outcome = wait_attempt(args.progress_file, 4, attempts_before)
        if outcome == ATTEMPT_TIMED_OUT:
            raise RuntimeError("interaction_attempt_timeout_no_replay")
        if outcome != ATTEMPT_COMPLETED:
            # The first follow-up capture was already open for barge-in. Retry
            # with a fresh wake only when its bounded STT attempt did not pass.
            speak_until_progress(args.monitor_log, args.progress_file, prompts["followup"], 4)
        write_status(args.status_file, 0)
        return 0
    except Exception as error:  # bounded runner evidence, never include private prompt text
        write_status(args.status_file, 1)
        print(f"PHASE5E_AUDIO_DRIVER:FAIL reason={type(error).__name__}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
