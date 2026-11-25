//! Dates and durations of the expression language. A date is an instant that is read and shown in
//! local time; a duration is a number of calendar months, days and milliseconds, written like
//! `1 week` or `2h`.

use std::cmp::Ordering;

use chrono::{
    DateTime, Datelike, Days, FixedOffset, Local, Months, NaiveDate, NaiveDateTime, NaiveTime,
    TimeDelta, TimeZone, Timelike,
};

const SECOND: f64 = 1_000.0;
const MINUTE: f64 = 60.0 * SECOND;
const HOUR: f64 = 60.0 * MINUTE;
const DAY: f64 = 24.0 * HOUR;
/// The days a month and a year count as where two durations are compared or turned into a number.
const DAYS_PER_MONTH: f64 = 30.0;
const DAYS_PER_YEAR: f64 = 365.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Date {
    /// Milliseconds since the Unix epoch.
    pub millis: i64,
    /// False for a day without a time of day: it is shown without one.
    pub timed: bool,
}

/// A field of a date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Year,
    Month,
    Day,
    Hour,
    Minute,
    Second,
    Millisecond,
}

impl Part {
    pub fn from_name(name: &str) -> Option<Part> {
        Some(match name {
            "year" => Part::Year,
            "month" => Part::Month,
            "day" => Part::Day,
            "hour" => Part::Hour,
            "minute" => Part::Minute,
            "second" => Part::Second,
            "millisecond" => Part::Millisecond,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Part::Year => "year",
            Part::Month => "month",
            Part::Day => "day",
            Part::Hour => "hour",
            Part::Minute => "minute",
            Part::Second => "second",
            Part::Millisecond => "millisecond",
        }
    }
}

/// The instant of the local time `local`. A time that a change of the clock skips is the one an
/// hour later; of a time that happens twice it is the first.
fn instant(local: NaiveDateTime) -> Option<i64> {
    Local
        .from_local_datetime(&local)
        .earliest()
        .or_else(|| {
            let later = local.checked_add_signed(TimeDelta::hours(1))?;
            Local.from_local_datetime(&later).earliest()
        })
        .map(|d| d.timestamp_millis())
}

impl Date {
    /// A point in time; `None` when it is out of the range of dates.
    pub fn at(millis: i64) -> Option<Date> {
        DateTime::from_timestamp_millis(millis)?;
        Some(Date {
            millis,
            timed: true,
        })
    }

    /// The start of the day `day`.
    fn of_day(day: NaiveDate) -> Option<Date> {
        Some(Date {
            millis: instant(day.and_time(NaiveTime::MIN))?,
            timed: false,
        })
    }

    /// `YYYY-MM-DD`, optionally with a time and a zone; without a zone it is local.
    pub fn parse(text: &str) -> Option<Date> {
        let text = text.trim();
        if let Ok(date) = DateTime::parse_from_rfc3339(text) {
            return Date::at(date.timestamp_millis());
        }
        let timed = [
            "%Y-%m-%dT%H:%M:%S%.f",
            "%Y-%m-%d %H:%M:%S%.f",
            "%Y-%m-%dT%H:%M",
            "%Y-%m-%d %H:%M",
        ]
        .iter()
        .find_map(|format| NaiveDateTime::parse_from_str(text, format).ok());
        match timed {
            Some(local) => Date::at(instant(local)?),
            None => Date::of_day(NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?),
        }
    }

    /// The date in local time.
    fn local(self) -> Option<DateTime<Local>> {
        Some(DateTime::from_timestamp_millis(self.millis)?.with_timezone(&Local))
    }

    fn fixed(self) -> Option<DateTime<FixedOffset>> {
        Some(self.local()?.fixed_offset())
    }

    /// The start of its day.
    pub fn day(self) -> Option<Date> {
        Date::of_day(self.local()?.date_naive())
    }

    /// Formatted with Moment.js tokens.
    pub fn format(self, format: &str) -> Option<String> {
        Some(crate::daily::format_moment(&self.fixed()?, format))
    }

    /// `hh:mm:ss`.
    pub fn time(self) -> Option<String> {
        Some(self.local()?.format("%H:%M:%S").to_string())
    }

    /// `YYYY-MM-DD`, with ` hh:mm:ss` when it has a time.
    pub fn text(self) -> Option<String> {
        let format = if self.timed {
            "%Y-%m-%d %H:%M:%S"
        } else {
            "%Y-%m-%d"
        };
        Some(self.local()?.format(format).to_string())
    }

