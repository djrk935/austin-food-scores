//! Group rows into facilities and order their inspections. SPEC §2.3, §3, §4.5.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use serde::Serialize;

use crate::parse::{self, RawRow};

/// `meta.json` → `anomalies` (SPEC §5.2).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Anomalies {
    pub blank_scores: usize,
    pub zero_scores: usize,
    pub facilities_without_coordinates: usize,
    pub same_date_ties: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Inspection {
    pub date: NaiveDate,
    pub score: Option<u32>,
    pub follow_up: bool,
    /// Position of the row in the source CSV; only `same_date_tiebreak` reads it.
    pub source_index: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Facility {
    pub id: String,
    pub name: String,
    pub address: String,
    pub zip: String,
    pub coords: Option<(f64, f64)>,
    pub inspections: Vec<Inspection>,
}

pub struct Grouped {
    pub facilities: Vec<Facility>,
    pub skipped_rows: usize,
}

pub fn group(rows: &[RawRow]) -> Grouped {
    let mut facilities: Vec<Facility> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut seen_inspections: HashSet<String> = HashSet::new();
    let mut skipped_rows = 0;

    for row in rows {
        let facility_id = parse::py_trim(&row.facility_id);
        let inspection_id = parse::py_trim(&row.inspection_id);
        if facility_id.is_empty() || seen_inspections.contains(inspection_id) {
            skipped_rows += 1;
            continue;
        }
        let Some(date) = parse::parse_date(&row.inspection_date) else {
            skipped_rows += 1;
            continue;
        };
        // SPEC §2.3: an ID counts as seen only once its row passed the date check.
        seen_inspections.insert(inspection_id.to_owned());

        // SPEC §4.5: name, address and ZIP come from the facility's first kept row.
        let index = *by_id.entry(facility_id.to_owned()).or_insert_with(|| {
            facilities.push(Facility {
                id: facility_id.to_owned(),
                name: parse::py_trim(&row.restaurant_name).to_owned(),
                address: parse::collapse_whitespace(&row.address),
                zip: parse::py_trim(&row.zip_code).chars().take(5).collect(),
                coords: None,
                inspections: Vec::new(),
            });
            facilities.len() - 1
        });
        let facility = &mut facilities[index];
        // SPEC §4.4: the last kept row with a valid pair wins.
        if let Some(coords) = parse::parse_coords(&row.lat, &row.lng) {
            facility.coords = Some(coords);
        }
        facility.inspections.push(Inspection {
            date,
            score: parse::parse_score(&row.score),
            follow_up: row.process_description.to_lowercase().contains("follow"),
            source_index: row.source_index,
        });
    }

    for facility in &mut facilities {
        facility.inspections.sort_by(inspection_order);
    }
    // SPEC §5.1: stable sort on the lowercased name keeps first-seen order for equal names.
    let mut keyed: Vec<(String, Facility)> = facilities
        .into_iter()
        .map(|f| (f.name.to_lowercase(), f))
        .collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));

    Grouped {
        facilities: keyed.into_iter().map(|(_, f)| f).collect(),
        skipped_rows,
    }
}

/// Newest date first (SPEC §3.2). Same-date ties go to `same_date_tiebreak` and nowhere else.
pub fn inspection_order(a: &Inspection, b: &Inspection) -> Ordering {
    b.date.cmp(&a.date).then_with(|| same_date_tiebreak(a, b))
}

/// SPEC §3.2: the row that comes first in the source CSV wins a same-date tie, even when it has
/// a blank score and a later row has a real one (facility 12399010 on 2024-12-31). This matches
/// build.py's stable sort and is knowingly order-dependent; the planned fix (SPEC §3.3) replaces
/// only this function.
pub fn same_date_tiebreak(a: &Inspection, b: &Inspection) -> Ordering {
    a.source_index.cmp(&b.source_index)
}

