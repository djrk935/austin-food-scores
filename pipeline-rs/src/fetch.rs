//! Download and cache the source CSV. SPEC §1, §6.

use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SOURCE_CSV: &str =
    "https://data.austintexas.gov/api/views/ecmv-9xxi/rows.csv?accessType=DOWNLOAD";
pub const SOURCE_PAGE: &str = "https://data.austintexas.gov/d/ecmv-9xxi";
const USER_AGENT: &str = "austin-scores-builder";
const TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Use the cached CSV if present, otherwise download (build.py's default).
    Auto,
    /// Always ask the server, conditionally.
    Download,
    /// Never touch the network.
    Offline,
}

/// Contents of `fetch.json` in the cache folder.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRecord {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub fetched_at: Option<String>,
    pub sha256: Option<String>,
}

pub struct Cached {
    pub csv_path: PathBuf,
    pub record: Option<FetchRecord>,
}

pub fn ensure_csv(cache_dir: &Path, mode: Mode) -> Result<Cached> {
    let csv_path = cache_dir.join("raw.csv");
    let record_path = cache_dir.join("fetch.json");
    let record = read_record(&record_path);
    let have_csv = csv_path.is_file();

    let record = match mode {
        Mode::Offline if !have_csv => bail!(
            "--offline: no cached CSV at {}; run once with --download first",
            csv_path.display()
        ),
        Mode::Offline => record,
        Mode::Auto if have_csv => {
            eprintln!("using cached {}", csv_path.display());
            record
        }
        Mode::Auto => Some(download(&csv_path, &record_path, None)?),
        Mode::Download => {
            let previous = if have_csv { record.as_ref() } else { None };
            Some(download(&csv_path, &record_path, previous)?)
        }
    };
    Ok(Cached { csv_path, record })
}

fn read_record(path: &Path) -> Option<FetchRecord> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => return None,
        Err(e) => {
            eprintln!("warning: ignoring unreadable {}: {e}", path.display());
            return None;
        }
    };
    match serde_json::from_str(&text) {
        Ok(record) => Some(record),
        Err(e) => {
            eprintln!("warning: ignoring malformed {}: {e}", path.display());
            None
        }
    }
}

/// Conditional GET (SPEC §6). `previous` carries the validators of the CSV already on disk.
fn download(
    csv_path: &Path,
    record_path: &Path,
    previous: Option<&FetchRecord>,
) -> Result<FetchRecord> {
    let agent = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .build();
    let mut request = agent.get(SOURCE_CSV);
    // SPEC §6: prefer If-Modified-Since. The city's CDN rewrites ETags on gzip responses
    // ("…--gzip--gzip"), so a stored ETag never matches, and a failed If-None-Match overrides
    // If-Modified-Since (RFC 9110 §13.2.2). The ETag is only used when there's no Last-Modified.
    if let Some(prev) = previous {
        if let Some(modified) = &prev.last_modified {
            request = request.set("If-Modified-Since", modified);
        } else if let Some(etag) = &prev.etag {
            request = request.set("If-None-Match", etag);
        }
    }

    let response = match request.call() {
        Ok(response) => response,
        Err(ureq::Error::Status(code, _)) => {
            bail!("download failed: server returned HTTP {code}; cache left unchanged")
        }
        Err(e) => return Err(anyhow::Error::new(e)).context("download failed"),
    };

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let record = match (response.status(), previous) {
        (304, Some(prev)) => {
            eprintln!(
                "server says unchanged (304); keeping {}",
                csv_path.display()
            );
            FetchRecord {
                fetched_at: Some(now),
                ..prev.clone()
            }
        }
        (200, _) => {
            let etag = response.header("ETag").map(str::to_owned);
            let last_modified = response.header("Last-Modified").map(str::to_owned);
            let mut body = Vec::new();
            response
                .into_reader()
                .read_to_end(&mut body)
                .context("reading download body")?;
            if let Some(dir) = csv_path.parent() {
                fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
            }
            write_then_rename(csv_path, &body)?;
            eprintln!("downloaded {} bytes to {}", body.len(), csv_path.display());
            FetchRecord {
                etag,
                last_modified,
                fetched_at: Some(now),
                sha256: Some(sha256_hex(&body)),
            }
        }
        (status, _) => bail!("download failed: unexpected HTTP {status}; cache left unchanged"),
    };

    write_then_rename(record_path, &serde_json::to_vec_pretty(&record)?)?;
    Ok(record)
}

/// Write to `<name>.tmp`, then rename over `path`, so the cache never holds a partial file.
fn write_then_rename(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    fs::rename(&tmp, path)
        .with_context(|| format!("renaming {} to {}", tmp.display(), path.display()))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