    pub fn part(self, part: Part) -> Option<f64> {
        let d = self.local()?;
        Some(match part {
            Part::Year => f64::from(d.year()),
            Part::Month => f64::from(d.month()),
            Part::Day => f64::from(d.day()),
            Part::Hour => f64::from(d.hour()),
            Part::Minute => f64::from(d.minute()),
            Part::Second => f64::from(d.second()),
            Part::Millisecond => f64::from(d.timestamp_subsec_millis()),
        })
    }

    /// The date `duration` later: first the months of the calendar, then the days (calendar days
    /// for a day without a time, else 24 hours each), then the rest. `None` when it is out of range.
    pub fn plus(self, duration: Duration) -> Option<Date> {
        let mut date = self;
        if duration.months != 0 {
            let local = date.local()?.naive_local();
            let months = Months::new(u32::try_from(duration.months.unsigned_abs()).ok()?);
            let moved = if duration.months > 0 {
                local.checked_add_months(months)?
            } else {
                local.checked_sub_months(months)?
            };
            date.millis = instant(moved)?;
        }
        let mut rest = duration.millis;
        if !date.timed && duration.days.fract() == 0.0 {
            if duration.days != 0.0 {
                let day = date.local()?.date_naive();
                // A float beyond the range becomes the largest number, which no date reaches.
                let days = Days::new(duration.days.abs() as u64);
                let moved = if duration.days > 0.0 {
                    day.checked_add_days(days)?
                } else {
                    day.checked_sub_days(days)?
                };
                date = Date::of_day(moved)?;
            }
        } else {
            rest += duration.days * DAY;
        }
        let rest = rest.round();
        if rest != 0.0 {
            date = Date::at(date.millis.checked_add(rest as i64)?)?;
        }
        Some(date)
    }

