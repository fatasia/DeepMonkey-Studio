//! Small native audio output used by packaged dashboard video.
//! The scope is deliberately one MP4 audio track, one system output at a time,
//! deterministic transport controls and explicit device reopen. Spatial audio
//! and multi-voice mixing stay out.

use rodio::cpal::traits::HostTrait;
use rodio::{Decoder, DeviceSinkBuilder, DeviceTrait, Player, Source};
use std::{io::Cursor, time::Duration};

pub struct DashboardAudioTrack {
    _device: rodio::MixerDeviceSink,
    player: Player,
    loop_duration: Option<Duration>,
    duration: Option<Duration>,
    bytes: Vec<u8>,
    loop_enabled: bool,
    volume: f32,
    device_name: String,
}

impl DashboardAudioTrack {
    /// loop_duration:视频 PTS 循环周期。音频源截齐到该周期再无限循环,
    /// 消除编解码 padding 尾巴造成的回绕相位跳(实测恒 500ms)。
    pub fn from_mp4(
        bytes: Vec<u8>,
        loop_enabled: bool,
        loop_duration: Option<Duration>,
    ) -> Result<Self, String> {
        let device = DeviceSinkBuilder::from_default_device()
            .and_then(|builder| builder.open_stream())
            .map_err(|error| format!("open default audio output: {error}"))?;
        Self::from_mp4_with_device(
            bytes,
            loop_enabled,
            device,
            "default",
            Duration::ZERO,
            loop_duration,
        )
    }

    fn from_mp4_with_device(
        bytes: Vec<u8>,
        loop_enabled: bool,
        device: rodio::MixerDeviceSink,
        device_name: impl Into<String>,
        start_position: Duration,
        loop_duration: Option<Duration>,
    ) -> Result<Self, String> {
        let decoder = Decoder::builder()
            .with_byte_len(bytes.len() as u64)
            .with_data(Cursor::new(bytes.clone()))
            .with_mime_type("video/mp4")
            .with_seekable(true)
            .build()
            .map_err(|error| format!("decode MP4 AAC audio: {error}"))?;
        let duration = decoder.total_duration();
        let player = Player::connect_new(device.mixer());
        // 单一类型链:skip_duration(0) 等价恒等;take_duration 截齐循环周期,
        // 让音频回绕与视频 PTS 回绕同步(无 loop_duration 时截到自然时长)。
        let skip = if start_position.is_zero() {
            Duration::ZERO
        } else {
            start_position
        };
        let period = loop_duration.unwrap_or_else(|| duration.unwrap_or(Duration::from_secs(1)));
        let source = decoder
            .skip_duration(skip)
            .take_duration(period.max(Duration::from_millis(1)));
        if loop_enabled {
            player.append(source.repeat_infinite());
        } else {
            player.append(source);
        }
        player.pause();
        Ok(Self {
            _device: device,
            player,
            duration,
            bytes,
            loop_enabled,
            loop_duration,
            volume: 1.0,
            device_name: device_name.into(),
        })
    }

    /// Returns the current Windows/CPAL output device names. The first entry
    /// is the system default when available.
    pub fn output_devices() -> Result<Vec<String>, String> {
        let host = rodio::cpal::default_host();
        let mut names = Vec::new();
        let default = host.default_output_device().and_then(|d| {
            d.description()
                .ok()
                .map(|description| description.name().to_string())
        });
        if let Some(name) = default {
            names.push(name);
        }
        let devices = host
            .output_devices()
            .map_err(|error| format!("enumerate audio outputs: {error}"))?;
        for device in devices {
            if let Ok(description) = device.description() {
                let name = description.name().to_string();
                if !names.iter().any(|existing| existing == &name) {
                    names.push(name);
                }
            }
        }
        Ok(names)
    }

    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    /// Reopens the same decoded source on a named output device while
    /// preserving volume, transport position and playing state at the caller.
    pub fn reopen_on_device(&self, requested_name: &str) -> Result<Self, String> {
        self.reopen_on_device_at(requested_name, self.position())
    }

    /// Same as [`Self::reopen_on_device`], but the source starts at an
    /// explicit media position. Used when the queue cannot seek in place
    /// (device switch, unsupported-backend resync, user seek).
    pub fn reopen_on_device_at(
        &self,
        requested_name: &str,
        start_position: Duration,
    ) -> Result<Self, String> {
        let host = rodio::cpal::default_host();
        let device = host
            .output_devices()
            .map_err(|error| format!("enumerate audio outputs: {error}"))?
            .find(|device| {
                device
                    .description()
                    .map(|description| description.name() == requested_name)
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("audio output device not found: {requested_name}"))?;
        let sink = DeviceSinkBuilder::from_device(device)
            .and_then(|builder| builder.open_stream())
            .map_err(|error| format!("open audio output {requested_name}: {error}"))?;
        let track = Self::from_mp4_with_device(
            self.bytes.clone(),
            self.loop_enabled,
            sink,
            requested_name.to_string(),
            start_position,
            self.loop_duration,
        )?;
        track.player.set_volume(self.volume);
        Ok(track)
    }

    pub fn play(&self) {
        self.player.play();
    }
    pub fn pause(&self) {
        self.player.pause();
    }
    pub fn stop(&self) {
        self.player.stop();
    }
    pub fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 1.0);
        self.player.set_volume(self.volume);
    }
    pub fn position(&self) -> Duration {
        self.player.get_pos()
    }
    /// `Ok(true)` when the backend seeked in place; `Ok(false)` when the
    /// queue cannot seek this source (rodio arbitrary-source queues report
    /// "not supported"). Callers must treat `Ok(false)` as "still unsynced"
    /// and reopen the source — never as success.
    pub fn try_seek(&self, position: Duration) -> Result<bool, String> {
        match self.player.try_seek(position) {
            Ok(()) => Ok(true),
            Err(error) if error.to_string().contains("not supported") => Ok(false),
            Err(error) => Err(format!("seek MP4 AAC audio: {error}")),
        }
    }
    pub fn duration(&self) -> Option<Duration> {
        self.duration
    }
}
