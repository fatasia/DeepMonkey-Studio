//! C05: bounded-million-point data channel. Columnar chunks with a strict
//! resident budget, viewport windows, decimation (equal-stride with first/
//! last preservation) and an accounting report — the renderer must always be
//! able to say how many points were input, resident, visible, drawn and
//! dropped, and by which rule.

/// Points per chunk: 8192 keeps a 1M-point series at ~122 chunks, each a
/// separate allocation that can be evicted independently.
pub const CHUNK_SIZE: usize = 8_192;
/// Hard resident cap: 1M points per series channel (matches the IR budget
/// of 500k JSON rows doubled through chunk duplication is forbidden — this
/// budget counts *decoded numeric points*, not JSON source rows).
pub const MAX_RESIDENT_POINTS: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq)]
pub struct ChunkedSeries {
    pub chunk_size: usize,
    chunks: Vec<SeriesChunk>,
    total_len: usize,
}

#[derive(Debug, Clone, PartialEq)]
struct SeriesChunk {
    start: usize,
    values: Vec<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelAccounting {
    pub input_points: usize,
    pub resident_points: usize,
    pub visible_points: usize,
    pub drawn_points: usize,
    pub dropped_points: usize,
    /// "equal-stride-first-last" — the only decimation rule this channel
    /// may report; anything else is a contract violation.
    pub decimation: Decimation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decimation {
    None,
    EqualStrideFirstLast,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelError {
    BudgetExceeded { requested: usize, cap: usize },
    EmptyChunk,
}

impl ChunkedSeries {
    /// Public constructor for integrators (tests and the data channel);
    /// chunk_size is clamped to at least 1 so division never panics.
    pub fn with_chunk_size(chunk_size: usize) -> Self {
        Self {
            chunk_size: chunk_size.max(1),
            chunks: Vec::new(),
            total_len: 0,
        }
    }

    /// Appends a decoded column slice; fails closed over the resident budget
    /// instead of evicting silently (callers decide what to page out).
    pub fn append(&mut self, values: &[f64]) -> Result<(), ChannelError> {
        let requested = self.resident_len().saturating_add(values.len());
        if requested > MAX_RESIDENT_POINTS {
            return Err(ChannelError::BudgetExceeded {
                requested,
                cap: MAX_RESIDENT_POINTS,
            });
        }
        for value in values {
            if !value.is_finite() {
                // Non-finite values are rejected up front: the renderer's
                // decimation cannot reason about NaN extents.
                return Err(ChannelError::EmptyChunk);
            }
        }
        let mut cursor = 0;
        while cursor < values.len() {
            let chunk_size = self.chunk_size.max(1);
            let needs_chunk = self.chunks.last().is_none_or(|chunk| {
                chunk.values.is_empty()
                    || chunk.values.len() >= chunk_size
                    || chunk.start + chunk.values.len() != self.total_len + cursor
            });
            if needs_chunk {
                self.chunks.push(SeriesChunk {
                    start: self.total_len + cursor,
                    values: Vec::new(),
                });
            }
            let tail_free = chunk_size - self.chunks.last().expect("just ensured").values.len();
            let take = tail_free.min(values.len() - cursor);
            let tail = self.chunks.last_mut().expect("non-empty after ensure");
            tail.values
                .extend_from_slice(&values[cursor..cursor + take]);
            cursor += take;
        }
        self.total_len += values.len();
        Ok(())
    }

    pub fn resident_len(&self) -> usize {
        self.chunks.iter().map(|chunk| chunk.values.len()).sum()
    }

    pub fn len(&self) -> usize {
        self.total_len
    }

    pub fn is_empty(&self) -> bool {
        self.total_len == 0
    }

    /// Returns the raw slice range [start, end) intersected with resident
    /// data; start/end are logical indices so zoom windows map directly.
    pub fn visible_slice(&self, start: usize, end: usize) -> Vec<f64> {
        let start = start.min(self.total_len);
        let end = end.min(self.total_len);
        if start >= end {
            return Vec::new();
        }
        let mut out = Vec::new();
        for chunk in &self.chunks {
            let local_start = start.saturating_sub(chunk.start);
            let local_end = end.saturating_sub(chunk.start).min(chunk.values.len());
            if local_start < local_end {
                out.extend_from_slice(&chunk.values[local_start..local_end]);
            }
        }
        out
    }

    /// Decimates `visible` down to at most `max_drawn` points keeping the
    /// first and last samples when at least two slots are available (one
    /// slot keeps the first sample; zero slots draws nothing), then
    /// produces the accounting entry for this frame.
    pub fn decimate(&self, visible: &[f64], max_drawn: usize) -> (Vec<f64>, ChannelAccounting) {
        let input = self.total_len;
        let resident = self.resident_len();
        let visible_points = visible.len();
        if visible_points <= max_drawn {
            let drawn = visible.to_vec();
            let drawn_points = drawn.len();
            return (
                drawn,
                ChannelAccounting {
                    input_points: input,
                    resident_points: resident,
                    visible_points,
                    drawn_points,
                    dropped_points: 0,
                    decimation: Decimation::None,
                },
            );
        }
        if max_drawn <= 1 {
            let drawn = if max_drawn == 0 {
                Vec::new()
            } else {
                visible.first().copied().into_iter().collect()
            };
            let drawn_points = drawn.len();
            return (
                drawn,
                ChannelAccounting {
                    input_points: input,
                    resident_points: resident,
                    visible_points,
                    drawn_points,
                    dropped_points: visible_points - drawn_points,
                    decimation: if drawn_points == visible_points {
                        Decimation::None
                    } else {
                        Decimation::EqualStrideFirstLast
                    },
                },
            );
        }
        let stride = (visible_points - 1) as f64 / (max_drawn - 1) as f64;
        let mut drawn = Vec::with_capacity(max_drawn);
        for step in 0..max_drawn - 1 {
            drawn.push(visible[(step as f64 * stride) as usize]);
        }
        drawn.push(*visible.last().expect("non-empty visible"));
        let drawn_count = drawn.len();
        (
            drawn,
            ChannelAccounting {
                input_points: input,
                resident_points: resident,
                visible_points,
                drawn_points: drawn_count,
                dropped_points: visible_points - drawn_count,
                decimation: Decimation::EqualStrideFirstLast,
            },
        )
    }

    /// Evicts whole chunks covering logical range [start, end) — paging is
    /// chunk-granular so the resident set stays chunk-aligned.
    pub fn evict_range(&mut self, start: usize, end: usize) -> usize {
        let start = start.min(self.total_len);
        let end = end.min(self.total_len);
        if start >= end {
            return 0;
        }
        let mut freed = 0;
        for chunk in &mut self.chunks {
            if chunk.start < end && chunk.start + chunk.values.len() > start {
                freed += chunk.values.len();
                chunk.values = Vec::new();
            }
        }
        self.chunks.retain(|chunk| !chunk.values.is_empty());
        freed
    }
}

#[cfg(test)]
#[path = "data_window_tests.rs"]
mod tests;
