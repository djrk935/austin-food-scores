//! CSV reading and field parsing. SPEC §2, §4.

use anyhow::{Context, Result, bail};
use chrono::NaiveDate;
use csv::StringRecord;

/// SPEC §7.1: the columns this module extracts, derived from build.py's read set (the `r["…"]`
/// lookups in `build()`), not from the task brief. The schema guard checks exactly this list, so
/// adding a column here is the only way to read (and guard) another one.
pub const REQUIRED_COLUMNS: [&str; 10] = [
    "Facility ID",
    "InspectionID",
    "Inspection Date",
    "Restaurant Name",
    "Address",
    "Zip Code",
    "lat",
    "lng",
    "Score",
    "Process Description",
];

/// The fields build.py reads from one CSV record, untrimmed.
#[derive(Debug, Clone, Default)]
pub struct RawRow {
    /// Position among data records (0-based); the same-date tie-break uses it (SPEC §3.2).
    pub source_index: usize,
    pub facility_id: String,
    pub inspection_id: String,
    pub inspection_date: String,
    pub restaurant_name: String,
    pub address: String,
    pub zip_code: String,
    pub lat: String,
    pub lng: String,
    pub score: String,
    pub process_description: String,
}

pub struct ParsedCsv {
    pub rows: Vec<RawRow>,
    /// Data records seen, malformed ones included (header excluded).
    pub records_read: usize,
    pub malformed: usize,
}

fn reader(bytes: &[u8]) -> csv::Reader<&[u8]> {
    csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(strip_bom(bytes))
}

/// The header record alone, for the schema guard to inspect before any row is processed.
pub fn headers(bytes: &[u8]) -> Result<StringRecord> {
    Ok(reader(bytes)
        .headers()
        .context("reading CSV header")?
        .clone())
}

pub fn read_csv(bytes: &[u8], skip_malformed: bool) -> Result<ParsedCsv> {
    let mut reader = reader(bytes);
    let headers = reader.headers().context("reading CSV header")?.clone();
    let columns = Columns::locate(&headers)?;

    let mut rows = Vec::new();
    let mut records_read = 0;
    let mut malformed = 0;
    for record in reader.records() {
        let record = record.with_context(|| format!("reading CSV record {}", records_read + 1))?;
        let source_index = records_read;
        records_read += 1;
        match columns.extract(&record, source_index) {
            Some(row) => rows.push(row),
            // SPEC §2.2: build.py crashes on these; fail loudly unless told to skip.
            None => {
                let line = record.position().map_or(0, |p| p.line());
                let message = format!(
                    "malformed row at line {line}: {} fields, required columns need {}",
                    record.len(),
                    columns.min_fields()
                );
                if !skip_malformed {
                    bail!("{message}. Rerun with --skip-malformed to skip and count such rows.");
                }
                eprintln!("warning: skipping {message}");
                malformed += 1;
            }
        }
    }
    Ok(ParsedCsv {
        rows,
        records_read,
        malformed,
    })
}

/// SPEC §4.6: a leading UTF-8 byte-order mark would otherwise end up in the first header name.
pub fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

/// Header positions of the required columns, in `REQUIRED_COLUMNS` order.
struct Columns([usize; REQUIRED_COLUMNS.len()]);

impl Columns {
    fn locate(headers: &StringRecord) -> Result<Self> {
        let mut positions = [0; REQUIRED_COLUMNS.len()];
        for (slot, name) in positions.iter_mut().zip(REQUIRED_COLUMNS) {
            // Python's DictReader keeps the last column when a header name repeats.
            *slot = headers
                .iter()
                .enumerate()
                .filter(|(_, h)| *h == name)
                .last()
                .map(|(i, _)| i)
                .with_context(|| format!("required column {name:?} is missing"))?;
        }
        Ok(Self(positions))
    }

    fn min_fields(&self) -> usize {
        self.0.iter().max().map_or(0, |m| m + 1)
    }

    /// `None` when the record is too short to supply every required column (SPEC §2.2).
    fn extract(&self, record: &StringRecord, source_index: usize) -> Option<RawRow> {
        let field = |i: usize| record.get(self.0[i]).map(str::to_owned);
        Some(RawRow {
            source_index,
            facility_id: field(0)?,
            inspection_id: field(1)?,
            inspection_date: field(2)?,
            restaurant_name: field(3)?,
            address: field(4)?,
            zip_code: field(5)?,
            lat: field(6)?,
            lng: field(7)?,
            score: field(8)?,
            process_description: field(9)?,
        })
    }
}

/// Python `str.isspace()`: Unicode whitespace plus the separators U+001C–U+001F (SPEC §4).
pub fn is_py_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// Python `str.strip()`.
pub fn py_trim(s: &str) -> &str {
    s.trim_matches(is_py_space)
}

