//! Timestamp-query storage and explicit report-path readback.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::telemetry::{SampleToken, SegmentStats, stats_from};

const GPU_SLOTS: usize = 64;
const QUERY_COUNT: u32 = 12;
const SLOT_STRIDE: u64 = wgpu::QUERY_RESOLVE_BUFFER_ALIGNMENT;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpuSegment {
    Frame,
    Shadow,
    Opaque,
    Transparent,
    Deep2d,
    Postprocess,
}

impl GpuSegment {
    const ALL: [Self; 6] = [
        Self::Frame,
        Self::Shadow,
        Self::Opaque,
        Self::Transparent,
        Self::Deep2d,
        Self::Postprocess,
    ];

    fn index(self) -> usize {
        self as usize
    }

    fn name(self) -> &'static str {
        match self {
            Self::Frame => "frame",
            Self::Shadow => "shadow",
            Self::Opaque => "opaque",
            Self::Transparent => "transparent",
            Self::Deep2d => "deep2d",
            Self::Postprocess => "postprocess",
        }
    }

    fn pair(self) -> (u32, u32) {
        if self == Self::Frame {
            (0, 1)
        } else {
            let start = 2 + (self.index() as u32 - 1) * 2;
            (start, start + 1)
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Slot {
    token: Option<SampleToken>,
    active_mask: u8,
}

#[derive(Debug, Serialize)]
pub struct GpuReadback {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub samples: usize,
    pub dropped: u64,
    pub late: u64,
    pub segments: BTreeMap<&'static str, SegmentStats>,
}

impl GpuReadback {
    pub fn degraded(reason: impl Into<String>) -> Self {
        Self {
            status: "degraded",
            reason: Some(reason.into()),
            samples: 0,
            dropped: 0,
            late: 0,
            segments: BTreeMap::new(),
        }
    }
}

pub struct GpuFrameTiming {
    query_set: wgpu::QuerySet,
    resolve_buffer: wgpu::Buffer,
    timestamp_period_ns: f64,
    slots: [Slot; GPU_SLOTS],
    sequence: u64,
    dropped: u64,
    current: Option<(SampleToken, u8)>,
}

impl GpuFrameTiming {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, _epoch: u64) -> Self {
        let query_set = device.create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("Deep Engine segmented timestamps"),
            ty: wgpu::QueryType::Timestamp,
            count: QUERY_COUNT,
        });
        let resolve_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Deep Engine timestamp ring"),
            size: GPU_SLOTS as u64 * SLOT_STRIDE,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        Self {
            query_set,
            resolve_buffer,
            timestamp_period_ns: f64::from(queue.get_timestamp_period()),
            slots: [Slot::default(); GPU_SLOTS],
            sequence: 0,
            dropped: 0,
            current: None,
        }
    }

    pub fn begin_frame(&mut self, token: SampleToken, encoder: &mut wgpu::CommandEncoder) {
        self.current = Some((token, 1));
        encoder.write_timestamp(&self.query_set, GpuSegment::Frame.pair().0);
    }

    pub fn begin(&self, segment: GpuSegment, encoder: &mut wgpu::CommandEncoder) {
        encoder.write_timestamp(&self.query_set, segment.pair().0);
    }

    pub fn end(&mut self, segment: GpuSegment, active: bool, encoder: &mut wgpu::CommandEncoder) {
        encoder.write_timestamp(&self.query_set, segment.pair().1);
        if active && let Some((_, mask)) = self.current.as_mut() {
            *mask |= 1 << segment.index();
        }
    }

    pub fn finish_frame(&mut self, token: SampleToken, encoder: &mut wgpu::CommandEncoder) {
        encoder.write_timestamp(&self.query_set, GpuSegment::Frame.pair().1);
        let Some((active_token, mask)) = self.current.take() else {
            return;
        };
        if active_token != token {
            return;
        }
        let index = self.sequence as usize % GPU_SLOTS;
        encoder.resolve_query_set(
            &self.query_set,
            0..QUERY_COUNT,
            &self.resolve_buffer,
            index as u64 * SLOT_STRIDE,
        );
        if self.sequence >= GPU_SLOTS as u64 {
            self.dropped += 1;
        }
        self.slots[index] = Slot {
            token: Some(token),
            active_mask: mask,
        };
        self.sequence += 1;
    }

    pub fn reset(&mut self, _token: SampleToken) {
        self.slots = [Slot::default(); GPU_SLOTS];
        self.sequence = 0;
        self.dropped = 0;
        self.current = None;
    }

    pub fn readback(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        token: SampleToken,
    ) -> GpuReadback {
        if self.sequence == 0 {
            return self.empty_report();
        }
        match self.readback_bytes(device, queue) {
            Ok(bytes) => self.decode(&bytes, token),
            Err(reason) => GpuReadback::degraded(reason),
        }
    }

    fn readback_bytes(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
    ) -> Result<Vec<u8>, String> {
        let size = GPU_SLOTS as u64 * SLOT_STRIDE;
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Deep Engine timestamp report readback"),
            size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Deep Engine timestamp report copy"),
        });
        encoder.copy_buffer_to_buffer(&self.resolve_buffer, 0, &staging, 0, size);
        queue.submit([encoder.finish()]);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        staging.map_async(wgpu::MapMode::Read, .., move |result| {
            let _ = sender.send(result);
        });
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("timestamp_poll_failed:{error}"))?;
        receiver
            .recv()
            .map_err(|_| "timestamp_callback_dropped".to_owned())?
            .map_err(|error| format!("timestamp_map_failed:{error}"))?;
        let mapped = staging
            .get_mapped_range(..)
            .map_err(|error| format!("timestamp_range_failed:{error}"))?;
        let bytes = mapped.to_vec();
        drop(mapped);
        staging.unmap();
        Ok(bytes)
    }

    fn decode(&self, bytes: &[u8], token: SampleToken) -> GpuReadback {
        let mut values: [Vec<u64>; 6] = std::array::from_fn(|_| Vec::new());
        let mut late = 0;
        for (index, slot) in self.slots.iter().enumerate() {
            let Some(slot_token) = slot.token else {
                continue;
            };
            if slot_token != token {
                late += 1;
                continue;
            }
            let base = index * SLOT_STRIDE as usize;
            for segment in GpuSegment::ALL {
                if slot.active_mask & (1 << segment.index()) == 0 {
                    continue;
                }
                let (a, b) = segment.pair();
                let start = read_u64(bytes, base + a as usize * 8);
                let end = read_u64(bytes, base + b as usize * 8);
                if start != 0 || end != 0 {
                    let ns = end.wrapping_sub(start) as f64 * self.timestamp_period_ns;
                    values[segment.index()].push(ns as u64);
                }
            }
        }
        let samples = values[0].len();
        if samples == 0 {
            return GpuReadback::degraded("timestamp_results_unavailable");
        }
        let mut segments = BTreeMap::new();
        for segment in GpuSegment::ALL {
            segments.insert(
                segment.name(),
                stats_from(
                    values[segment.index()].iter().copied(),
                    self.dropped,
                    samples as u64,
                ),
            );
        }
        GpuReadback {
            status: "supported",
            reason: None,
            samples,
            dropped: self.dropped,
            late,
            segments,
        }
    }

    fn empty_report(&self) -> GpuReadback {
        GpuReadback {
            status: "supported",
            reason: None,
            samples: 0,
            dropped: self.dropped,
            late: 0,
            segments: BTreeMap::new(),
        }
    }
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("bounded timestamp slot"),
    )
}

#[cfg(test)]
#[path = "telemetry_gpu_tests.rs"]
mod tests;
