use super::DashboardRuntime;
use crate::{
    dashboard_video::{
        DashboardVideoDecoder, DashboardVideoFrameTexture, DecodedDashboardVideoFrame,
    },
    runtime_package::{DashboardVideoDiagnostic, DashboardVideoMedia},
};
use std::time::Duration;

const DEFAULT_FRAME_INTERVAL_100NS: i64 = 333_333;
const MAX_DECODED_FRAMES_PER_ADVANCE: usize = 2_048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DashboardVideoAdvance {
    pub texture_updated: bool,
    pub texture_serial: u64,
    /// Monotonic presentation time written to the texture, including completed loops.
    pub presentation_100ns: i64,
    /// Position inside the current media loop.
    pub position_100ns: i64,
    pub completed_loops: u64,
    pub ended: bool,
    pub playing: bool,
    pub duration_100ns: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardVideoCommand {
    Play,
    Pause,
    Toggle,
    SeekTo100ns(i64),
    SeekBy100ns(i64),
}

/// Maps the standalone video control keys used by the Web player. The host
/// may call this without routing keys through camera handling.
pub fn dashboard_video_key_command(key: &str, shift: bool) -> Option<DashboardVideoCommand> {
    let step = if shift { 10 } else { 5 } * 10_000_000;
    match key {
        "Space" | "Enter" => Some(DashboardVideoCommand::Toggle),
        "ArrowLeft" => Some(DashboardVideoCommand::SeekBy100ns(-step)),
        "ArrowRight" => Some(DashboardVideoCommand::SeekBy100ns(step)),
        "Home" => Some(DashboardVideoCommand::SeekTo100ns(0)),
        "End" => Some(DashboardVideoCommand::SeekTo100ns(i64::MAX)),
        _ => None,
    }
}

/// Converts a normalized scrubber position into a bounded media seek.
pub fn dashboard_video_drag_command(
    normalized: f64,
    duration_100ns: i64,
) -> Result<DashboardVideoCommand, String> {
    if !normalized.is_finite() || duration_100ns <= 0 {
        return Err("invalid dashboard video scrubber position".into());
    }
    let bounded = normalized.clamp(0.0, 1.0);
    Ok(DashboardVideoCommand::SeekTo100ns(
        (bounded * duration_100ns as f64).round() as i64,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardVideoFit {
    Cover,
    Contain,
    Fill,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DashboardVideoPlacement {
    pub destination: [f32; 4],
    pub uv: [f32; 4],
}

/// Muted playback with explicit author/runtime play, pause and bounded seek.
pub struct DashboardVideoPlayback {
    decoder: DashboardVideoDecoder,
    texture: DashboardVideoFrameTexture,
    pending: Option<(i64, DecodedDashboardVideoFrame)>,
    fit: DashboardVideoFit,
    autoplay: bool,
    playing: bool,
    loop_enabled: bool,
    duration_100ns: i64,
    started_at: Duration,
    clock_anchor_100ns: i64,
    last_clock: Duration,
    loop_base_100ns: i64,
    last_source_pts_100ns: i64,
    frame_interval_100ns: i64,
    position_100ns: i64,
    completed_loops: u64,
    ended: bool,
    presentation_offset_100ns: i64,
    lifecycle_suspended_at: Option<Duration>,
}

impl DashboardRuntime {
    pub fn prepare_video_playback(
        &self,
        node_id: &str,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        monotonic_now: Duration,
    ) -> Result<DashboardVideoPlayback, String> {
        let diagnostic = self
            .document()
            .videos
            .iter()
            .find(|video| video.node_id == node_id)
            .ok_or("dashboard video node missing")?;
        let media = packaged_media(self, diagnostic)?;
        if !diagnostic.playback.muted {
            return Err("dashboard Native video requires authored muted playback".into());
        }
        DashboardVideoPlayback::new(diagnostic, media, device, queue, monotonic_now)
    }
}

fn packaged_media<'a>(
    runtime: &'a DashboardRuntime,
    diagnostic: &DashboardVideoDiagnostic,
) -> Result<&'a DashboardVideoMedia, String> {
    if !diagnostic.source.packaged || diagnostic.source.availability != "packaged" {
        return Err("dashboard video source is not packaged".into());
    }
    let id = diagnostic
        .source
        .resource_id
        .as_deref()
        .ok_or("dashboard video resource identity missing")?;
    runtime
        .document()
        .media
        .iter()
        .find(|media| media.id == id)
        .ok_or_else(|| "dashboard video resource missing".into())
}

impl DashboardVideoPlayback {
    fn new(
        diagnostic: &DashboardVideoDiagnostic,
        media: &DashboardVideoMedia,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        monotonic_now: Duration,
    ) -> Result<Self, String> {
        let mut decoder = DashboardVideoDecoder::new(media)?;
        let first = decoder
            .next_frame()?
            .ok_or("dashboard MP4 contains no video frames")?;
        let position_100ns = first.timestamp_100ns;
        let fit = match diagnostic.playback.fit.as_str() {
            "cover" => DashboardVideoFit::Cover,
            "contain" => DashboardVideoFit::Contain,
            "fill" => DashboardVideoFit::Fill,
            _ => return Err("invalid dashboard video fit".into()),
        };
        let texture = DashboardVideoFrameTexture::new(device, queue, &first)?;
        let duration_100ns = decoder.duration_100ns();
        Ok(Self {
            decoder,
            texture,
            pending: None,
            fit,
            autoplay: diagnostic.playback.autoplay,
            playing: diagnostic.playback.autoplay,
            loop_enabled: diagnostic.playback.r#loop,
            duration_100ns,
            started_at: monotonic_now,
            clock_anchor_100ns: position_100ns,
            last_clock: monotonic_now,
            loop_base_100ns: 0,
            last_source_pts_100ns: position_100ns,
            frame_interval_100ns: DEFAULT_FRAME_INTERVAL_100NS,
            position_100ns,
            completed_loops: 0,
            ended: false,
            presentation_offset_100ns: 0,
            lifecycle_suspended_at: None,
        })
    }

    pub fn advance_to(
        &mut self,
        queue: &wgpu::Queue,
        monotonic_now: Duration,
    ) -> Result<DashboardVideoAdvance, String> {
        if monotonic_now < self.last_clock {
            return Err("dashboard video clock moved backwards".into());
        }
        self.last_clock = monotonic_now;
        if !self.playing || self.ended || self.lifecycle_suspended_at.is_some() {
            return Ok(self.snapshot(false));
        }
        let elapsed = monotonic_now
            .checked_sub(self.started_at)
            .ok_or("dashboard video clock moved before its epoch")?;
        let target_100ns = self
            .clock_anchor_100ns
            .checked_add(duration_100ns(elapsed)?)
            .ok_or("dashboard video media clock overflow")?;
        let mut latest = None;
        let mut settled = false;
        for _ in 0..MAX_DECODED_FRAMES_PER_ADVANCE {
            let next = if let Some(frame) = self.pending.take() {
                Some(frame)
            } else {
                self.decoder.next_frame()?.map(|frame| {
                    let absolute = self.loop_base_100ns + frame.timestamp_100ns;
                    (absolute, frame)
                })
            };
            let Some((absolute, frame)) = next else {
                if !self.loop_enabled {
                    self.ended = true;
                    settled = true;
                    break;
                }
                let duration = self
                    .last_source_pts_100ns
                    .checked_add(self.frame_interval_100ns)
                    .filter(|duration| *duration > 0)
                    .ok_or("dashboard video loop duration overflow")?;
                self.loop_base_100ns = self
                    .loop_base_100ns
                    .checked_add(duration)
                    .ok_or("dashboard video loop clock overflow")?;
                self.completed_loops = self
                    .completed_loops
                    .checked_add(1)
                    .ok_or("dashboard video loop counter exhausted")?;
                self.last_source_pts_100ns = 0;
                self.decoder.restart()?;
                if self.loop_base_100ns > target_100ns {
                    settled = true;
                    break;
                }
                continue;
            };
            if absolute > target_100ns {
                self.pending = Some((absolute, frame));
                settled = true;
                break;
            }
            if frame.timestamp_100ns > self.last_source_pts_100ns {
                self.frame_interval_100ns = frame.timestamp_100ns - self.last_source_pts_100ns;
            }
            self.last_source_pts_100ns = frame.timestamp_100ns;
            self.position_100ns = frame.timestamp_100ns;
            latest = Some((absolute, frame));
        }
        if !settled {
            return Err("dashboard video advance exceeded its frame decode budget".into());
        }
        let updated = if let Some((absolute, mut frame)) = latest {
            frame.timestamp_100ns = absolute
                .checked_add(self.presentation_offset_100ns)
                .ok_or("dashboard video presentation clock overflow")?;
            self.texture.update(queue, &frame)?;
            true
        } else {
            false
        };
        Ok(self.snapshot(updated))
    }

    pub fn texture(&self) -> &wgpu::Texture {
        self.texture.texture()
    }

    pub fn is_muted(&self) -> bool {
        true
    }

    pub fn autoplay(&self) -> bool {
        self.autoplay
    }

    pub fn is_playing(&self) -> bool {
        self.playing && !self.ended && self.lifecycle_suspended_at.is_none()
    }

    pub fn duration_100ns(&self) -> i64 {
        self.duration_100ns
    }

    pub fn loop_enabled(&self) -> bool {
        self.loop_enabled
    }

    pub fn state(&self) -> DashboardVideoAdvance {
        self.snapshot(false)
    }

    pub fn control(
        &mut self,
        queue: &wgpu::Queue,
        monotonic_now: Duration,
        command: DashboardVideoCommand,
    ) -> Result<DashboardVideoAdvance, String> {
        if monotonic_now < self.last_clock {
            return Err("dashboard video control clock moved backwards".into());
        }
        let serial = self.texture.update_serial();
        match command {
            DashboardVideoCommand::Play => self.play(queue, monotonic_now)?,
            DashboardVideoCommand::Pause => self.pause(queue, monotonic_now)?,
            DashboardVideoCommand::Toggle if self.playing => self.pause(queue, monotonic_now)?,
            DashboardVideoCommand::Toggle => self.play(queue, monotonic_now)?,
            DashboardVideoCommand::SeekTo100ns(position) => {
                self.seek(queue, monotonic_now, position)?;
            }
            DashboardVideoCommand::SeekBy100ns(delta) => {
                let position = self.position_100ns.saturating_add(delta);
                self.seek(queue, monotonic_now, position)?;
            }
        }
        Ok(self.snapshot(self.texture.update_serial() != serial))
    }

    fn pause(&mut self, queue: &wgpu::Queue, monotonic_now: Duration) -> Result<(), String> {
        if !self.playing {
            self.last_clock = monotonic_now;
            return Ok(());
        }
        self.advance_to(queue, monotonic_now)?;
        self.playing = false;
        self.clock_anchor_100ns = self
            .loop_base_100ns
            .checked_add(self.position_100ns)
            .ok_or("dashboard video pause clock overflow")?;
        self.started_at = monotonic_now;
        Ok(())
    }

    fn play(&mut self, queue: &wgpu::Queue, monotonic_now: Duration) -> Result<(), String> {
        if self.playing && !self.ended {
            self.last_clock = monotonic_now;
            return Ok(());
        }
        if self.ended {
            self.seek(queue, monotonic_now, 0)?;
        }
        self.playing = true;
        self.clock_anchor_100ns = self
            .loop_base_100ns
            .checked_add(self.position_100ns)
            .ok_or("dashboard video play clock overflow")?;
        self.started_at = monotonic_now;
        self.last_clock = monotonic_now;
        Ok(())
    }

    fn seek(
        &mut self,
        queue: &wgpu::Queue,
        monotonic_now: Duration,
        requested_100ns: i64,
    ) -> Result<(), String> {
        let target = requested_100ns.clamp(
            0,
            self.duration_100ns
                .saturating_sub(self.frame_interval_100ns.max(1)),
        );
        self.decoder.seek(target)?;
        self.pending = None;
        let mut selected = None;
        for _ in 0..MAX_DECODED_FRAMES_PER_ADVANCE {
            let Some(frame) = self.decoder.next_frame()? else {
                break;
            };
            let reached = frame.timestamp_100ns >= target;
            selected = Some(frame);
            if reached {
                break;
            }
        }
        let mut frame = selected.ok_or("dashboard video seek produced no frame")?;
        self.position_100ns = frame.timestamp_100ns;
        self.last_source_pts_100ns = frame.timestamp_100ns;
        self.loop_base_100ns = 0;
        self.completed_loops = 0;
        self.ended = false;
        self.clock_anchor_100ns = frame.timestamp_100ns;
        self.started_at = monotonic_now;
        self.last_clock = monotonic_now;
        let source_presentation = frame.timestamp_100ns;
        let minimum = self.texture.last_timestamp_100ns().saturating_add(1);
        let presentation = source_presentation.max(minimum);
        self.presentation_offset_100ns = presentation - source_presentation;
        frame.timestamp_100ns = presentation;
        self.texture.update(queue, &frame)?;
        Ok(())
    }

    /// Freezes autoplay for an application/window lifecycle suspension. This
    /// is not an authored playback control and does not clear that blocker.
    pub fn suspend_for_lifecycle(
        &mut self,
        queue: &wgpu::Queue,
        monotonic_now: Duration,
    ) -> Result<DashboardVideoAdvance, String> {
        let state = self.advance_to(queue, monotonic_now)?;
        self.lifecycle_suspended_at = Some(monotonic_now);
        Ok(state)
    }

    pub fn resume_from_lifecycle(&mut self, monotonic_now: Duration) -> Result<(), String> {
        let suspended_at = self
            .lifecycle_suspended_at
            .take()
            .ok_or("dashboard video is not lifecycle-suspended")?;
        if monotonic_now < suspended_at {
            self.lifecycle_suspended_at = Some(suspended_at);
            return Err("dashboard video resume clock moved backwards".into());
        }
        self.started_at = self
            .started_at
            .checked_add(monotonic_now - suspended_at)
            .ok_or("dashboard video lifecycle clock overflow")?;
        self.last_clock = monotonic_now;
        Ok(())
    }

    pub fn placement(&self, width: f32, height: f32) -> Result<DashboardVideoPlacement, String> {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return Err("invalid dashboard video placement size".into());
        }
        let source_aspect =
            self.texture.texture().width() as f32 / self.texture.texture().height() as f32;
        let target_aspect = width / height;
        let full = DashboardVideoPlacement {
            destination: [0.0, 0.0, width, height],
            uv: [0.0, 0.0, 1.0, 1.0],
        };
        Ok(match self.fit {
            DashboardVideoFit::Fill => full,
            DashboardVideoFit::Contain if source_aspect > target_aspect => {
                let draw_height = width / source_aspect;
                DashboardVideoPlacement {
                    destination: [0.0, (height - draw_height) * 0.5, width, draw_height],
                    uv: full.uv,
                }
            }
            DashboardVideoFit::Contain => {
                let draw_width = height * source_aspect;
                DashboardVideoPlacement {
                    destination: [(width - draw_width) * 0.5, 0.0, draw_width, height],
                    uv: full.uv,
                }
            }
            DashboardVideoFit::Cover if source_aspect > target_aspect => {
                let visible = target_aspect / source_aspect;
                DashboardVideoPlacement {
                    destination: full.destination,
                    uv: [(1.0 - visible) * 0.5, 0.0, visible, 1.0],
                }
            }
            DashboardVideoFit::Cover => {
                let visible = source_aspect / target_aspect;
                DashboardVideoPlacement {
                    destination: full.destination,
                    uv: [0.0, (1.0 - visible) * 0.5, 1.0, visible],
                }
            }
        })
    }

    fn snapshot(&self, texture_updated: bool) -> DashboardVideoAdvance {
        DashboardVideoAdvance {
            texture_updated,
            texture_serial: self.texture.update_serial(),
            presentation_100ns: self.texture.last_timestamp_100ns(),
            position_100ns: self.position_100ns,
            completed_loops: self.completed_loops,
            ended: self.ended,
            playing: self.is_playing(),
            duration_100ns: self.duration_100ns,
        }
    }
}

fn duration_100ns(duration: Duration) -> Result<i64, String> {
    let ticks = duration.as_nanos() / 100;
    i64::try_from(ticks).map_err(|_| "dashboard video media clock overflow".into())
}