pub fn date_range(facilities: &[Facility]) -> Option<(NaiveDate, NaiveDate)> {
    let mut dates = facilities
        .iter()
        .flat_map(|f| f.inspections.iter().map(|i| i.date));
    let first = dates.next()?;
    Some(dates.fold((first, first), |(lo, hi), d| (lo.min(d), hi.max(d))))
}

/// SPEC §5.2. Blank (`None`) and zero (`Some(0)`) scores are disjoint by construction.
pub fn anomalies(facilities: &[Facility]) -> Anomalies {
    let inspections = || facilities.iter().flat_map(|f| f.inspections.iter());
    Anomalies {
        blank_scores: inspections().filter(|i| i.score.is_none()).count(),
        zero_scores: inspections().filter(|i| i.score == Some(0)).count(),
        facilities_without_coordinates: facilities.iter().filter(|f| f.coords.is_none()).count(),
        // Inspections are already sorted by date, so ties are adjacent.
        same_date_ties: facilities
            .iter()
            .filter(|f| f.inspections.windows(2).any(|w| w[0].date == w[1].date))
            .count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(index: usize, facility: &str, inspection: &str, date: &str, score: &str) -> RawRow {
        RawRow {
            source_index: index,
            facility_id: facility.into(),
            inspection_id: inspection.into(),
            inspection_date: date.into(),
            restaurant_name: format!("Place {facility}"),
            score: score.into(),
            ..RawRow::default()
        }
    }

    fn inspection(source_index: usize, score: Option<u32>) -> Inspection {
        Inspection {
            date: NaiveDate::from_ymd_opt(2024, 12, 31).unwrap(),
            score,
            follow_up: false,
            source_index,
        }
    }

    /// The real case from SPEC §3.2: blank at CSV row 1,785, 83 at row 16,127. The blank wins.
    #[test]
    fn tiebreak_picks_first_csv_row_even_when_blank() {
        let blank = inspection(1785, None);
        let scored = inspection(16127, Some(83));
        assert_eq!(same_date_tiebreak(&blank, &scored), Ordering::Less);

        for mut list in [
            vec![blank.clone(), scored.clone()],
            vec![scored.clone(), blank.clone()],
        ] {
            list.sort_by(inspection_order);
            assert_eq!(
                list[0].score, None,
                "blank row comes first in the CSV, so it is current"
            );
            assert_eq!(list[1].score, Some(83));
        }
    }

    #[test]
    fn newer_dates_beat_csv_order() {
        let mut older = inspection(0, Some(70));
        older.date = NaiveDate::from_ymd_opt(2024, 6, 1).unwrap();
        let newer = inspection(9, Some(95));
        assert_eq!(inspection_order(&newer, &older), Ordering::Less);
    }

    #[test]
    fn duplicate_id_counts_as_seen_only_after_a_good_date() {
        let rows = [
            row(0, "1", "A", "13/45/2026", "90"), // bad date: skipped, A not yet seen
            row(1, "1", "A", "01/02/2026", "91"), // kept
            row(2, "1", "A", "01/03/2026", "92"), // duplicate: skipped
            row(3, " ", "B", "01/04/2026", "93"), // blank facility: skipped
        ];
        let grouped = group(&rows);
        assert_eq!(grouped.skipped_rows, 3);
        assert_eq!(grouped.facilities.len(), 1);
        assert_eq!(grouped.facilities[0].inspections[0].score, Some(91));
    }

    #[test]
    fn blank_and_zero_counts_are_disjoint() {
        let rows = [
            row(0, "1", "a", "01/01/2026", ""),
            row(1, "1", "b", "01/02/2026", "0"),
            row(2, "2", "c", "01/02/2026", "85"),
        ];
        let a = anomalies(&group(&rows).facilities);
        assert_eq!((a.blank_scores, a.zero_scores), (1, 1));
        assert_eq!(a.facilities_without_coordinates, 2);
        assert_eq!(a.same_date_ties, 0);
    }
}
