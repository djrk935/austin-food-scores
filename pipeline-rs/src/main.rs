//! Builds `site/data/restaurants.json` and `site/data/meta.json` from the City of Austin's
//! food inspection dataset. Rust port of `pipeline/build.py`; behavior is specified in SPEC.md.

mod emit;
mod fetch;
mod group;
mod guard;
mod parse;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::Parser;

/// Build Austin Food Scores data from the City of Austin inspection dataset.
#[derive(Parser, Debug)]
#[command(name = "pipeline-rs", version)]
struct Args {
    /// Always contact the server (conditional GET). Without it, a cached CSV is used if present.
    #[arg(long, conflicts_with = "offline")]
    download: bool,

    /// Never touch the network; fail if there is no cached CSV.
    #[arg(long)]
    offline: bool,

    /// Folder holding raw.csv and fetch.json [default: <repo>/data]
    #[arg(long, value_name = "DIR")]
    cache_dir: Option<PathBuf>,

    /// Folder to write restaurants.json and meta.json to [default: <repo>/site/data]
    #[arg(long, value_name = "DIR")]
    out: Option<PathBuf>,

    /// Write even if row or facility counts moved more than 20% since the last build.
    #[arg(long)]
    force: bool,

    /// Skip and count rows missing required fields instead of failing.
    #[arg(long)]
    skip_malformed: bool,
}

/// SPEC §1: defaults are relative to the repo, like build.py, not to the current directory.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn main() -> Result<()> {
    let args = Args::parse();
    let root = repo_root();
    let cache_dir = args.cache_dir.unwrap_or_else(|| root.join("data"));
    let out_dir = args.out.unwrap_or_else(|| root.join("site").join("data"));
    let mode = if args.offline {
        fetch::Mode::Offline
    } else if args.download {
        fetch::Mode::Download
    } else {
        fetch::Mode::Auto
    };

    let cached = fetch::ensure_csv(&cache_dir, mode)?;
    let bytes = fs::read(&cached.csv_path)
        .with_context(|| format!("reading {}", cached.csv_path.display()))?;
    let csv_sha256 = fetch::sha256_hex(&bytes);
    // SPEC §5.2: only trust fetch.json's timestamp if it describes this exact file.
    let fetched_at = cached
        .record
        .filter(|r| r.sha256.as_deref() == Some(csv_sha256.as_str()))
        .and_then(|r| r.fetched_at);

    guard::check_schema(&parse::headers(&bytes)?)?;
    let parsed = parse::read_csv(&bytes, args.skip_malformed)?;
    let grouped = group::group(&parsed.rows);
    let Some((oldest, newest)) = group::date_range(&grouped.facilities) else {
        bail!(
            "no usable inspections in {} ({} rows read, {} skipped); refusing to write empty output",
            cached.csv_path.display(),
            parsed.records_read,
            grouped.skipped_rows
        );
    };

    let meta = emit::Meta {
        source: fetch::SOURCE_PAGE.to_owned(),
        built: emit::built_timestamp(),
        oldest_inspection: oldest.to_string(),
        newest_inspection: newest.to_string(),
        facilities: grouped.facilities.len(),
        inspections: grouped.facilities.iter().map(|f| f.inspections.len()).sum(),
        skipped_rows: grouped.skipped_rows,
        schema_version: 1,
        fetched_at,
        csv_sha256,
        rows: parsed.records_read,
        malformed_rows: parsed.malformed,
        anomalies: group::anomalies(&grouped.facilities),
    };

    if !args.force {
        guard::check_counts(&out_dir.join("meta.json"), meta.rows, meta.facilities)?;
    }
    emit::write_outputs(&out_dir, &grouped.facilities, &meta)?;
    println!("{}", serde_json::to_string_pretty(&meta)?);
    Ok(())
}
