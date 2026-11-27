# pipeline-rs spec

This describes the Rust port of `pipeline/build.py`. Rules marked *(parity)* reproduce `build.py`
exactly; rules marked *(new)* are additions that were approved for this port. Code comments
reference sections here as `SPEC §n`.

Sources read: `pipeline/build.py`, `site/data/meta.json` (built 2026-11-26T20:11:02+00:00) and
`data/raw.csv` (20,156 rows, downloaded 2026-11-26).

---

## §0 Rulings

The open questions from the Step 0 review, as decided:

| Item | Ruling |
|---|---|
| A1 Schema guard columns | The 10 columns `build.py` reads (§7.1), **derived from `build.py`'s read set, not from the task brief**. |
| A2 Pipeline vs. site | The pipeline only emits data. Current-score selection, blank/0 flags and color bands stay in `site/app.js` and are documented in §10. |
| A3 Same-date ties | Keep Python's behavior (CSV order) in this port. The rule sits in exactly one function (§3.2), and a regression fixture locks it in. The fix is a later, separate change (§3.3). |
| A4 Setup | `git init` with a baseline commit before any Rust. Rust installed through `rustup`, stable toolchain pinned in `rust-toolchain.toml`. CI left alone. |
| B Deviations | All four approved (§4.6). Malformed rows fail the build by default; `--skip-malformed` turns them into a counted warning. |
| C1 Blank vs. zero | Disjoint: 45 scores are exactly empty and 7 are `0` (§5.2). |
| C2 Golden harness | Import `build.py` and call `build()`; the module does nothing when imported (§9.2). |

---

## §1 CLI and inputs

| Flag | Default | Behavior |
|---|---|---|
| (none) | | Use `<cache-dir>/raw.csv` if it exists, without touching the network. Otherwise download. *(parity)* |
| `--download` | off | Always contact the server, with a conditional GET (§6). *(parity, plus the 304 shortcut)* |
| `--offline` | off | Never touch the network. Error if `<cache-dir>/raw.csv` is missing. *(new)* |
| `--cache-dir <dir>` | `<repo>/data` | Holds `raw.csv` and `fetch.json`. *(new flag, parity default)* |
| `--out <dir>` | `<repo>/site/data` | Where the JSON files are written. *(new flag, parity default)* |
| `--force` | off | Skip the count-anomaly guard (§7.2). *(new)* |
| `--skip-malformed` | off | Skip malformed rows and count them instead of failing (§2.2). *(new)* |

`--download` and `--offline` together are an error.

`<repo>` is the parent of the `pipeline-rs` folder, fixed at compile time (`CARGO_MANIFEST_DIR/..`).
This matches `build.py`, which works out its paths from where the script lives, not from the
current directory.

Download *(parity)*: GET `https://data.austintexas.gov/api/views/ecmv-9xxi/rows.csv?accessType=DOWNLOAD`
with `User-Agent: austin-scores-builder` and a 180 s timeout. The body is saved byte for byte.

## §2 Rows

### §2.1 Reading *(parity)*
The file is read as UTF-8 CSV in the standard format: `"` quotes fields, `""` is an escaped quote,
and quoted fields may contain commas and newlines. The first record is the header. Fields are looked
up by header name, not by position. Columns that aren't needed are ignored, and so are extra fields
past the end of the header.

A leading UTF-8 byte-order mark is removed before parsing (§4.6).

### §2.2 Malformed rows *(new)*
A row is **malformed** if it has too few fields to supply all 10 required columns (§7.1). Python
crashes on such a row with `AttributeError`. A row that is missing only the trailing columns
`build.py` never reads (`GeoReferenct`, `InspectionScoreCategory`) is **not** malformed: Python
handles it, and so does Rust.

- Default: exit non-zero and report the row's record number. No output is written.
- `--skip-malformed`: skip the row, print a warning, and add 1 to `malformedRows` in `meta.json`.

### §2.3 Skipped rows *(parity)*
Rows are handled in CSV order. A row is **skipped** (`skippedRows` += 1) when:

1. its trimmed `Facility ID` is blank, **or** its trimmed `InspectionID` has already been seen; or
2. its `Inspection Date` doesn't parse (§4.1).

- An `InspectionID` is recorded as seen only **after** the row passes the date check. So if the first
  copy has a bad date, a later copy with a good date is kept.
- A blank `InspectionID` is an ordinary value. The first row with a blank ID is kept, and later ones
  are skipped as duplicates. The current data has none.
- No date window is applied. The city's data already covers only the last three years.

The current data has 0 skipped and 0 malformed rows.

## §3 Grouping, ordering and the same-date tie-break

### §3.1 Grouping *(parity)*
One record per trimmed `Facility ID`. Facility attributes come from the first kept row for that ID
(§4.5). Coordinates come from the last kept row that has a valid pair (§4.4).

