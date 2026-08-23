# P4Home STT Python Runtime

- Runtime is pinned to CPython `>=3.12,<3.13`; it must not use the ESP-IDF Python environment.
- `uv.lock` freezes `mlx-whisper==0.4.3` and all transitive Python dependencies.
- Runtime accepts only the local `mlx-community/whisper-small-mlx` snapshot at revision
  `45f3915923c7a79a5a5b5a7d909d39aeb0e5630e`.
- `prepare_model.py` refuses an existing output path, downloads only required files, hashes them and writes
`p4home-model-manifest.json`. Runtime does not download or update a model.
- `prepare_model.py --verify /absolute/model/path` re-hashes the exact allowlisted files and fails closed
  on additions, symlinks, revision drift or content drift.
- PCM is passed once through stdin and transcribed in memory; stdout contains one bounded JSON terminal and never PCM.

Create the environment and model outside the repository:

```sh
uv sync --frozen --python /opt/homebrew/bin/python3.12
uv run --frozen python prepare_model.py --output /absolute/private/model/path
```
