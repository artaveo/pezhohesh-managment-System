//! Solar Hijri (Afghan) calendar dates: the Excel books' month columns, and bill numbers
//! that run per Solar year. Arithmetic from the jalaali-js algorithm (Borkowski's 33-year cycles).

use chrono::{Days, NaiveDate};

const BREAKS: [i32; 20] = [
    -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178,
];

pub const MONTHS: [&str; 12] = ["حمل", "ثور", "جوزا", "سرطان", "اسد", "سنبله", "میزان", "عقرب", "قوس", "جدی", "دلو", "حوت"];

/// (is leap year, Gregorian day in March of 1 Hamal)
fn cal(jy: i32) -> (bool, i32) {
    let gy = jy + 621;
    let mut leap_j = -14;
    let mut jp = BREAKS[0];
    let mut jump = 0;
    for &jm in &BREAKS[1..] {
        jump = jm - jp;
        if jy < jm {
            break;
        }
        leap_j += jump / 33 * 8 + (jump % 33) / 4;
        jp = jm;
    }
    let mut n = jy - jp;
    leap_j += n / 33 * 8 + ((n % 33) + 3) / 4;
    if jump % 33 == 4 && jump - n == 4 {
        leap_j += 1;
    }
    let leap_g = gy / 4 - (gy / 100 + 1) * 3 / 4 - 150;
    let march = 20 + leap_j - leap_g;
    if jump - n < 6 {
        n = n - jump + (jump + 4) / 33 * 33;
    }
    let mut leap = ((n + 1) % 33 - 1) % 4;
    if leap == -1 {
        leap = 4;
    }
    (leap == 0, march)
}

/// Days in a Solar month (1-based).
pub fn month_len(jy: i32, jm: u32) -> u32 {
    match jm {
        1..=6 => 31,
        7..=11 => 30,
        _ if cal(jy).0 => 30,
        _ => 29,
    }
}

/// Gregorian date of a Solar date; None when the day does not exist.
pub fn to_gregorian(jy: i32, jm: u32, jd: u32) -> Option<NaiveDate> {
    if !(1..=12).contains(&jm) || jd < 1 || jd > month_len(jy, jm) {
        return None;
    }
    let (_, march) = cal(jy);
    let start = NaiveDate::from_ymd_opt(jy + 621, 3, march as u32)?;
    let (m, d) = (jm as i64, jd as i64);
    let offset = (m - 1) * 31 - (m / 7) * (m - 7) + d - 1;
    start.checked_add_days(Days::new(offset as u64))
}

/// Solar year that contains a Gregorian date (bill numbers run per Solar year).
pub fn year_of(date: NaiveDate) -> i32 {
    use chrono::Datelike;
    let jy = date.year() - 621;
    match to_gregorian(jy, 1, 1) {
        Some(nowruz) if date < nowruz => jy - 1,
        _ => jy,
    }
}

/// Solar month and day of a Gregorian date.
pub fn month_day(date: NaiveDate) -> (u32, u32) {
    let nowruz = to_gregorian(year_of(date), 1, 1).unwrap_or(date);
    let days = (date - nowruz).num_days().max(0) as u32;
    if days < 186 { (days / 31 + 1, days % 31 + 1) } else { (7 + (days - 186) / 30, (days - 186) % 30 + 1) }
}

/// Month number (1-12) of a header such as "حمل " or "عقرب".
pub fn month_of(header: &str) -> Option<u32> {
    let h = header.trim();
    MONTHS.iter().position(|m| *m == h).map(|i| i as u32 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_dates() {
        let d = |y, m, dd| NaiveDate::from_ymd_opt(y, m, dd).unwrap();
        assert_eq!(to_gregorian(1405, 1, 1), Some(d(2026, 3, 21)));
        assert_eq!(to_gregorian(1405, 8, 2), Some(d(2026, 10, 24)));
        assert_eq!(to_gregorian(1404, 1, 1), Some(d(2025, 3, 21)));
        assert_eq!(to_gregorian(1403, 12, 30), Some(d(2025, 3, 20))); // 1403 is a leap year
        assert_eq!(month_len(1404, 12), 29);
        assert_eq!(to_gregorian(1405, 7, 31), None);
        assert_eq!(month_of("سرطان "), Some(4));
        assert_eq!(year_of(d(2026, 3, 20)), 1404);
        assert_eq!(year_of(d(2026, 3, 21)), 1405);
        assert_eq!(year_of(d(2026, 10, 27)), 1405);
        assert_eq!(month_day(d(2026, 10, 27)), (8, 5));
        assert_eq!(month_day(d(2026, 3, 21)), (1, 1));
        assert_eq!(month_day(d(2026, 9, 22)), (6, 31));
        assert_eq!(month_day(d(2026, 9, 23)), (7, 1));
        assert_eq!(month_day(d(2025, 3, 20)), (12, 30));
    }
}
