#!/usr/bin/env python3
"""Capture raw ESP serial output without requiring an interactive TTY."""

from __future__ import annotations

import argparse
import os
import pathlib
import time

import serial


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="Serial device path")
    parser.add_argument("--seconds", required=True, type=int, help="Capture duration")
    parser.add_argument("--output", required=True, type=pathlib.Path, help="UTF-8 log path")
    parser.add_argument("--baud", type=int, default=115200, help="Serial baud rate")
    parser.add_argument("--append", action="store_true", help="Append instead of truncate")
    parser.add_argument("--reset", action="store_true", help="Hard-reset ESP32-P4 first")
    parser.add_argument("--stop-file", type=pathlib.Path)
    parser.add_argument("--post-stop-seconds", type=int, default=0)
    parser.add_argument("--duration-file", type=pathlib.Path)
    args = parser.parse_args()
    if args.seconds <= 0:
        parser.error("--seconds must be greater than zero")
    if args.stop_file is None and args.post_stop_seconds != 0:
        parser.error("--post-stop-seconds requires --stop-file")
    if args.stop_file is not None and args.post_stop_seconds <= 0:
        parser.error("--stop-file requires --post-stop-seconds greater than zero")
    return args


def write_private_duration(path: pathlib.Path, elapsed_seconds: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        value = f"{elapsed_seconds}\n".encode("ascii")
        remaining = memoryview(value)
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                raise OSError("short write for capture duration")
            remaining = remaining[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main() -> int:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if args.append else "w"

    with args.output.open(mode, encoding="utf-8") as handle:
        handle.write(
            f"\n$ serial-capture {args.port} {args.seconds}s baud={args.baud}"
            f" reset={str(args.reset).lower()}\n"
        )
        handle.flush()

        device = serial.Serial(
            port=args.port,
            baudrate=args.baud,
            timeout=0.25,
            rtscts=False,
            dsrdtr=False,
        )
        try:
            if args.reset:
                from esp_idf_monitor.base.reset import Reset

                reset = Reset(device, "esp32p4")
                reset._setRTS(False)
                reset._setDTR(False)
                device.reset_input_buffer()
                reset.hard()

            capture_started_at = time.monotonic()
            deadline = capture_started_at + args.seconds
            stop_deadline = None
            while time.monotonic() < deadline:
                if args.stop_file is not None and args.stop_file.is_file():
                    if stop_deadline is None:
                        stop_deadline = time.monotonic() + args.post_stop_seconds
                        handle.write(
                            "\n$ serial-capture stop-file-observed "
                            f"post_stop_seconds={args.post_stop_seconds}\n"
                        )
                        handle.flush()
                    if time.monotonic() >= stop_deadline:
                        break
                chunk = device.read(device.in_waiting or 1)
                if chunk:
                    handle.write(chunk.decode("utf-8", errors="replace"))
                    handle.flush()
            finished_at = time.monotonic()
            if args.stop_file is not None and (
                stop_deadline is None or finished_at < stop_deadline
            ):
                raise RuntimeError("serial capture ended before the post-stop window")
        finally:
            device.close()

    if args.duration_file is not None:
        write_private_duration(
            args.duration_file, max(1, int(time.monotonic() - capture_started_at))
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
