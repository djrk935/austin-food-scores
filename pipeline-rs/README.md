# pipeline-rs

Rust port of `pipeline/build.py`. It downloads the City of Austin's food inspection dataset and
writes `site/data/restaurants.json` and `site/data/meta.json`. The output matches the Python script's
by content; the rules are in [SPEC.md](SPEC.md).

## Build and run

Needs Rust stable (pinned in `rust-toolchain.toml`; install with [rustup](https://rustup.rs)).

```bash
cargo run --release -- --download
```

That fetches the CSV (a conditional GET, so an unchanged dataset isn't downloaded again) and rebuilds
`site/data/`. Paths are relative to the repo, so it works from any folder.

| Flag | What it does |
|---|---|
| (none) | Use the cached `data/raw.csv` if present, otherwise download (like `build.py`) |
| `--download` | Always ask the server; on a 304 Not Modified, the cached CSV is reused |
| `--offline` | Never touch the network; fail if no cached CSV exists |
| `--cache-dir DIR` | Where `raw.csv` and `fetch.json` live (default `data/`) |
| `--out DIR` | Where the JSON goes (default `site/data/`) |
| `--force` | Write even if row or facility counts moved more than 20% since the last build |
| `--skip-malformed` | Skip and count rows missing required fields instead of failing |

The run fails, without writing anything, when:
- a required column is missing from the CSV (schema guard);
- row or facility counts change by more than 20% from the previous `meta.json` (use `--force` if the
  change is expected);
- a row is missing required fields (use `--skip-malformed` to count and skip such rows instead);
- the CSV has no usable rows.

Outputs are written to `*.json.tmp` and renamed into place, so a failed run never leaves a
half-written file.

## Checks

```bash
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

`tests/golden.rs` compares the binary's output on `tests/fixtures/sample.csv` with the output of
`build.py` on the same file, which is committed in `tests/fixtures/expected/`. Regenerate that output
after an intentional change to `build.py`:

```bash
python3 -I tests/fixtures/gen_expected.py
```

## Known issue

Same-date inspection ties follow the CSV's row order, as in `build.py`, and the city's export order
changes between downloads. See SPEC.md §3.3 before relying on the "current" score of a facility with
two inspections on the same day.
