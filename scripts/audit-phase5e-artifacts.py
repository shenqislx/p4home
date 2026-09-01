#!/usr/bin/env python3
"""Fail closed if Phase 5E upload candidates contain credentials or raw audio."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import pathlib
import re
import sqlite3
import stat
import subprocess

BASE64_CANDIDATE = re.compile(rb"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{256,}={0,2}(?![A-Za-z0-9+/=])")
RAW_FIELD = re.compile(
    rb'''(?ix)["']?(?:raw[_-]?audio|pcm[_-]?(?:base64|data|blob|path)|audio[_-]?(?:base64|data|blob|path))["']?\s*[:=]'''
)
VOICE_RESULT_KEYS = {
    "schema_version", "profile", "passed", "interactions", "stt_provider_version",
    "stt_model_revision", "stt_calls", "stt_transcript_mismatches", "stt_total_ms",
    "stt_rejections_by_expected_kind", "stt_non_mismatch_failures_by_expected_kind",
    "capture_attempts", "capture_failures_by_expected_kind",
    "stt_accepted_capture_failures_by_expected_kind",
    "stt_failed_capture_failures_by_expected_kind",
    "tts_provider_version", "tts_model_revision", "tts_calls", "tts_total_ms",
    "audit_events", "restored", "read_passed", "write_passed", "barge_in_passed",
    "followup_passed", "composition_audits_persisted", "playback_segments",
    "playback_bytes", "raw_audio_retained",
}
INTERACTION_KEYS = {
    "kind", "role_id", "role_status", "voice_outcome", "playback_statuses", "pcm_bytes",
    "metrics",
}
UI_RESULT_KEYS = {
    "schema_version", "profile", "passed", "interaction_kinds", "role_ids",
    "role_statuses", "voice_outcomes", "ui_delivery_statuses",
    "audio_delivery_statuses", "stt_provider_version", "stt_model_revision",
    "stt_calls", "stt_transcript_mismatches", "stt_rejections_by_expected_kind",
    "stt_non_mismatch_failures_by_expected_kind",
    "stt_total_ms", "real_model_calls", "model_timing",
    "audit_events", "restored", "read_passed", "write_passed", "chat_passed",
    "ui_deliveries_completed", "audio_delivery_deferred",
    "composition_audits_persisted", "raw_audio_retained",
    "interaction_metrics",
}
UI_METRIC_INTERACTION_KEYS = {"kind", "metrics"}
MODEL_TIMING_KEYS = {
    "schema_version", "calls", "completed_calls", "failed_calls",
    "cancelled_calls", "timed_out_calls", "usage_complete_calls", "usage_missing_calls",
    "request_total_ms", "ollama_totals", "call_details", "content_retained",
}
MODEL_CALL_TIMING_KEYS = {"schema_version", "status", "request_duration_ms", "ollama"}
OLLAMA_USAGE_KEYS = {
    "total_duration_ns", "load_duration_ns", "prompt_eval_count",
    "prompt_eval_duration_ns", "eval_count", "eval_duration_ns",
}
OLLAMA_USAGE_MAXIMUMS = {
    "total_duration_ns": 600_000_000_000,
    "load_duration_ns": 600_000_000_000,
    "prompt_eval_count": 1_000_000_000,
    "prompt_eval_duration_ns": 600_000_000_000,
    "eval_count": 1_000_000_000,
    "eval_duration_ns": 600_000_000_000,
}
MODEL_TIMING_RESULT_KEYS = {"schema_version", "interactions", "totals", "content_retained"}
MODEL_TIMING_INTERACTION_KEYS = {"kind", "timing"}
METRICS_KEYS = {
    "schema_version", "stages", "dropped_events", "cancelled_stages",
    "interaction_cancelled",
}
STAGE_NAMES = {
    "stt", "router", "human", "robot", "composer", "tts", "ui",
    "playback_transport", "p4_wake", "p4_vad", "p4_playback",
}
STAGE_METRIC_KEYS = {
    "measurement", "status", "duration_ms", "attempts", "dropped", "cancelled",
}
MEASUREMENTS = {
    "agent", "hardware_pending", "not_applicable", "status_only", "unavailable",
}
STAGE_STATUSES = {
    "cancelled", "completed", "failed", "hardware_pending", "not_applicable",
    "not_attempted", "partial", "timed_out", "unavailable",
}
UI_REQUIRED_INTERACTIONS = 3
# The speakerless driver may retry the read and chat prompts twice each. The
# write prompt is never replayed because its HA side effect may have crossed
# the boundary. Every extra STT call must therefore be attributed to either an
# explicitly rejected transcript or a known provider terminal from a read/chat
# attempt, and the bounded total cannot exceed 3 + 2 + 2. Unclassified
# exceptions remain visible in the schema but can never satisfy the gate.
UI_MAX_RETRY_FAILURES = 4
UI_STT_REJECTION_KEYS = {"read", "write", "chat", "unexpected"}
STT_FAILURE_CODES = {
    "cancelled", "invalid_response", "model_unavailable", "process_error",
    "timeout", "unknown",
}
E2E_REQUIRED_INTERACTIONS = 4
# The audio driver may retry read and barge twice, and may retry follow-up
# three times because its first attempt reuses the capture that interrupted
# barge playback. Write is intentionally never replayed after its HA side
# effect may have crossed the boundary.
E2E_MAX_RETRY_FAILURES = 7
E2E_STT_EXPECTED_KEYS = {"read", "write", "barge", "followup", "unexpected"}
E2E_CAPTURE_FAILURE_OUTCOMES = {
    "cancelled", "dispatch_failed", "empty_transcript", "provider_error",
    "silence", "stale", "timed_out", "too_long", "too_short",
}


def bounded_counter(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 4096


def bounded_integer(value: object, maximum: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum


def exact_schema_version(value: object, expected: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value == expected


def model_timing_summary_valid(value: object, require_complete: bool) -> bool:
    if (not isinstance(value, dict) or set(value) != MODEL_TIMING_KEYS
            or not exact_schema_version(value.get("schema_version"), 1)
            or value.get("content_retained") is not False):
        return False
    details = value.get("call_details")
    if not isinstance(details, list) or len(details) > 4096:
        return False
    status_counts = {"completed": 0, "failed": 0, "cancelled": 0, "timed_out": 0}
    usage_complete = 0
    request_total = 0
    totals = {key: 0 for key in OLLAMA_USAGE_KEYS}
    for call in details:
        if (not isinstance(call, dict) or set(call) != MODEL_CALL_TIMING_KEYS
                or not exact_schema_version(call.get("schema_version"), 1)
                or call.get("status") not in status_counts
                or not bounded_integer(call.get("request_duration_ms"), 600_000)):
            return False
        usage = call.get("ollama")
        if not isinstance(usage, dict) or set(usage) != OLLAMA_USAGE_KEYS:
            return False
        complete = True
        for key in OLLAMA_USAGE_KEYS:
            metric = usage[key]
            if metric is None:
                complete = False
            elif not bounded_integer(metric, OLLAMA_USAGE_MAXIMUMS[key]):
                return False
            else:
                totals[key] += metric
        status_counts[call["status"]] += 1
        request_total += call["request_duration_ms"]
        if complete:
            usage_complete += 1
    calls = len(details)
    summary_counters = {
        "calls": calls,
        "completed_calls": status_counts["completed"],
        "failed_calls": status_counts["failed"],
        "cancelled_calls": status_counts["cancelled"],
        "timed_out_calls": status_counts["timed_out"],
        "usage_complete_calls": usage_complete,
        "usage_missing_calls": calls - usage_complete,
    }
    reported_totals = value.get("ollama_totals")
    return (
        all(bounded_counter(value.get(key)) and value.get(key) == expected
                for key, expected in summary_counters.items())
        and bounded_integer(value.get("request_total_ms"), calls * 600_000)
        and value.get("request_total_ms") == request_total
        and isinstance(reported_totals, dict)
        and set(reported_totals) == OLLAMA_USAGE_KEYS
        and all(bounded_integer(reported_totals.get(key), OLLAMA_USAGE_MAXIMUMS[key] * calls)
                for key in OLLAMA_USAGE_KEYS)
        and reported_totals == totals
        and (not require_complete or (
            calls > 0
            and status_counts == {
                "completed": calls, "failed": 0, "cancelled": 0, "timed_out": 0,
            }
            and usage_complete == calls
        ))
    )


def ui_model_timing_valid(result: dict) -> bool:
    value = result.get("model_timing")
    if (not isinstance(value, dict) or set(value) != MODEL_TIMING_RESULT_KEYS
            or not exact_schema_version(value.get("schema_version"), 1)
            or value.get("content_retained") is not False):
        return False
    interactions = value.get("interactions")
    expected_kinds = ["read", "write", "chat"]
    if not isinstance(interactions, list) or len(interactions) != len(expected_kinds):
        return False
    combined: list[dict] = []
    for index, item in enumerate(interactions):
        if (not isinstance(item, dict) or set(item) != MODEL_TIMING_INTERACTION_KEYS
                or item.get("kind") != expected_kinds[index]
                or not model_timing_summary_valid(item.get("timing"), True)):
            return False
        combined.extend(item["timing"]["call_details"])
    totals = value.get("totals")
    return (
        model_timing_summary_valid(totals, True)
        and totals["call_details"] == combined
        and totals["calls"] == result.get("real_model_calls")
    )


def pinned_version(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,3}", value) is not None


def pinned_revision(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def metrics_schema_valid(
    value: object,
    voice_outcome: object,
    role_id: object,
    mode: str,
    playback_attempts: int = 0,
) -> bool:
    if not isinstance(value, dict) or set(value) != METRICS_KEYS:
        return False
    stages = value.get("stages")
    if value.get("schema_version") != 1 or not isinstance(stages, dict) \
            or set(stages) != STAGE_NAMES:
        return False
    dropped = 1 if voice_outcome == "stale" else 0
    cancelled = 0
    for name, metric in stages.items():
        if not isinstance(metric, dict) or set(metric) != STAGE_METRIC_KEYS:
            return False
        measurement = metric.get("measurement")
        status = metric.get("status")
        duration = metric.get("duration_ms")
        attempts = metric.get("attempts")
        metric_dropped = metric.get("dropped")
        metric_cancelled = metric.get("cancelled")
        if measurement not in MEASUREMENTS or status not in STAGE_STATUSES \
                or not bounded_counter(attempts) or not bounded_counter(metric_dropped) \
                or not bounded_counter(metric_cancelled) or metric_cancelled > attempts:
            return False
        if measurement == "agent":
            if not isinstance(duration, int) or isinstance(duration, bool) \
                    or duration < 0 or duration > 600_000:
                return False
        elif duration is not None:
            return False
        if name in {"p4_wake", "p4_vad", "p4_playback"} and metric != {
            "measurement": "hardware_pending",
            "status": "hardware_pending",
            "duration_ms": None,
            "attempts": 0,
            "dropped": 0,
            "cancelled": 0,
        }:
            return False
        dropped += metric_dropped
        cancelled += metric_cancelled
    if (value.get("dropped_events") != dropped
            or value.get("cancelled_stages") != cancelled
            or value.get("interaction_cancelled") != (
                1 if voice_outcome == "cancelled" else 0
            )):
        return False

    def exact(
        name: str,
        measurement: str,
        status: str,
        attempts: int,
        metric_cancelled: int = 0,
    ) -> bool:
        metric = stages[name]
        return (
            metric["measurement"] == measurement
            and metric["status"] == status
            and metric["attempts"] == attempts
            and metric["dropped"] == 0
            and metric["cancelled"] == metric_cancelled
        )

    if (role_id not in {"human", "robot"}
            or not exact("stt", "agent", "completed", 1)
            or not exact("router", "status_only", "completed", 1)
            or not exact("composer", "status_only", "completed", 1)
            or not exact(role_id, "status_only", "completed", 1)
            or not exact(
                "robot" if role_id == "human" else "human",
                "not_applicable", "not_applicable", 0,
            )):
        return False
    if mode == "speakerless_ui":
        return (
            voice_outcome == "completed"
            and exact("tts", "not_applicable", "not_applicable", 0)
            and exact("ui", "agent", "completed", 2)
            and exact("playback_transport", "not_applicable", "not_applicable", 0)
        )
    if mode != "audio" or playback_attempts < 1:
        return False
    playback_status = "cancelled" if voice_outcome == "cancelled" else "completed"
    return (
        exact("tts", "agent", "completed", 1)
        and exact("ui", "not_applicable", "not_applicable", 0)
        and exact(
            "playback_transport", "agent", playback_status, playback_attempts,
            1 if playback_status == "cancelled" else 0,
        )
    )


def ui_stt_attempts_valid(result: dict) -> bool:
    stt_calls = result.get("stt_calls")
    transcript_mismatches = result.get("stt_transcript_mismatches")
    rejections = result.get("stt_rejections_by_expected_kind")
    failures = result.get("stt_non_mismatch_failures_by_expected_kind")
    if (not isinstance(rejections, dict) or set(rejections) != UI_STT_REJECTION_KEYS
            or not all(bounded_counter(value) for value in rejections.values())
            or not isinstance(failures, dict) or set(failures) != UI_STT_REJECTION_KEYS
            or any(
                not isinstance(bucket, dict) or set(bucket) != STT_FAILURE_CODES
                or not all(bounded_counter(value) for value in bucket.values())
                for bucket in failures.values()
            )
            or not bounded_counter(stt_calls)
            or not bounded_counter(transcript_mismatches)):
        return False
    rejected = sum(rejections.values())
    failed_by_kind = {
        kind: sum(failures[kind].values()) for kind in UI_STT_REJECTION_KEYS
    }
    failed = sum(failed_by_kind.values())
    return (
        all(failures[kind]["unknown"] == 0 for kind in UI_STT_REJECTION_KEYS)
        and rejections["read"] + failed_by_kind["read"] <= 2
        and rejections["write"] + failed_by_kind["write"] == 0
        and rejections["chat"] + failed_by_kind["chat"] <= 2
        and rejections["unexpected"] + failed_by_kind["unexpected"] == 0
        and rejected + failed <= UI_MAX_RETRY_FAILURES
        and transcript_mismatches == rejected
        and stt_calls == UI_REQUIRED_INTERACTIONS + rejected + failed
    )


def e2e_retry_attempts_valid(result: dict) -> bool:
    stt_calls = result.get("stt_calls")
    transcript_mismatches = result.get("stt_transcript_mismatches")
    rejections = result.get("stt_rejections_by_expected_kind")
    failures = result.get("stt_non_mismatch_failures_by_expected_kind")
    capture_attempts = result.get("capture_attempts")
    capture_failures = result.get("capture_failures_by_expected_kind")
    accepted_failures = result.get("stt_accepted_capture_failures_by_expected_kind")
    stt_failed_terminals = result.get("stt_failed_capture_failures_by_expected_kind")
    if (not isinstance(rejections, dict) or set(rejections) != E2E_STT_EXPECTED_KEYS
            or not all(bounded_counter(value) for value in rejections.values())
            or not isinstance(failures, dict) or set(failures) != E2E_STT_EXPECTED_KEYS
            or any(
                not isinstance(bucket, dict) or set(bucket) != STT_FAILURE_CODES
                or not all(bounded_counter(value) for value in bucket.values())
                for bucket in failures.values()
            )
            or not isinstance(capture_failures, dict)
            or set(capture_failures) != E2E_STT_EXPECTED_KEYS
            or any(
                not isinstance(bucket, dict)
                or set(bucket) != E2E_CAPTURE_FAILURE_OUTCOMES
                or not all(bounded_counter(value) for value in bucket.values())
                for bucket in capture_failures.values()
            )
            or not isinstance(accepted_failures, dict)
            or set(accepted_failures) != E2E_STT_EXPECTED_KEYS
            or any(
                not isinstance(bucket, dict)
                or set(bucket) != E2E_CAPTURE_FAILURE_OUTCOMES
                or not all(bounded_counter(value) for value in bucket.values())
                for bucket in accepted_failures.values()
            )
            or not isinstance(stt_failed_terminals, dict)
            or set(stt_failed_terminals) != E2E_STT_EXPECTED_KEYS
            or any(
                not isinstance(bucket, dict)
                or set(bucket) != E2E_CAPTURE_FAILURE_OUTCOMES
                or not all(bounded_counter(value) for value in bucket.values())
                for bucket in stt_failed_terminals.values()
            )
            or not bounded_counter(stt_calls)
            or not bounded_counter(transcript_mismatches)
            or not bounded_counter(capture_attempts)):
        return False

    rejected = sum(rejections.values())
    failed_by_kind = {
        kind: sum(failures[kind].values()) for kind in E2E_STT_EXPECTED_KEYS
    }
    failed = sum(failed_by_kind.values())
    capture_failed_by_kind = {
        kind: sum(capture_failures[kind].values())
        for kind in E2E_STT_EXPECTED_KEYS
    }
    capture_failed = sum(capture_failed_by_kind.values())
    accepted_failed_by_kind = {
        kind: sum(accepted_failures[kind].values())
        for kind in E2E_STT_EXPECTED_KEYS
    }
    accepted_failed = sum(accepted_failed_by_kind.values())
    stt_failed_terminal_by_kind = {
        kind: sum(stt_failed_terminals[kind].values())
        for kind in E2E_STT_EXPECTED_KEYS
    }

    # Every failed STT call settles as provider_error, timed_out, or stale.
    # A successful STT call can settle non-dispatched only when dispatch fails
    # or a newer capture makes the in-flight dispatch stale. Recording that
    # latter partition by capture identity prevents an unexplained provider
    # terminal from being used to forge retry conservation.
    return (
        all(failures[kind]["unknown"] == 0 for kind in E2E_STT_EXPECTED_KEYS)
        and capture_failed_by_kind["read"] <= 2
        and capture_failed_by_kind["write"] == 0
        and capture_failed_by_kind["barge"] <= 2
        and capture_failed_by_kind["followup"] <= 3
        and capture_failed_by_kind["unexpected"] == 0
        and capture_failed <= E2E_MAX_RETRY_FAILURES
        and all(
            accepted_failures[kind][outcome] <= capture_failures[kind][outcome]
            for kind in E2E_STT_EXPECTED_KEYS
            for outcome in E2E_CAPTURE_FAILURE_OUTCOMES
        )
        and all(
            stt_failed_terminals[kind][outcome] <= capture_failures[kind][outcome]
            for kind in E2E_STT_EXPECTED_KEYS
            for outcome in E2E_CAPTURE_FAILURE_OUTCOMES
        )
        and all(
            accepted_failures[kind][outcome]
                + stt_failed_terminals[kind][outcome]
            <= capture_failures[kind][outcome]
            for kind in E2E_STT_EXPECTED_KEYS
            for outcome in E2E_CAPTURE_FAILURE_OUTCOMES
        )
        and all(
            accepted_failures[kind][outcome] == 0
            for kind in E2E_STT_EXPECTED_KEYS
            for outcome in E2E_CAPTURE_FAILURE_OUTCOMES - {"dispatch_failed", "stale"}
        )
        and all(
            accepted_failures[kind]["dispatch_failed"]
            == capture_failures[kind]["dispatch_failed"]
            for kind in E2E_STT_EXPECTED_KEYS
        )
        and all(
            stt_failed_terminals[kind][outcome] == 0
            for kind in E2E_STT_EXPECTED_KEYS
            for outcome in E2E_CAPTURE_FAILURE_OUTCOMES
                - {"provider_error", "timed_out", "stale"}
        )
        and all(
            capture_failures[kind][outcome]
            == stt_failed_terminals[kind][outcome]
            for kind in E2E_STT_EXPECTED_KEYS
            for outcome in {"provider_error", "timed_out"}
        )
        and all(
            rejections[kind] + failed_by_kind[kind]
            == stt_failed_terminal_by_kind[kind]
            for kind in E2E_STT_EXPECTED_KEYS
        )
        and transcript_mismatches == rejected
        and stt_calls == E2E_REQUIRED_INTERACTIONS + rejected + failed + accepted_failed
        and capture_attempts == E2E_REQUIRED_INTERACTIONS + capture_failed
        and stt_calls <= capture_attempts
    )


def common_result_schema_valid(result: dict, profile: str) -> bool:
    stt_calls = result.get("stt_calls")
    stt_attempts_valid = (
        ui_stt_attempts_valid(result)
        if profile == "phase5e_ui"
        else (
            profile == "phase5e_e2e"
            and e2e_retry_attempts_valid(result)
        )
    )
    return (
        result.get("profile") == profile
        and result.get("passed") is True
        and pinned_version(result.get("stt_provider_version"))
        and pinned_revision(result.get("stt_model_revision"))
        and stt_attempts_valid
        and bounded_integer(result.get("stt_total_ms"), stt_calls * 600_000)
        and bounded_integer(result.get("audit_events"), 65_536)
        and result.get("restored") is True
        and result.get("raw_audio_retained") is False
    )


def voice_interactions_schema_valid(interactions: object) -> bool:
    expected = (
        ("read", "robot", "completed", "completed"),
        ("write", "robot", "completed", "completed"),
        ("barge", "human", "completed", "cancelled"),
        ("followup", "human", "completed", "completed"),
    )
    if not isinstance(interactions, list) or len(interactions) != len(expected):
        return False
    for item, values in zip(interactions, expected, strict=True):
        if not isinstance(item, dict) or set(item) != INTERACTION_KEYS:
            return False
        kind, role_id, role_status, voice_outcome = values
        statuses = item.get("playback_statuses")
        expected_playback = "cancelled" if voice_outcome == "cancelled" else "completed"
        if (item.get("kind") != kind or item.get("role_id") != role_id
                or item.get("role_status") != role_status
                or item.get("voice_outcome") != voice_outcome
                or not isinstance(statuses, list) or not 1 <= len(statuses) <= 2
                or any(status not in {"completed", "cancelled", "failed"} for status in statuses)
                or expected_playback not in statuses
                or not bounded_integer(item.get("pcm_bytes"), 1_920_000)
                or item.get("pcm_bytes") == 0
                or not metrics_schema_valid(
                    item.get("metrics"), voice_outcome, role_id, "audio", len(statuses),
                )):
            return False
    return True


def ui_interactions_schema_valid(result: dict) -> bool:
    expected_kinds = ["read", "write", "chat"]
    expected_roles = ["robot", "robot", "human"]
    if (result.get("interaction_kinds") != expected_kinds
            or result.get("role_ids") != expected_roles
            or result.get("role_statuses") != ["completed"] * 3
            or result.get("voice_outcomes") != ["completed"] * 3
            or result.get("ui_delivery_statuses") != ["completed"] * 3
            or result.get("audio_delivery_statuses") != ["deferred"] * 3):
        return False
    interactions = result.get("interaction_metrics")
    if not isinstance(interactions, list) or len(interactions) != 3:
        return False
    return all(
        isinstance(item, dict)
        and set(item) == UI_METRIC_INTERACTION_KEYS
        and item.get("kind") == expected_kinds[index]
        and metrics_schema_valid(
            item.get("metrics"), "completed", expected_roles[index], "speakerless_ui",
        )
        for index, item in enumerate(interactions)
    )


def voice_result_summary_valid(result: dict) -> bool:
    return (
        pinned_version(result.get("tts_provider_version"))
        and pinned_revision(result.get("tts_model_revision"))
        and result.get("tts_calls") == 4
        and bounded_integer(result.get("tts_total_ms"), 4 * 600_000)
        and result.get("read_passed") is True
        and result.get("write_passed") is True
        and result.get("barge_in_passed") is True
        and result.get("followup_passed") is True
        and result.get("composition_audits_persisted") == 4
        and bounded_integer(result.get("playback_segments"), 4_096)
        and result.get("playback_segments") >= 4
        and bounded_integer(result.get("playback_bytes"), 7_680_000)
        and result.get("playback_bytes") > 0
    )


def ui_result_summary_valid(result: dict) -> bool:
    return (
        bounded_integer(result.get("real_model_calls"), 4_096)
        and result.get("real_model_calls") > 0
        and ui_model_timing_valid(result)
        and result.get("read_passed") is True
        and result.get("write_passed") is True
        and result.get("chat_passed") is True
        and result.get("ui_deliveries_completed") == 3
        and result.get("audio_delivery_deferred") is True
        and result.get("composition_audits_persisted") == 3
    )


def load_phase4_sensitive_audit():
    module_path = pathlib.Path(__file__).with_name("audit-phase4-sensitive-data.py")
    spec = importlib.util.spec_from_file_location("phase4_sensitive_audit_for_phase5e", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Phase 4 sensitive-data scanner is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PHASE4_AUDIT = load_phase4_sensitive_audit()


def read_secret(path: pathlib.Path) -> bytes:
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        raise RuntimeError("O_NOFOLLOW is required for secret safety")
    try:
        descriptor = os.open(path, os.O_RDONLY | nofollow | os.O_NONBLOCK)
    except OSError as error:
        raise ValueError("secret file must be a non-symlink regular file") from error
    try:
        info = os.fstat(descriptor)
        mode = stat.S_IMODE(info.st_mode)
        if not stat.S_ISREG(info.st_mode) or mode not in {0o400, 0o600}:
            raise ValueError("secret file must be a regular 0400 or 0600 file")
        if info.st_size < 1 or info.st_size > 65_536:
            raise ValueError("secret file size is outside the safe range")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            value = handle.read(65_537).strip()
    finally:
        os.close(descriptor)
    if not value or len(value) > 65_536:
        raise ValueError("secret file content is invalid")
    return value


def read_regular_file(path: pathlib.Path) -> bytes:
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        raise RuntimeError("O_NOFOLLOW is required for artifact safety")
    try:
        descriptor = os.open(path, os.O_RDONLY | nofollow | os.O_NONBLOCK)
    except OSError as error:
        raise ValueError("artifact must be a non-symlink regular file") from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("artifact must be a regular file")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            return handle.read()
    finally:
        os.close(descriptor)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=pathlib.Path)
    parser.add_argument("--source-archive", type=pathlib.Path)
    parser.add_argument("--artifact", action="append", required=True, type=pathlib.Path)
    parser.add_argument("--secret-file", action="append", required=True, type=pathlib.Path)
    parser.add_argument(
        "--artifact-sensitive-file", action="append", default=[], type=pathlib.Path,
    )
    parser.add_argument("--audit-db", type=pathlib.Path)
    parser.add_argument("--result", type=pathlib.Path)
    parser.add_argument("--status-file", required=True, type=pathlib.Path)
    args = parser.parse_args()
    reasons: set[str] = set()
    source_mode = "unavailable"
    secrets: list[bytes] = []
    artifact_only_secrets: list[bytes] = []
    try:
        secrets = [read_secret(path) for path in args.secret_file]
        artifact_only_secrets = [read_secret(path) for path in args.artifact_sensitive_file]
    except (OSError, RuntimeError, ValueError):
        reasons.add("secret_input")
    try:
        repo = args.repo.resolve(strict=True)
        if not repo.is_dir():
            raise ValueError("repository path must be a directory")
    except (OSError, ValueError):
        repo = None
        reasons.add("git_scan")
    if repo is not None:
        try:
            git_marker = (repo / ".git").lstat()
        except FileNotFoundError:
            git_marker = None
        except OSError:
            git_marker = False
            reasons.add("git_scan")
        if git_marker is not None and git_marker is not False \
                and stat.S_ISLNK(git_marker.st_mode):
            git_marker = False
            reasons.add("git_scan")
        for secret in dict.fromkeys(secrets):
            try:
                if git_marker is None:
                    source_mode = "archive"
                    if args.source_archive is None:
                        raise ValueError("gitless checkout requires its pinned source archive")
                    _objects_scanned, matches = PHASE4_AUDIT.scan_source_archive(
                        args.source_archive, secret,
                    )
                elif git_marker is False:
                    raise ValueError("repository metadata is unsafe")
                else:
                    source_mode = "git_objects"
                    _objects_scanned, matches = PHASE4_AUDIT.scan_git_objects(repo, secret)
                if _objects_scanned < 1:
                    raise RuntimeError("source scan returned no auditable objects")
            except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
                reasons.add("git_scan")
            else:
                if matches:
                    reasons.add("git_secret_leak")
            try:
                process_match = PHASE4_AUDIT.process_contains_secret(secret)
            except (OSError, RuntimeError, ValueError):
                reasons.add("process_scan")
            else:
                if process_match:
                    reasons.add("process_argv_secret_leak")
    for artifact in args.artifact:
        try:
            data = read_regular_file(artifact)
        except (OSError, RuntimeError, ValueError):
            reasons.add("artifact_input")
            continue
        if any(secret in data for secret in (*secrets, *artifact_only_secrets)):
            reasons.add("secret_leak")
        try:
            data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            reasons.add("non_utf8_artifact")
        if b"\x00" in data or any(byte < 32 and byte not in (9, 10, 13, 27) for byte in data):
            reasons.add("binary_artifact")
        if RAW_FIELD.search(data):
            reasons.add("raw_audio_field")
        if BASE64_CANDIDATE.search(data):
            reasons.add("long_base64")
    if args.result is not None:
        try:
            result = json.loads(read_regular_file(args.result).decode("utf-8"))
        except (OSError, RuntimeError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
            result = None
            reasons.add("result_schema")
        profile = result.get("profile") if isinstance(result, dict) else None
        expected_keys = (
            UI_RESULT_KEYS if profile == "phase5e_ui"
            else VOICE_RESULT_KEYS if profile == "phase5e_e2e"
            else None
        )
        expected_schema_version = 3 if profile == "phase5e_ui" else 2
        if (not isinstance(result, dict) or expected_keys is None
                or set(result) != expected_keys
                or result.get("schema_version") != expected_schema_version
                or not common_result_schema_valid(result, profile)):
            reasons.add("result_schema")
        elif profile == "phase5e_ui":
            if not ui_interactions_schema_valid(result):
                reasons.add("interaction_schema")
            if not ui_result_summary_valid(result):
                reasons.add("result_schema")
        elif profile == "phase5e_e2e":
            if not voice_interactions_schema_valid(result.get("interactions")):
                reasons.add("interaction_schema")
            if not voice_result_summary_valid(result):
                reasons.add("result_schema")
        if not isinstance(result, dict) or result.get("raw_audio_retained") is not False:
            reasons.add("retention_claim")
    if args.audit_db is not None and args.audit_db.is_file():
        audit_sqlite(args.audit_db, reasons)
    passed = not reasons
    args.status_file.write_text("pass\n" if passed else "fail\n", encoding="ascii")
    print(
        "VERIFY:phase5e:artifact_audit:PASS secrets=absent audio_payload=absent "
        f"source=clean source_mode={source_mode} process_argv=clean"
        if passed else f"VERIFY:phase5e:artifact_audit:FAIL reasons={','.join(sorted(reasons))}"
    )
    return 0 if passed else 1


def audit_sqlite(path: pathlib.Path, reasons: set[str]) -> None:
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        reasons.add("sqlite_shape")
        return
    try:
        with connection:
            tables = [row[1] for row in connection.execute("PRAGMA table_list")
                      if row[0] == "main"
                      and row[2] == "table"
                      and not str(row[1]).startswith("sqlite_")]
            for table in tables:
                if not isinstance(table, str) or not table.replace("_", "").isalnum():
                    reasons.add("sqlite_shape")
                    continue
                columns = list(connection.execute(f'PRAGMA table_info("{table}")'))
                names = [str(row[1]).lower() for row in columns]
                normalized_names = [re.sub(r"[^a-z0-9]", "", name) for name in names]
                if any("audio" in name or "pcm" in name for name in normalized_names):
                    reasons.add("raw_audio_column")
                for column in (str(row[1]) for row in columns):
                    if not column.replace("_", "").isalnum():
                        reasons.add("sqlite_shape")
                        continue
                    blob_count = connection.execute(
                        f'''SELECT COUNT(*) FROM "{table}"
                            WHERE typeof("{column}") = 'blob' '''
                    ).fetchone()[0]
                    if blob_count:
                        reasons.add("sqlite_blob")
                    for (value,) in connection.execute(
                        f'''SELECT "{column}" FROM "{table}"
                            WHERE typeof("{column}") = 'text' '''
                    ):
                        encoded = str(value).encode("utf-8")
                        if RAW_FIELD.search(encoded) or BASE64_CANDIDATE.search(encoded):
                            reasons.add("sqlite_raw_audio_value")
    except sqlite3.Error:
        reasons.add("sqlite_shape")
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