/// Python `" ".join(s.split())`.
pub fn collapse_whitespace(s: &str) -> String {
    s.split(is_py_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// SPEC §4.2: ASCII digits only; blank, signed, decimal, non-ASCII or oversized values are `None`.
/// A recorded `0` stays `Some(0)`; the site decides how to treat it (SPEC §10.2).
pub fn parse_score(s: &str) -> Option<u32> {
    let t = py_trim(s);
    if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) {
        t.parse().ok()
    } else {
        None
    }
}

/// SPEC §4.4: finite decimal floats only, rounded like Python's `round(x, 5)`.
pub fn parse_coord(s: &str) -> Option<f64> {
    let value: f64 = py_trim(s).parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    round5(value)
}

/// A coordinate pair counts only when both halves parse (SPEC §4.4).
pub fn parse_coords(lat: &str, lng: &str) -> Option<(f64, f64)> {
    Some((parse_coord(lat)?, parse_coord(lng)?))
}

/// Rust's fixed-precision formatting rounds the exact binary value, as Python's `round` does.
fn round5(value: f64) -> Option<f64> {
    format!("{value:.5}").parse().ok()
}

/// SPEC §4.1: the subset of `strptime(s, "%m/%d/%Y")` that matters, with ASCII digits only.
pub fn parse_date(s: &str) -> Option<NaiveDate> {
    let mut parts = py_trim(s).split('/');
    let (month, day, year) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let month = small_number(month)?;
    let day = match day.as_bytes() {
        // strptime's %d also accepts a space followed by one digit.
        [b' ', d @ b'1'..=b'9'] => u32::from(d - b'0'),
        _ => small_number(day)?,
    };
    if year.len() != 4 || !year.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let year: i32 = year.parse().ok()?;
    if year < 1 {
        return None;
    }
    NaiveDate::from_ymd_opt(year, month, day)
}

/// One or two ASCII digits.
fn small_number(s: &str) -> Option<u32> {
    if (1..=2).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_accepts_plain_ascii_integers() {
        assert_eq!(parse_score("92"), Some(92));
        assert_eq!(parse_score(" 92 "), Some(92));
        assert_eq!(parse_score("0092"), Some(92));
        assert_eq!(parse_score("100"), Some(100));
        assert_eq!(
            parse_score("150"),
            Some(150),
            "values above 100 are not checked"
        );
    }

    #[test]
    fn score_zero_is_kept_not_blank() {
        assert_eq!(parse_score("0"), Some(0));
    }

    #[test]
    fn score_rejects_everything_else() {
        for input in [
            "",
            "   ",
            "92.5",
            "-1",
            "+90",
            "9 2",
            "N/A",
            "٣",
            "²",
            "99999999999",
        ] {
            assert_eq!(parse_score(input), None, "{input:?}");
        }
    }

    #[test]
    fn score_trims_python_whitespace_including_separators() {
        assert_eq!(parse_score("\u{1f}88\u{1c}"), Some(88));
        assert_eq!(parse_score("\u{a0}77\u{3000}"), Some(77));
    }

    #[test]
    fn coords_parse_and_round_to_five_places() {
        assert_eq!(
            parse_coords("30.34362", "-97.70197"),
            Some((30.34362, -97.70197))
        );
        assert_eq!(
            parse_coords(" 30.1234567 ", "-97.7654321"),
            Some((30.12346, -97.76543))
        );
        assert_eq!(parse_coords("30", "-97"), Some((30.0, -97.0)));
    }

    #[test]
    fn coords_round_exact_ties_to_even_like_python() {
        // 1/64 = 0.015625 exactly; Python's round(0.015625, 5) == 0.01562.
        assert_eq!(parse_coord("0.015625"), Some(0.01562));
        // 0.046875 = 3/64; Python: 0.04688.
        assert_eq!(parse_coord("0.046875"), Some(0.04688));
        // Not exact ties in binary, so they round by the exact value. Expected values are
        // Python's round(float(s), 5) output.
        for (input, python) in [
            ("30.123455", 30.12345),
            ("-97.123455", -97.12346),
            ("30.2672149", 30.26721),
            ("-97.7430608", -97.74306),
            ("30.000005", 30.00001),
            ("45.678915", 45.67892),
        ] {
            assert_eq!(parse_coord(input), Some(python), "{input}");
        }
    }

    #[test]
    fn coords_need_both_halves_and_finite_values() {
        assert_eq!(parse_coords("", ""), None);
        assert_eq!(parse_coords("30.1", ""), None);
        assert_eq!(parse_coords("", "-97.1"), None);
        assert_eq!(parse_coords("NaN", "-97.1"), None);
        assert_eq!(parse_coords("30.1", "Infinity"), None);
        assert_eq!(parse_coords("inf", "-inf"), None);
        assert_eq!(parse_coords("30_1", "-97.1"), None);
        assert_eq!(parse_coords("abc", "-97.1"), None);
    }

    #[test]
    fn dates_follow_strptime_month_day_year() {
        let d = |y, m, d| NaiveDate::from_ymd_opt(y, m, d);
        assert_eq!(parse_date("10/12/2026"), d(2026, 10, 12));
        assert_eq!(parse_date(" 1/5/2026 "), d(2026, 1, 5));
        assert_eq!(parse_date("01/05/2026"), d(2026, 1, 5));
        assert_eq!(parse_date("12/ 5/2026"), d(2026, 12, 5));
        for bad in [
            "",
            "13/01/2026",
            "00/10/2026",
            "02/30/2026",
            "1/5/26",
            "1/5/20260",
            "2026-01-05",
            "1/5/2026/1",
            "1/05 /2026",
            "01/01/0000",
            "١/5/2026",
        ] {
            assert_eq!(parse_date(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn whitespace_helpers_match_python() {
        assert_eq!(
            collapse_whitespace("  8000 N Lamar\nSte 5\t Austin "),
            "8000 N Lamar Ste 5 Austin"
        );
        assert_eq!(py_trim("\u{1d} x \u{85}"), "x");
    }

    #[test]
    fn bom_is_stripped_only_at_start() {
        assert_eq!(strip_bom(b"\xEF\xBB\xBFabc"), b"abc");
        assert_eq!(strip_bom(b"abc\xEF\xBB\xBF"), b"abc\xEF\xBB\xBF");
    }
}
