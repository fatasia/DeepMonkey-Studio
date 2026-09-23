use super::DashboardRuntime;
use crate::{
    dashboard_audio::DashboardAudioTrack,
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

/// Packaged playback with explicit author/runtime play, pause and bounded seek.
pub struct DashboardVideoPlayback {
    decoder: DashboardVideoDecoder,
    audio: Option<DashboardAudioTrack>,
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
        let audio = if diagnostic.playback.muted {
            None
        } else {
            let bytes = crate::deep2d::runtime_base64::decode(&media.data_base64)
                .map_err(|error| format!("dashboard audio media: {error}"))?;
            // 音频循环周期对齐视频 PTS 周期(100ns -> Duration)。
            let loop_duration = if diagnostic.playback.r#loop && duration_100ns > 0 {
                Some(Duration::from_nanos(duration_100ns as u64 * 100))
            } else {
                None
            };
            Some(DashboardAudioTrack::from_mp4(bytes, diagnostic.playback.r#loop, loop_duration)?)
        };
        if diagnostic.playback.autoplay {
            if let Some(audio) = &audio { audio.play(); }
        }
        Ok(Self {
            decoder,
            audio,
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
                    if let Some(audio) = &self.audio { audio.pause(); }
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
        // 音频设备钟与系统钟存在 ~200ppm 晶振差,长稳播放会让音画偏差线性
        // 累积(30s 证据 140ms,30min 实测 500ms)。超过阈值即重同步:
        // 后端支持原地 seek 就把音频拉回媒体钟;不支持(rodio 任意源队列)
        // 就从当前媒体位置重开音频源——绝不把"不支持"当成已对齐。
        let drift = self.audio_media_clock_drift_100ns(target_100ns);
        if drift.abs() > AUDIO_RESYNC_THRESHOLD_100NS {
            let target = self.audio_position_for_media_clock(target_100ns);
            if let Some(audio) = self.audio.as_mut() {
                let device_name = audio.device_name().to_string();
                if !audio.try_seek(target)? {
                    let reopened = audio.reopen_on_device_at(&device_name, target)?;
                    *audio = reopened;
                    if self.playing {
                        audio.play();
                    }
                }
            }
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
        self.audio.is_none()
    }

    pub fn autoplay(&self) -> bool {
        self.autoplay
    }

    pub fn is_playing(&self) -> bool {
        self.playing && !self.ended && self.lifecycle_suspended_at.is_none()
    }

    /// Switches the native output device without rebuilding the video decoder.
    /// The new sink is aligned to the current media clock before it is resumed.
    pub fn switch_audio_device(
        &mut self,
        queue: &wgpu::Queue,
        monotonic_now: Duration,
        device_name: &str,
    ) -> Result<DashboardVideoAdvance, String> {
        let Some(current) = self.audio.take() else {
            return Err("dashboard video has no audio track".into());
        };
        let was_playing = self.playing && self.lifecycle_suspended_at.is_none();
        let replacement = match current.reopen_on_device(device_name) {
            Ok(track) => track,
            Err(error) => {
                self.audio = Some(current);
                return Err(error);
            }
        };
        if was_playing { replacement.play(); }
        self.audio = Some(replacement);
        self.last_clock = monotonic_now;
        // Force a presentation tick so callers can verify the video clock was
        // not reset while the output stream changed.
        self.advance_to(queue, monotonic_now)
    }

    pub fn duration_100ns(&self) -> i64 {
        self.duration_100ns
    }

    pub fn audio_device_name(&self) -> Option<&str> {
        self.audio.as_ref().map(|audio| audio.device_name())
    }

    pub fn audio_position_100ns(&self) -> Option<i64> {
        self.audio.as_ref().map(|audio| {
            let nanos = audio.position().as_nanos() / 100;
            i64::try_from(nanos).unwrap_or(i64::MAX)
        })
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
        if let Some(audio) = &self.audio { audio.pause(); }
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
        if let Some(audio) = &self.audio { audio.play(); }
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
        let target_position = self.audio_position_for_media_clock(target);
        if let Some(audio) = self.audio.as_mut() {
            let device_name = audio.device_name().to_string();
            if !audio.try_seek(target_position)? {
                // rodio 任意源队列不支持原地 seek:从目标位置重开音频源,
                // 否则 seek 后音频停留在旧位置,音画永久失同步。
                let reopened = audio.reopen_on_device_at(&device_name, target_position)?;
                *audio = reopened;
                if self.playing {
                    audio.play();
                }
            }
        }
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
        if let Some(audio) = &self.audio { audio.pause(); }
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
        if self.playing {
            if let Some(audio) = &self.audio { audio.play(); }
        }
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

    fn audio_position_for_media_clock(&self, absolute_100ns: i64) -> Duration {
        let position = if self.loop_enabled && self.duration_100ns > 0 {
            absolute_100ns.rem_euclid(self.duration_100ns)
        } else {
            absolute_100ns.max(0)
        };
        Duration::from_nanos((position as u64).saturating_mul(100))
    }

    /// 音频设备消费位置与媒体钟的带符号差(同一绝对时间线,循环回绕取最短方向)。
    fn audio_media_clock_drift_100ns(&self, target_100ns: i64) -> i64 {
        let Some(audio) = &self.audio else { return 0 };
        let position = duration_100ns(audio.position()).unwrap_or(0);
        wrapped_delta_100ns(
            self.loop_base_100ns + position - target_100ns,
            self.duration_100ns.max(1),
        )
    }
}

/// 音画重同步阈值:偏差超过即触发(先原地 seek,不支持则重开音频源)。
/// 取 100ms,低于 150ms 正式验收门槛,给重同步动作本身留出余量。
const AUDIO_RESYNC_THRESHOLD_100NS: i64 = 1_000_000;

/// 媒体重同步用的最短带符号回绕差:音视频各自回绕不同步时,
/// 只按最短方向拉齐,绝不把钟拨整整一圈。
fn wrapped_delta_100ns(delta: i64, period: i64) -> i64 {
    let direct = delta.rem_euclid(period);
    if direct * 2 <= period {
        direct
    } else {
        direct - period
    }
}

#[cfg(test)]
mod audio_resync_tests {
    use super::wrapped_delta_100ns;

    #[test]
    fn wrapped_delta_picks_shortest_direction_across_loop_boundary() {
        let period = 1_000_000;
        // 音频已回绕到 0.1s,媒体钟还在 99.0s:最短方向是 +0.2s(向前拉齐)。
        assert_eq!(wrapped_delta_100ns(10_000 - 990_000, period), 20_000);
        // 镜像:媒体钟在 0.1s,音频在 99.0s:最短方向是 -0.2s。
        assert_eq!(wrapped_delta_100ns(990_000 - 10_000, period), -20_000);
        assert_eq!(wrapped_delta_100ns(200_000, period), 200_000);
        assert_eq!(wrapped_delta_100ns(-200_000, period), -200_000);
        assert_eq!(wrapped_delta_100ns(0, period), 0);
        // 恰好半周期:归一到非负方向。
        assert_eq!(wrapped_delta_100ns(500_000, period), 500_000);
    }
}

fn duration_100ns(duration: Duration) -> Result<i64, String> {
    let ticks = duration.as_nanos() / 100;
    i64::try_from(ticks).map_err(|_| "dashboard video media clock overflow".into())
}
