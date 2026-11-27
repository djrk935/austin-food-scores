//! End-to-end tests of the release binary: parity with build.py (SPEC §9), the approved
//! deviations (SPEC §4.6), malformed rows (SPEC §2.2), guards (SPEC §7) and writes (SPEC §8).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const BIN: &str = env!("CARGO_BIN_EXE_pipeline-rs");

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A throwaway cache + output folder, run with `--offline` so tests never touch the network.
struct Workspace {
    root: PathBuf,
}

impl Workspace {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "pipeline-rs-test-{}-{name}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("cache")).unwrap();
        Self { root }
    }

    fn with_csv(name: &str, bytes: &[u8]) -> Self {
        let ws = Self::new(name);
        ws.set_csv(bytes);
        ws
    }

    fn with_fixture(name: &str, fixture_name: &str) -> Self {
        Self::with_csv(name, &fs::read(fixture(fixture_name)).unwrap())
    }

    fn cache(&self) -> PathBuf {
        self.root.join("cache")
    }

    fn out(&self) -> PathBuf {
        self.root.join("out")
    }

    fn set_csv(&self, bytes: &[u8]) {
        fs::write(self.cache().join("raw.csv"), bytes).unwrap();
    }

    fn run(&self, extra: &[&str]) -> Output {
        Command::new(BIN)
            .arg("--offline")
            .arg("--cache-dir")
            .arg(self.cache())
            .arg("--out")
            .arg(self.out())
            .args(extra)
            .output()
            .unwrap()
    }

    fn output(&self, name: &str) -> Value {
        read_json(&self.out().join(name))
    }

    fn out_files(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.out())
            .map(|dir| {
                dir.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn facility(&self, id: &str) -> Value {
        self.output("restaurants.json")
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f[0] == id)
            .unwrap_or_else(|| panic!("facility {id} missing"))
            .clone()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn assert_ok(output: &Output) {
    assert!(
        output.status.success(),
        "expected success, got {:?}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_failed_with(output: &Output, needle: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(
        !output.status.success(),
        "expected failure; stderr:\n{stderr}"
    );
    assert!(
        stderr.contains(needle),
        "stderr lacks {needle:?}:\n{stderr}"
    );
    stderr
}

// ---------- parity with build.py ----------

#[test]
fn golden_matches_python_reference() {
    let ws = Workspace::with_fixture("golden", "sample.csv");
    assert_ok(&ws.run(&[]));

    assert_eq!(
        ws.output("restaurants.json"),
        read_json(&fixture("expected/restaurants.json")),
        "restaurants.json differs from build.py's output"
    );

    let meta = ws.output("meta.json");
    let python_meta = read_json(&fixture("expected/meta.json"));
    for (key, value) in python_meta.as_object().unwrap() {
        if key == "built" {
            continue; // clock-dependent (SPEC §9.2)
        }
        assert_eq!(&meta[key], value, "meta.json field {key}");
    }
}

#[test]
fn golden_new_meta_fields() {
    let ws = Workspace::with_fixture("golden-meta", "sample.csv");
    assert_ok(&ws.run(&[]));
    let meta = ws.output("meta.json");

    let built = meta["built"].as_str().unwrap();
    assert!(
        built.ends_with("+00:00") && built.len() == 25,
        "built = {built}"
    );

    let sha: String = Sha256::digest(fs::read(fixture("sample.csv")).unwrap())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(meta["schemaVersion"], 1);
    assert_eq!(
        meta["fetchedAt"],
        Value::Null,
        "no fetch.json in an offline fixture run"
    );
    assert_eq!(meta["csvSha256"], sha);
    assert_eq!(meta["rows"], 20);
    assert_eq!(meta["malformedRows"], 0);
    assert_eq!(
        meta["anomalies"],
        json!({
            "blankScores": 2,
            "zeroScores": 1,
            "facilitiesWithoutCoordinates": 1,
            "sameDateTies": 1
        })
    );
}

/// SPEC §3.2 regression anchor: today's (wrong but stable) choice must only change on purpose.
#[test]
fn same_date_tie_keeps_first_csv_row_even_when_blank() {
    let ws = Workspace::with_fixture("tie", "sample.csv");
    assert_ok(&ws.run(&[]));
    let facility = ws.facility("12399010");
    assert_eq!(
        facility[6][0],
        json!(["2024-12-31", null, 0]),
        "blank row is current"
    );
    assert_eq!(facility[6][1], json!(["2024-12-31", 83, 0]));

    let python = read_json(&fixture("expected/restaurants.json"));
    let python_facility = python
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f[0] == "12399010")
        .unwrap();
    assert_eq!(python_facility[6][0], json!(["2024-12-31", null, 0]));
}

// ---------- approved deviations (SPEC §4.6) ----------

#[test]
fn bom_is_stripped() {
    let with_bom = fs::read(fixture("deviations/bom.csv")).unwrap();
    assert!(with_bom.starts_with(b"\xEF\xBB\xBF"));
    let bom = Workspace::with_csv("bom", &with_bom);
    let plain = Workspace::with_csv("no-bom", &with_bom[3..]);
    assert_ok(&bom.run(&[]));
    assert_ok(&plain.run(&[]));
    assert_eq!(
        bom.output("restaurants.json"),
        plain.output("restaurants.json")
    );
    assert_eq!(bom.output("meta.json")["inspections"], 2);
}

#[test]
fn non_ascii_digit_scores_are_null() {
    let ws = Workspace::with_fixture("digits", "deviations/nonascii_digit_score.csv");
    assert_ok(&ws.run(&[]));
    assert_eq!(
        ws.facility("500002")[6][0][1],
        Value::Null,
        "Arabic-Indic three"
    );
    assert_eq!(
        ws.facility("500003")[6][0][1],
        Value::Null,
        "superscript two"
    );
    assert_eq!(ws.facility("500004")[6][0][1], 90);
    assert_eq!(ws.output("meta.json")["anomalies"]["blankScores"], 2);
}

#[test]
fn non_finite_coordinates_are_missing() {
    let ws = Workspace::with_fixture("nonfinite", "deviations/nonfinite_coords.csv");
    assert_ok(&ws.run(&[]));
    for id in ["500005", "500006", "500007"] {
        let f = ws.facility(id);
        assert_eq!(
            (&f[4], &f[5]),
            (&Value::Null, &Value::Null),
            "facility {id}"
        );
    }
    assert_eq!(ws.facility("500008")[4], 30.8);
    // serde_json rejects bare NaN/Infinity, so this parse proves the file is valid JSON
    // (unlike build.py's output for the same input).
    let raw = fs::read_to_string(ws.out().join("restaurants.json")).unwrap();
    assert!(serde_json::from_str::<Value>(&raw).is_ok());
    assert!(!raw.contains(",NaN") && !raw.contains(",Infinity") && !raw.contains("-Infinity"));
    assert_eq!(
        ws.output("meta.json")["anomalies"]["facilitiesWithoutCoordinates"],
        3
    );
}

// ---------- malformed rows (SPEC §2.2) ----------

#[test]
fn short_row_fails_by_default() {
    let ws = Workspace::with_fixture("short-fail", "deviations/short_row.csv");
    let stderr = assert_failed_with(&ws.run(&[]), "malformed row at line 3");
    assert!(stderr.contains("--skip-malformed"));
    assert!(
        ws.out_files().is_empty(),
        "nothing written: {:?}",
        ws.out_files()
    );
}

#[test]
fn short_row_is_counted_with_skip_malformed() {
    let ws = Workspace::with_fixture("short-skip", "deviations/short_row.csv");
    let output = ws.run(&["--skip-malformed"]);
    assert_ok(&output);
    assert!(String::from_utf8_lossy(&output.stderr).contains("warning: skipping malformed row"));
    let meta = ws.output("meta.json");
    assert_eq!(meta["malformedRows"], 1);
    assert_eq!(meta["rows"], 3);
    assert_eq!(meta["inspections"], 2);
    assert_eq!(meta["skippedRows"], 0);
}

#[test]
fn header_only_file_fails() {
    let ws = Workspace::with_fixture("empty", "deviations/header_only.csv");
    assert_failed_with(&ws.run(&[]), "no usable inspections");
    assert!(ws.out_files().is_empty());
}

// ---------- guards (SPEC §7) ----------

#[test]
fn schema_guard_fires_on_renamed_columns() {
    let corrupted = fs::read_to_string(fixture("sample.csv"))
        .unwrap()
        .replacen("Restaurant Name,", "Facility Name,", 1)
        .replacen(",Address,", ",Location,", 1);
    let ws = Workspace::with_csv("schema", corrupted.as_bytes());
    let stderr = assert_failed_with(
        &ws.run(&[]),
        "missing required column(s): Restaurant Name, Address",
    );
    assert!(
        stderr.contains("Facility Name | Zip Code"),
        "prints the header found"
    );
    assert!(ws.out_files().is_empty());
}

#[test]
fn count_guard_fires_and_force_overrides() {
    let ws = Workspace::with_fixture("counts", "sample.csv");
    assert_ok(&ws.run(&[]));
    let before = fs::read(ws.out().join("restaurants.json")).unwrap();

    // Header plus the first two data rows: 20 -> 2 rows, 14 -> 2 facilities.
    let full = fs::read_to_string(fixture("sample.csv")).unwrap();
    let truncated: String = full.lines().take(3).map(|l| format!("{l}\n")).collect();
    ws.set_csv(truncated.as_bytes());

    let stderr = assert_failed_with(&ws.run(&[]), "count anomaly");
    assert!(stderr.contains("rows: 20 -> 2 (-90.0%)"), "{stderr}");
    assert!(stderr.contains("facilities: 14 -> 2 (-85.7%)"), "{stderr}");
    assert_eq!(
        fs::read(ws.out().join("restaurants.json")).unwrap(),
        before,
        "outputs untouched"
    );
    assert_eq!(
        ws.out_files(),
        ["meta.json", "restaurants.json"],
        "no temp files left"
    );

    assert_ok(&ws.run(&["--force"]));
    assert_eq!(ws.output("meta.json")["rows"], 2);
}

#[test]
fn count_guard_reads_rows_from_python_built_meta() {
    // A meta.json written by build.py has no `rows`; inspections + skippedRows stand in for it.
    let ws = Workspace::with_fixture("python-meta", "sample.csv");
    fs::create_dir_all(ws.out()).unwrap();
    fs::write(
        ws.out().join("meta.json"),
        r#"{"facilities": 14, "inspections": 100, "skippedRows": 0}"#,
    )
    .unwrap();
    assert_failed_with(&ws.run(&[]), "rows: 100 -> 20");
}

// ---------- CLI and writes ----------

#[test]
fn offline_without_cache_fails() {
    let ws = Workspace::new("no-cache");
    assert_failed_with(&ws.run(&[]), "--offline: no cached CSV");
}

#[test]
fn download_and_offline_conflict() {
    let ws = Workspace::new("conflict");
    assert_failed_with(&ws.run(&["--download"]), "cannot be used with");
}

#[test]
fn successful_run_leaves_no_temp_files() {
    let ws = Workspace::with_fixture("tmp", "sample.csv");
    assert_ok(&ws.run(&[]));
    assert_eq!(ws.out_files(), ["meta.json", "restaurants.json"]);
}
