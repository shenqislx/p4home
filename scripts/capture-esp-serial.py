#!/usr/bin/env python3
"""Capture raw ESP serial output without requiring an interactive TTY."""

from __future__ import annotations

import argparse
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
    args = parser.parse_args()
    if args.seconds <= 0:
        parser.error("--seconds must be greater than zero")
    return args


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

            deadline = time.monotonic() + args.seconds
            while time.monotonic() < deadline:
                chunk = device.read(device.in_waiting or 1)
                if chunk:
                    handle.write(chunk.decode("utf-8", errors="replace"))
                    handle.flush()
        finally:
            device.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
