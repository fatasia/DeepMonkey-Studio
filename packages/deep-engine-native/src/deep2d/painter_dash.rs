//! Dash expansion: compiles the authored dash pattern into bounded open
//! sub-paths that flow through the existing stroke tessellation. All work is
//! CPU-side arc-length walking; nothing loops in a shader.

use super::{
    Deep2dPainterIssue, Deep2dPainterIssueCode,
    painter::issue,
    painter_math::{Point, near, point_epsilon},
    painter_path::{LinearPath, LinearSubPath},
};

/// Point budget for the expanded dash sequence of one path command.
const MAX_DASH_POINTS: usize = 16_384;

struct Phase {
    /// Alternating on/off lengths, starting with an on entry.
    entries: Vec<f64>,
    index: usize,
    into_entry: f64,
    on: bool,
}

impl Phase {
    fn start(pattern: &[f64], offset: f64) -> Self {
        let mut phase = Self {
            entries: pattern.to_vec(),
            index: 0,
            into_entry: 0.0,
            on: true,
        };
        // Normalize before walking the pattern. Apart from making negative
        // offsets follow the authored repeating pattern, this bounds the work
        // independently of the numeric magnitude of dashOffset. Odd-length
        // patterns need two authored cycles before the on/off phase repeats.
        let authored_cycle: f64 = pattern.iter().sum();
        let phase_cycle = if pattern.len().is_multiple_of(2) {
            authored_cycle
        } else {
            authored_cycle * 2.0
        };
        let mut skipped = offset.rem_euclid(phase_cycle);
        while skipped > 0.0 {
            let entry = phase.entries[phase.index];
            if skipped < entry {
                phase.into_entry = skipped;
                skipped = 0.0;
            } else {
                skipped -= entry;
                phase.into_entry = 0.0;
                phase.index = (phase.index + 1) % phase.entries.len();
                phase.on = !phase.on;
            }
        }
        phase
    }

    fn remaining_in_entry(&self) -> f64 {
        self.entries[self.index] - self.into_entry
    }

    fn advance(&mut self, step: f64) {
        self.into_entry += step;
        if self.into_entry >= self.entries[self.index] {
            self.into_entry = 0.0;
            self.index = (self.index + 1) % self.entries.len();
            self.on = !self.on;
        }
    }
}

/// Expands the authored dash pattern over every sub-path (closed sub-paths wrap
/// through their implicit closing edge) and returns the on-intervals as open
/// sub-paths in draw order.
pub(super) fn dash_subpaths(
    linear: &LinearPath,
    pattern: &[f64],
    dash_offset: f64,
    command_path: &str,
) -> Result<LinearPath, Deep2dPainterIssue> {
    let cycle: f64 = pattern.iter().sum();
    if !(cycle.is_finite() && cycle > 0.0) {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedDash,
            command_path,
            "Dash pattern must have a positive finite total length.",
        ));
    }
    let mut out: Vec<LinearSubPath> = Vec::new();
    let mut emitted_points = 0usize;
    for subpath in &linear.subpaths {
        let segments = subpath.segments();
        let epsilon = point_epsilon(&subpath.points);
        let mut phase = Phase::start(pattern, dash_offset);
        let mut current: Vec<Point> = Vec::new();
        for segment in &segments {
            let (start, end) = (segment[0], segment[1]);
            let length = ((end[0] - start[0]).powi(2) + (end[1] - start[1]).powi(2)).sqrt();
            if length <= epsilon {
                // Zero-length segments preserve dash phase continuity.
                if phase.on && !current.is_empty() && !near(*current.last().unwrap(), end, epsilon)
                {
                    current.push(end);
                }
                continue;
            }
            let mut consumed = 0.0f64;
            while length - consumed > epsilon {
                let step = phase.remaining_in_entry().min(length - consumed);
                if phase.on {
                    if current.is_empty() {
                        current.push(point_at(start, end, consumed / length));
                    }
                    let stop = point_at(start, end, (consumed + step) / length);
                    if current
                        .last()
                        .is_none_or(|last| !near(*last, stop, epsilon))
                    {
                        current.push(stop);
                    }
                }
                phase.advance(step);
                consumed += step;
                if !phase.on {
                    if current.len() >= 2 {
                        emitted_points += current.len();
                        out.push(LinearSubPath {
                            points: std::mem::take(&mut current),
                            closed: false,
                        });
                    } else {
                        current.clear();
                    }
                }
                if emitted_points > MAX_DASH_POINTS {
                    return Err(issue(
                        Deep2dPainterIssueCode::TessellationBudgetExceeded,
                        command_path,
                        "Dash expansion exceeds the point budget.",
                    ));
                }
            }
        }
        // A dash still on at the end of the sub-path simply ends there.
        if current.len() >= 2 {
            emitted_points += current.len();
            out.push(LinearSubPath {
                points: std::mem::take(&mut current),
                closed: false,
            });
        }
    }
    Ok(LinearPath { subpaths: out })
}

fn point_at(start: Point, end: Point, t: f64) -> Point {
    [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
    ]
}

#[cfg(test)]
mod tests {
    use super::Phase;

    #[test]
    fn offsets_are_normalized_without_losing_direction() {
        let positive = Phase::start(&[4.0, 2.0], 1.0);
        assert!(positive.on);
        assert_eq!(positive.index, 0);
        assert_eq!(positive.into_entry, 1.0);

        let negative = Phase::start(&[4.0, 2.0], -1.0);
        assert!(!negative.on);
        assert_eq!(negative.index, 1);
        assert_eq!(negative.into_entry, 1.0);
    }

    #[test]
    fn huge_offsets_and_odd_patterns_have_bounded_phase_walks() {
        let huge = Phase::start(&[4.0, 2.0], 1_000_000_000_001.0);
        assert!(!huge.on);
        assert_eq!(huge.index, 1);
        assert_eq!(huge.into_entry, 1.0);

        let odd_second_cycle = Phase::start(&[3.0, 1.0, 2.0], 6.0);
        assert!(!odd_second_cycle.on);
        assert_eq!(odd_second_cycle.index, 0);
        assert_eq!(odd_second_cycle.into_entry, 0.0);
    }
}
