#!/usr/bin/env bash
# Build and run the pixel home host simulator.
#
# Two modes:
#   window  open an SDL window (needs DISPLAY / WAYLAND_DISPLAY; WSLg works)
#   dump    render N frames headless and convert them to PNG for review
#
# The simulator drives the same lv_draw_sw renderer at the same RGB565 colour
# depth and the same 1024x50 partial draw buffer as the panel, so it is the
# primary review loop for anything time-dependent (day/night, moon phase, window
# light, weather) that would take real hours to see on hardware.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="${repo_root}/sim/build"
out_dir="${repo_root}/sim/out"

mode="window"
frames=""
clock_speed="1"
start_hour="20"
scenario=""
verify_object_gate=""
verify_human_idle=""
zoom=""
crop=""
keep_ppm=""

usage() {
    cat <<'EOF'
usage: scripts/run-sim.sh [options]

  --mode window|dump     window opens SDL, dump writes PNG frames (default window)
  --frames N             frames to render in dump mode
  --clock-speed N        virtual seconds of wall clock per 125 ms tick
  --start-hour H         wall clock hour the replay starts at (0-23)
  --scenario             replay the scripted HA event sequence
  --verify-object-gate   assert Phase 3D anchor/facing/pose/animation bindings
  --verify-human-idle    fast-forward and assert Human night-idle sleep/wake policy
  --zoom N               upscale dumped PNGs N times (nearest neighbour)
  --crop X,Y,W,H         crop dumped PNGs to a region, in device pixels
  --keep-ppm             keep the intermediate PPM files
  --out DIR              output directory for dump mode (default sim/out)

examples:
  # 24 hours of sky, moon phase and window light compressed into ~30 s
  scripts/run-sim.sh --mode window --clock-speed 2880

  # walk the scripted event sequence and review every frame as PNG
  scripts/run-sim.sh --mode dump --scenario --zoom 1
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode) mode="$2"; shift 2 ;;
        --frames) frames="$2"; shift 2 ;;
        --clock-speed) clock_speed="$2"; shift 2 ;;
        --start-hour) start_hour="$2"; shift 2 ;;
        --scenario) scenario="1"; shift ;;
        --verify-object-gate) verify_object_gate="1"; mode="dump"; shift ;;
        --verify-human-idle) verify_human_idle="1"; mode="dump"; shift ;;
        --zoom) zoom="$2"; shift 2 ;;
        --crop) crop="$2"; shift 2 ;;
        --keep-ppm) keep_ppm="1"; shift ;;
        --out) out_dir="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown option: $1" >&2; usage; exit 2 ;;
    esac
done

# Sprites are generated sources, so regenerate before configuring: CMake globs
# them with CONFIGURE_DEPENDS and will pick up any new .pxart on this run.
python3 "${repo_root}/scripts/generate-pixel-sprites.py"

cmake -S "${repo_root}/sim" -B "${build_dir}" -G Ninja >/dev/null
ninja -C "${build_dir}"

sim_args=(--mode "${mode}" --clock-speed "${clock_speed}" --start-hour "${start_hour}")
[[ -n "${scenario}" ]] && sim_args+=(--scenario)
[[ -n "${verify_object_gate}" ]] && sim_args+=(--verify-object-gate)
[[ -n "${verify_human_idle}" ]] && sim_args+=(--verify-human-idle)
[[ -n "${frames}" ]] && sim_args+=(--frames "${frames}")

if [[ "${mode}" == "dump" ]]; then
    rm -rf "${out_dir}"
    mkdir -p "${out_dir}"
    sim_args+=(--out "${out_dir}")
fi

"${build_dir}/pixel_sim" "${sim_args[@]}"

if [[ "${mode}" != "dump" ]]; then
    exit 0
fi

convert_args=(--out-dir "${out_dir}")
[[ -n "${zoom}" ]] && convert_args+=(--zoom "${zoom}")
[[ -n "${crop}" ]] && convert_args+=(--crop "${crop}")

# shellcheck disable=SC2046  # deliberate word splitting over the frame list
python3 "${repo_root}/scripts/ppm_to_png.py" "${convert_args[@]}" \
    $(find "${out_dir}" -name 'frame_*.ppm' | sort) >/dev/null

if [[ -z "${keep_ppm}" ]]; then
    find "${out_dir}" -name 'frame_*.ppm' -delete
fi

echo "PNG frames in ${out_dir}"
