//! Serialize the output files and write them atomically. SPEC §5, §8.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::Utc;
use serde::Serialize;

use crate::group::{Anomalies, Facility};

/// `meta.json`. The first seven fields mirror build.py, in its order (SPEC §5.2).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub source: String,
    pub built: String,
    pub oldest_inspection: String,
    pub newest_inspection: String,
    pub facilities: usize,
    pub inspections: usize,
    pub skipped_rows: usize,
    pub schema_version: u32,
    pub fetched_at: Option<String>,
    pub csv_sha256: String,
    pub rows: usize,
    pub malformed_rows: usize,
    pub anomalies: Anomalies,
}

/// build.py writes `datetime.now(timezone.utc).isoformat(timespec="seconds")`.
pub fn built_timestamp() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
}

/// One positional row of `restaurants.json` (SPEC §5.1).
type FacilityRow<'a> = (
    &'a str,
    &'a str,
    &'a str,
    &'a str,
    Option<f64>,
    Option<f64>,
    Vec<(String, Option<u32>, u8)>,
);

fn facility_row(f: &Facility) -> FacilityRow<'_> {
    (
        &f.id,
        &f.name,
        &f.address,
        &f.zip,
        f.coords.map(|c| c.0),
        f.coords.map(|c| c.1),
        f.inspections
            .iter()
            .map(|i| (i.date.to_string(), i.score, u8::from(i.follow_up)))
            .collect(),
    )
}

/// SPEC §8: both files go to `*.json.tmp` first; renames happen only once both writes succeed.
pub fn write_outputs(out_dir: &Path, facilities: &[Facility], meta: &Meta) -> Result<()> {
    fs::create_dir_all(out_dir).with_context(|| format!("creating {}", out_dir.display()))?;
    let rows: Vec<FacilityRow> = facilities.iter().map(facility_row).collect();
    let files = [
        (out_dir.join("restaurants.json"), serde_json::to_vec(&rows)?),
        (out_dir.join("meta.json"), serde_json::to_vec_pretty(meta)?),
    ];

    let mut written: Vec<(PathBuf, &Path)> = Vec::new();
    for (path, bytes) in &files {
        let tmp = tmp_path(path);
        if let Err(e) = fs::write(&tmp, bytes) {
            for (done, _) in &written {
                let _ = fs::remove_file(done);
            }
            let _ = fs::remove_file(&tmp);
            return Err(e).with_context(|| format!("writing {}", tmp.display()));
        }
        written.push((tmp, path));
    }
    for (tmp, path) in &written {
        fs::rename(tmp, path)
            .with_context(|| format!("renaming {} to {}", tmp.display(), path.display()))?;
    }
    Ok(())
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    path.with_file_name(name)
}
