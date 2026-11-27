//! Schema and count-anomaly guards. SPEC §7.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use anyhow::{Context, Result, bail};
use csv::StringRecord;
use serde_json::Value;

use crate::parse::REQUIRED_COLUMNS;

/// Allowed relative change in row or facility count before the build refuses to write.
const MAX_CHANGE: f64 = 0.20;

/// SPEC §7.1: every column parse extracts (build.py's read set) must be in the header.
pub fn check_schema(headers: &StringRecord) -> Result<()> {
    let missing: Vec<&str> = REQUIRED_COLUMNS
        .into_iter()
        .filter(|name| !headers.iter().any(|h| h == *name))
        .collect();
    if !missing.is_empty() {
        bail!(
            "schema drift: missing required column(s): {}\nheader found: {}",
            missing.join(", "),
            headers.iter().collect::<Vec<_>>().join(" | ")
        );
    }
    Ok(())
}

/// SPEC §7.2: compare against the previous build's meta.json, if there is one.
pub fn check_counts(previous_meta: &Path, rows: usize, facilities: usize) -> Result<()> {
    let text = match fs::read_to_string(previous_meta) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(e).with_context(|| format!("reading {}", previous_meta.display()));
        }
    };
    let previous: Value = serde_json::from_str(&text).with_context(|| {
        format!(
            "parsing previous {} (rerun with --force to skip the comparison)",
            previous_meta.display()
        )
    })?;

    let count = |key: &str| previous.get(key).and_then(Value::as_u64);
    // Builds made by build.py have no `rows`; it equals inspections + skippedRows there.
    let previous_rows = count("rows").or_else(|| {
        Some(count("inspections")? + count("skippedRows")? + count("malformedRows").unwrap_or(0))
    });

    let problems: Vec<String> = [
        ("rows", previous_rows, rows),
        ("facilities", count("facilities"), facilities),
    ]
    .into_iter()
    .filter_map(|(label, old, new)| {
        let old = old.filter(|&old| old > 0)?;
        let change = (new as f64 - old as f64) / old as f64;
        (change.abs() > MAX_CHANGE)
            .then(|| format!("{label}: {old} -> {new} ({:+.1}%)", change * 100.0))
    })
    .collect();

    if !problems.is_empty() {
        bail!(
            "count anomaly against {} (limit ±{:.0}%):\n  {}\nNothing was written. If the change is expected, rerun with --force.",
            previous_meta.display(),
            MAX_CHANGE * 100.0,
            problems.join("\n  ")
        );
    }
    Ok(())
}