### §3.2 Inspection order and ties *(parity)*
Each facility's inspections are ordered **newest date first**. Inspections on the same date are
ordered by **their position in the source CSV, earliest first**. This is what Python's stable sort
on date gives.

The site shows the first inspection as the current one (§10.1). So for a same-date tie, the row that
comes first in the CSV becomes the current inspection, **even if it has a blank score and a later
row has a real one**.

In code this rule lives in exactly one place: `group::same_date_tiebreak`. Nothing else decides how
ties are ordered.

**Regression anchor:** facility `12399010` has two inspections on 2024-12-31: a blank score (CSV
row 1,785, `InspectionID` 1460333) and an 83 (CSV row 16,127, `InspectionID` 1417043). The blank
comes first and is what the site shows. The fixture reproduces this, and the golden test asserts the
blank wins.

### §3.3 Follow-up fix (out of scope here)
- **Where it belongs:** most likely in the pipeline, not in `app.js`. The pipeline should emit an
  order that already applies the rule (a scored inspection before a blank one, then higher
  `InspectionID` first), so the site stays simple and the rule can be tested in Rust. The change is
  confined to `same_date_tiebreak` plus the fixture's expected output, so it shows up as a
  deliberate, visible diff.
- **What it affects:** of the 17 facilities with same-date ties today, only the **8 with different
  scores** matter. The other 9 only need a stable order and wouldn't change what the site shows.
- **Monitoring:** the tie count is recorded in `meta.json` as `anomalies.sameDateTies` (17 today).
  A change in that number should trigger an alert, because the fixture can't detect the city
  reordering its export. The count alone won't catch a reorder (see the evidence below); a change in
  `csvSha256` while every count stays the same is the signal to watch.
- **Evidence the city reorders its export (2026-11-26):** two downloads about a minute apart had
  identical rows (same multiset, 3,727,032 bytes each) in a different order: 20,152 of 20,156 rows
  moved, and 6 of the 17 tie groups flipped. Running either file through `build.py` and through
  `pipeline-rs` gives identical output, so parity holds. But between the two downloads, 3 facilities
  changed, and for `12399010` the current inspection changed from blank to 83. **What the site shows
  for a tied facility can change from one nightly run to the next with no change in the underlying
  data.** That makes the fix more urgent.

## §4 Field parsing

"Trim" here means Python `str.strip()`: remove characters for which `str.isspace()` is true.
That's Unicode whitespace plus the separator characters `\x1c`–`\x1f`, which Rust's `trim()` doesn't
include, so the code uses its own helper. "Split on whitespace" uses the same set.

### §4.1 Inspection date *(parity)*
Trim, then match Python's `strptime(s, "%m/%d/%Y")`:
- month: 1–2 digits, value 1–12;
- day: 1–2 digits, value 1–31, or a space followed by one digit (`strptime` accepts `" 5"`);
- year: exactly 4 digits, value at least 1;
- the date must exist on the calendar (`02/30/2026` fails);
- nothing else may be in the string.

Emitted as ISO `YYYY-MM-DD`. Every date in the current data is 10 characters and zero-padded.

### §4.2 Score *(parity, with §4.6)*
Trim. If the result is non-empty, entirely ASCII `0-9` and fits in a `u32`, emit it as an integer;
otherwise emit `null`. So `""`, `"92.5"`, `"-1"`, `"+90"`, `"٣"` and `"²"` all become `null`.
A recorded `0` stays `0`, not `null`. Values above 100 aren't checked.

### §4.3 Follow-up flag *(parity)*
`1` if the lowercased `Process Description` contains `follow`, otherwise `0`.

### §4.4 Coordinates *(parity, with §4.6)*
`lat` and `lng` are each trimmed and parsed as decimal floats, then rounded to 5 decimal places
(§5.3). A facility's coordinates are set only when **both** parse to finite numbers. Each later kept
row with a valid pair overwrites the earlier one, so the last valid pair wins. With no valid pair,
both are `null`. Those facilities still appear in `restaurants.json` and in search; the site just
draws no marker for them. The current data has 200 such facilities, and no facility has conflicting
coordinates.

### §4.5 Facility attributes *(parity)*
From the first kept row for each facility:
- `name`: `Restaurant Name`, trimmed;
- `address`: `Address`, split on whitespace and rejoined with single spaces (this also flattens
  embedded newlines);
- `zip`: `Zip Code`, trimmed, then the first 5 characters.

### §4.6 Approved deviations *(new)*
These apply only to inputs that don't occur in today's data. Where Python would crash or write
invalid JSON, Rust behaves as follows:

| Input | Python | Rust |
|---|---|---|
| Leading UTF-8 BOM | the header key becomes `﻿Restaurant Name`, then a `KeyError` crash | the BOM is removed |
| Non-ASCII digit score (`²`, `٣`) | `²` crashes; `٣` becomes 3 | `null` |
| Score too large for `u32` | an arbitrarily large integer | `null` |
| `NaN` / `Infinity` coordinate | writes `NaN`, which is invalid JSON | treated as missing |
| Coordinate with an underscore (`30_1`) | accepted by `float()` | treated as missing |
| Non-ASCII digits in a date's **year** (`01/05/٢٠٢٦`) | accepted: `%Y` uses `\d`, which matches them (month and day use `[0-9]`, so Python rejects those too) | the date doesn't parse, so the row is skipped |
| Malformed row (§2.2) | `AttributeError` crash | error, or a counted skip with `--skip-malformed` |
| No kept rows | `ValueError` crash from `min()` on an empty list | exit non-zero with a clear message |

## §5 Output files

Both are written to `--out`.

### §5.1 `restaurants.json` *(parity)*
A compact JSON array with no whitespace, sorted by `name` lowercased (a stable sort, so facilities
with the same name keep the order in which they first appeared). Each facility is a **positional
array**:

| Index | Field | Type |
|---|---|---|
| 0 | facility id | string (the trimmed `Facility ID`, e.g. `"11015981"`) |
| 1 | name | string |
| 2 | address | string |
| 3 | zip | string |
| 4 | lat | number or null |
| 5 | lng | number or null |
| 6 | inspections | array, in §3.2 order |

Each inspection is `[date "YYYY-MM-DD", score (integer or null), followUp (0 or 1)]`.

### §5.2 `meta.json`
Pretty-printed with a 2-space indent. The fields `build.py` already writes keep their order and
meaning *(parity)*:

| Field | Type | Meaning |
|---|---|---|
| `source` | string | `https://data.austintexas.gov/d/ecmv-9xxi` |
| `built` | string | UTC build time to the second, `YYYY-MM-DDTHH:MM:SS+00:00` |
| `oldestInspection` | string | earliest emitted inspection date |
| `newestInspection` | string | latest emitted inspection date |
| `facilities` | int | number of facility records |
| `inspections` | int | number of kept inspections |
| `skippedRows` | int | rows skipped under §2.3 |

The following fields are appended after those *(new)*:

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | int | `1` |
| `fetchedAt` | string or null | RFC 3339 time the cached CSV was last downloaded or confirmed by a 304. `null` when there's no `fetch.json` or when its `sha256` doesn't match the CSV being used (the file was replaced by hand) |
| `csvSha256` | string | lowercase hex SHA-256 of the CSV file's bytes |
| `rows` | int | data records read, excluding the header; always `inspections + skippedRows + malformedRows` |
| `malformedRows` | int | rows skipped under `--skip-malformed`; otherwise always 0 |
| `anomalies.blankScores` | int | kept inspections whose score is `null` |
| `anomalies.zeroScores` | int | kept inspections whose recorded score is `0` |
| `anomalies.facilitiesWithoutCoordinates` | int | facilities with `lat`/`lng` of `null` |
| `anomalies.sameDateTies` | int | facilities with 2 or more kept inspections on the same date |

`blankScores` and `zeroScores` **can't overlap**: a score is either `null` or a number. The current
data has 45 blank scores (all of them empty strings, none unparseable) and 7 zeros (C1).
Expected values today: 45, 7, 200, 17.

### §5.3 Number formatting and known byte differences
The output is compared by content, never byte for byte. Two harmless byte differences from Python
are documented here and **not worked around in code**:
- **Non-ASCII text:** Python's `json.dumps` escapes it as `\uXXXX`; `serde_json` writes UTF-8 directly.
  Four rows today contain non-ASCII characters.
- **Floats:** both print the shortest text that reads back to the same value (`30.34362`). Edge cases
  such as `-0.0` may print differently while parsing to the same value.

Rounding to 5 decimals matches Python's `round(x, 5)`: correctly rounded from the exact binary
value, with exact ties going to the even digit. Every current coordinate already has at most 5
decimals.

## §6 Fetch and cache *(new)*

`--cache-dir` holds `raw.csv` and `fetch.json` (`{ etag, lastModified, fetchedAt, sha256 }`).
- `--download`: if `raw.csv` exists, send **`If-Modified-Since`** with the saved `lastModified`.
  Only when there's no `lastModified` is `If-None-Match` sent with the saved `etag`.
  **Why not both:** tested against the live server on 2026-11-26. Its CDN rewrites ETags on gzip
  responses (`"…--gzip--gzip"`), so a stored ETag never matches. Under RFC 9110 §13.2.2, a failed
  `If-None-Match` overrides `If-Modified-Since`, so sending both always got a full 200 response.
  `If-Modified-Since` on its own gets a `304`. Both values are still saved in `fetch.json`.
  - On **304**, keep `raw.csv` and update `fetchedAt`.
  - On **200**, write the body to `raw.csv.tmp`, rename it to `raw.csv`, then write `fetch.json` the
    same way.
  - Any other status is an error, and the cache is left unchanged.