    /// How far the date is from `now`, in words (`3 days ago`, `in a month`); the steps are those
    /// of Moment.js.
    pub fn relative(self, now: i64) -> String {
        let distance = (self.millis as f64 - now as f64).abs();
        let count = |unit: f64| (distance / unit).round();
        let days = distance / DAY;
        let words = if count(SECOND) < 45.0 {
            "a few seconds".to_string()
        } else if count(SECOND) < 90.0 {
            "a minute".into()
        } else if count(MINUTE) < 45.0 {
            format!("{} minutes", count(MINUTE))
        } else if count(MINUTE) < 90.0 {
            "an hour".into()
        } else if count(HOUR) < 22.0 {
            format!("{} hours", count(HOUR))
        } else if count(HOUR) < 36.0 {
            "a day".into()
        } else if days.round() < 26.0 {
            format!("{} days", days.round())
        } else if days.round() < 46.0 {
            "a month".into()
        } else if days.round() < 320.0 {
            format!("{} months", (days / 30.44).round().max(2.0))
        } else if days.round() < 548.0 {
            "a year".into()
        } else {
            format!("{} years", (days / 365.25).round().max(2.0))
        };
        if self.millis > now {
            format!("in {words}")
        } else {
            format!("{words} ago")
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Duration {
    /// Calendar months; a year is twelve.
    pub months: i64,
    pub days: f64,
    /// Hours, minutes and seconds.
    pub millis: f64,
}

impl Duration {
    /// A number and a unit, with or without a space: `1 week`, `2h`, `-1.5 days`. `M` is a month,
    /// `m` a minute. Years and months take whole numbers.
    pub fn parse(text: &str) -> Option<Duration> {
        let text = text.trim();
        let unit_at = text.find(|c: char| c.is_alphabetic())?;
        let (number, unit) = text.split_at(unit_at);
        let number = number.trim_end();
        let digits = number.strip_prefix(['-', '+']).unwrap_or(number);
        // Only digits and a point: `f64` would also read `inf` or `1e3`.
        if !digits.starts_with(|c: char| c.is_ascii_digit())
            || !digits.chars().all(|c| c.is_ascii_digit() || c == '.')
        {
            return None;
        }
        let n: f64 = number.parse().ok()?;
        let months = |per: f64| {
            let months = n * per;
            (n.fract() == 0.0 && months.abs() <= f64::from(u32::MAX)).then_some(Duration {
                months: months as i64,
                ..Duration::default()
            })
        };
        let days = |per: f64| {
            Duration {
                days: n * per,
                ..Duration::default()
            }
            .finite()
        };
        let millis = |per: f64| {
            Duration {
                millis: n * per,
                ..Duration::default()
            }
            .finite()
        };
        match unit {
            "y" | "year" | "years" => months(12.0),
            "M" | "month" | "months" => months(1.0),
            "w" | "week" | "weeks" => days(7.0),
            "d" | "day" | "days" => days(1.0),
            "h" | "hour" | "hours" => millis(HOUR),
            "m" | "minute" | "minutes" => millis(MINUTE),
            "s" | "second" | "seconds" => millis(SECOND),
            _ => None,
        }
    }

    /// The time from `from` to `to`; whole days between two days without a time, whatever the
    /// clock does in between.
    pub fn between(from: Date, to: Date) -> Duration {
        let millis = to.millis as f64 - from.millis as f64;
        if from.timed || to.timed {
            Duration {
                millis,
                ..Duration::default()
            }
        } else {
            Duration {
                days: (millis / DAY).round(),
                ..Duration::default()
            }
        }
    }

    fn finite(self) -> Option<Duration> {
        self.total().is_finite().then_some(self)
    }

    /// The length in milliseconds; a month counts 30 days, twelve months 365.
    pub fn total(self) -> f64 {
        let (years, months) = (self.months / 12, self.months % 12);
        let days = years as f64 * DAYS_PER_YEAR + months as f64 * DAYS_PER_MONTH + self.days;
        days * DAY + self.millis
    }

    pub fn plus(self, other: Duration) -> Option<Duration> {
        Duration {
            months: self.months.checked_add(other.months)?,
            days: self.days + other.days,
            millis: self.millis + other.millis,
        }
        .finite()
    }

    pub fn negated(self) -> Duration {
        Duration {
            months: self.months.saturating_neg(),
            days: -self.days,
            millis: -self.millis,
        }
    }

    /// `factor` times as long; a fraction of a month counts as days.
    pub fn times(self, factor: f64) -> Option<Duration> {
        let months = self.months as f64 * factor;
        let whole = months.trunc();
        if !months.is_finite() || whole.abs() > f64::from(u32::MAX) {
            return None;
        }
        Duration {
            months: whole as i64,
            days: self.days * factor + (months - whole) * DAYS_PER_MONTH,
            millis: self.millis * factor,
        }
        .finite()
    }

    pub fn order(self, other: Duration) -> Option<Ordering> {
        self.total().partial_cmp(&other.total())
    }

    /// `1 year 2 months 3 days 4 hours`; months and days as they are, the rest split into days,
    /// hours, minutes, seconds and milliseconds.
    pub fn text(self) -> String {
        let mut parts = Vec::new();
        let mut push = |n: f64, unit: &str| {
            if n != 0.0 {
                let plural = if n.abs() == 1.0 { "" } else { "s" };
                parts.push(format!("{n} {unit}{plural}"));
            }
        };
        push((self.months / 12) as f64, "year");
        push((self.months % 12) as f64, "month");
        let whole_days = self.days.trunc();
        let rest = ((self.days - whole_days) * DAY + self.millis).round();
        let carried = (rest / DAY).trunc();
        push(whole_days + carried, "day");
        let rest = rest - carried * DAY;
        push((rest / HOUR).trunc(), "hour");
        push((rest % HOUR / MINUTE).trunc(), "minute");
        push((rest % MINUTE / SECOND).trunc(), "second");
        push(rest % SECOND, "millisecond");
        if parts.is_empty() {
            return "0 seconds".into();
        }
        parts.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(text: &str) -> Date {
        Date::parse(text).unwrap()
    }

    fn plus(from: &str, durations: &[&str]) -> String {
        durations
            .iter()
            .fold(date(from), |d, text| {
                d.plus(Duration::parse(text).unwrap()).unwrap()
            })
            .text()
            .unwrap()
    }

    #[test]
    fn every_unit_is_read() {
        for (unit, short, long) in [
            ((12, 0.0, 0.0), "1y", ["1 year", "1 years"]),
            ((1, 0.0, 0.0), "1M", ["1 month", "1 months"]),
            ((0, 7.0, 0.0), "1w", ["1 week", "1 weeks"]),
            ((0, 1.0, 0.0), "1d", ["1 day", "1 days"]),
            ((0, 0.0, HOUR), "1h", ["1 hour", "1 hours"]),
            ((0, 0.0, MINUTE), "1m", ["1 minute", "1 minutes"]),
            ((0, 0.0, SECOND), "1s", ["1 second", "1 seconds"]),
        ] {
            let wanted = Some(Duration {
                months: unit.0,
                days: unit.1,
                millis: unit.2,
            });
            for text in [short, long[0], long[1]] {
                assert_eq!(Duration::parse(text), wanted, "{text}");
            }
        }
        assert_eq!(Duration::parse(" -1.5 days ").unwrap().days, -1.5);
        assert_eq!(Duration::parse("+2h").unwrap().millis, 2.0 * HOUR);
    }

    #[test]
    fn other_texts_are_no_duration() {
        for text in [
            "",
            "1",
            "d",
            "one day",
            "1 fortnight",
            "1 D",
            "1ms",
            "1e3s",
            "infs",
            "1.2.3d",
            "- 1d",
            ".5d",
            "1.5M",
            "0.5y",
            "1d 2h",
            "99999999999y",
        ] {
            assert_eq!(Duration::parse(text), None, "{text}");
        }
    }

    #[test]
    fn months_follow_the_calendar_and_days_add_up() {
        assert_eq!(
            plus("2024-12-01", &["1M", "4h", "3m"]),
            "2025-01-01 04:03:00"
        );
        assert_eq!(plus("2026-01-31", &["1 month"]), "2026-02-28");
        assert_eq!(plus("2024-02-29", &["1y"]), "2025-02-28");
        assert_eq!(plus("2026-03-01", &["-1d"]), "2026-02-28");
        assert_eq!(plus("2026-03-01", &["-2M"]), "2026-01-01");
        // A year of days without a time stays one, whatever the clock does in between.
        assert_eq!(plus("2026-01-01", &["365d"]), "2027-01-01");
        assert_eq!(plus("2026-06-10", &["1w"]), "2026-06-17");
        assert_eq!(plus("2026-06-10", &["1.5d"]), "2026-06-11 12:00:00");
        assert_eq!(
            plus("2026-06-10 08:00", &["1d", "-30s"]),
            "2026-06-11 07:59:30"
        );
    }

    #[test]
    fn the_time_between_two_days_is_whole_days() {
        let between = Duration::between(date("2026-01-01"), date("2026-07-01"));
        assert_eq!(between.text(), "181 days");
        let timed = Duration::between(date("2026-06-01"), date("2026-06-02 01:00"));
        assert_eq!(timed.text(), "1 day 1 hour");
    }

    #[test]
    fn a_result_out_of_range_is_none() {
        for text in [
            "999999999y",
            "999999999999d",
            "-999999999999d",
            "99999999999999999h",
        ] {
            let duration = Duration::parse(text);
            assert_eq!(
                duration.and_then(|d| date("2026-01-01").plus(d)),
                None,
                "{text}"
            );
        }
        assert_eq!(Duration::parse("1M").unwrap().times(f64::MAX), None);
        assert_eq!(Duration::parse("1d").unwrap().times(f64::INFINITY), None);
    }

    #[test]
    fn dates_read_with_and_without_a_time() {
        assert!(!date("2026-06-10").timed);
        assert_eq!(date("2026-06-10").text().unwrap(), "2026-06-10");
        for text in ["2026-06-10 08:05", "2026-06-10T08:05:00.000"] {
            assert_eq!(date(text).text().unwrap(), "2026-06-10 08:05:00", "{text}");
        }
        assert_eq!(date("2026-06-10T08:00:00Z").millis, 1_781_078_400_000);
        for text in ["", "2026", "2026-02-30", "10.06.2026", "2026-06-10 25:00"] {
            assert_eq!(Date::parse(text), None, "{text}");
        }
    }

    #[test]
    fn relative_words_follow_moment() {
        let now = date("2026-06-10 12:00").millis;
        for (offset, wanted) in [
            (0.0, "a few seconds ago"),
            (-60.0 * SECOND, "a minute ago"),
            (-5.0 * MINUTE, "5 minutes ago"),
            (-HOUR, "an hour ago"),
            (-3.0 * HOUR, "3 hours ago"),
            (-DAY, "a day ago"),
            (-3.0 * DAY, "3 days ago"),
            (3.0 * DAY, "in 3 days"),
            (-30.0 * DAY, "a month ago"),
            (-90.0 * DAY, "3 months ago"),
            (-400.0 * DAY, "a year ago"),
            (800.0 * DAY, "in 2 years"),
        ] {
            let at = Date::at(now + offset as i64).unwrap();
            assert_eq!(at.relative(now), wanted, "{offset}");
        }
    }

    #[test]
    fn a_duration_reads_as_words() {
        for (duration, wanted) in [
            ((0, 0.0, 0.0), "0 seconds"),
            (
                (14, 3.0, HOUR + 1.0),
                "1 year 2 months 3 days 1 hour 1 millisecond",
            ),
            (
                (0, 0.0, 49.0 * HOUR + 2.0 * MINUTE),
                "2 days 1 hour 2 minutes",
            ),
            ((0, 0.0, -90.0 * SECOND), "-1 minute -30 seconds"),
            ((0, 1.5, 0.0), "1 day 12 hours"),
        ] {
            let duration = Duration {
                months: duration.0,
                days: duration.1,
                millis: duration.2,
            };
            assert_eq!(duration.text(), wanted);
        }
    }
}