- Default mode, and `--offline`, never touch the network.

## §7 Guards *(new)*

### §7.1 Schema guard
Required columns, **derived from `build.py`'s read set, not from the task brief**. These are the
`r["…"]` lookups in `build()`:

`Facility ID`, `InspectionID`, `Inspection Date`, `Restaurant Name`, `Address`, `Zip Code`, `lat`,
`lng`, `Score`, `Process Description`.

The guard runs after the header is read and before any rows are processed. If a column is missing,
it prints every missing column along with the header that was found, and exits non-zero. No files are
written. The list is `parse::REQUIRED_COLUMNS`, the same constant parse uses to find the columns it
reads, so the guarded columns and the columns read can't diverge. If `build.py` starts reading
another column, add it there.

### §7.2 Count-anomaly guard
If `<out>/meta.json` exists from a previous build, compare:
- **rows**: the previous `rows`, or, for older files without it, the previous
  `inspections + skippedRows (+ malformedRows if present)`;
- **facilities**.

If either has changed by more than 20% in either direction (`|new − old| / old > 0.20`), print both
numbers and the percentage change, then exit non-zero without writing anything. `--force` skips the
guard. Nothing is checked when there's no previous `meta.json`, or when a previous count is 0.

## §8 Writes *(new)*

Both files are written to `<name>.json.tmp`. Only after both writes succeed are they renamed over
the final paths with `std::fs::rename`: `restaurants.json` first, then `meta.json`. If anything fails
before the renames, the temp files are removed and the existing outputs are left alone.

## §9 Parity testing

### §9.1 Fixtures
- `tests/fixtures/sample.csv` is the **parity fixture**. Both Python and Rust run it, and the results
  must match. It covers: a comma in a name, escaped quotes, an embedded newline, a blank score, a
  `0` score, missing coordinates, a facility with several inspections, the §3.2 tie anchor
  (facility `12399010`, 2024-12-31, blank first then 83), a duplicate `InspectionID`, a bad date, a
  blank `Facility ID`, an unpadded date, a follow-up inspection, non-ASCII text, a ZIP+4, duplicate
  and differently-cased names, a 6-decimal coordinate, and a short row missing only the unread
  trailing columns.
- `tests/fixtures/deviations/*.csv` holds the **Rust-only fixtures** for the §4.6 inputs: BOM,
  non-ASCII digit scores, `NaN`/`Infinity` coordinates, a malformed short row, and a header-only
  file. Python crashes or writes invalid JSON on these, so they can't be in the parity fixture.
  Their expected results are written by hand in the tests.

### §9.2 Golden output
`tests/fixtures/expected/` is produced by `tests/fixtures/gen_expected.py`. That script imports
`pipeline/build.py` by its file path, points the module globals `RAW` and `OUT` at the fixture and
the expected folder, and calls `build()`.

**Why import instead of a subprocess (C2):** `build.py` does nothing when imported. Its top level is
only imports, constants and path calculations, and `__main__` is guarded. It also has no flag to
change paths, so a subprocess couldn't be pointed at the fixture without editing it. Calling
`build()` runs the same function the nightly job runs. The only part not exercised is `download()`,
which needs the network.

The golden test runs the release binary with `--offline` on a copy of the fixture, then checks that:
- `restaurants.json` equals the expected file once both are parsed as JSON;
- in `meta.json`, every key Python writes matches, **except `built`**, which depends on the clock;
- facility `12399010`'s first inspection is `["2024-12-31", null, 0]`.

## §10 Site-side rules — not pipeline responsibilities

These rules live in `site/app.js`. They're recorded here so they don't get duplicated or moved into
the wrong layer by accident. The pipeline must not implement them; its job is to emit data that keeps
them working (newest-first order, `null` for blank, `0` kept as `0`).

### §10.1 Current score selection
`latest(r) = r[6][0]`: the first inspection in pipeline order is the current one. So §3.2 decides
which inspection the site shows.

### §10.2 Blank and zero scores
`rankable()` excludes inspections whose score is `null` or `0` from the "lowest scores", "perfect
100s" and summary stats. On a restaurant's page they're shown with a note that they're usually gaps
in the city's records. A blank or 0 latest score gets the gray "no score" badge.

### §10.3 Color bands
`band()`: `null` or `0` → none (gray); `≥ 90` → good (green); `70–89` → ok (yellow); `< 70` → bad
(red). These match the city's own `InspectionScoreCategory` values in the source CSV (`90+ (Green)`,
`70-89 (Yellow)`, ` Under 70 (Red)`). `build.py` ignores that column, and so does the Rust pipeline.
