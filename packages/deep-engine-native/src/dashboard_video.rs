//! Windows MP4 frame preparation primitives. Dashboard playback remains gated
//! until the media clock, scheduler, controls, and seek contract are complete.

use crate::runtime_package::DashboardVideoMedia;

const MEDIA_BYTES_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardVideoPixelFormat {
    /// Media Foundation `MFVideoFormat_RGB32`; byte order is BGRA on little-endian Windows.
    Bgra8UnormSrgb,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardVideoColorContract {
    /// Source metadata values are Media Foundation enum discriminants. Missing
    /// container metadata stays `None`; callers must not invent a source gamut.
    pub source_primaries: Option<u32>,
    pub source_transfer: Option<u32>,
    pub source_matrix: Option<u32>,
    pub source_nominal_range: Option<u32>,
    /// The Source Reader video processor converts the decoded surface to RGB32.
    pub conversion: &'static str,
    pub output_transfer: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedDashboardVideoFrame {
    pub width: u32,
    pub height: u32,
    pub row_bytes: u32,
    /// Presentation timestamp in Media Foundation 100-nanosecond units.
    pub timestamp_100ns: i64,
    pub pixel_format: DashboardVideoPixelFormat,
    pub color: DashboardVideoColorContract,
    /// Tightly packed, top-down BGRA rows.
    pub pixels: Vec<u8>,
}

impl DecodedDashboardVideoFrame {
    fn validate(&self) -> Result<(), String> {
        let row_bytes = self
            .width
            .checked_mul(4)
            .ok_or("decoded video row byte overflow")?;
        let bytes = row_bytes
            .checked_mul(self.height)
            .ok_or("decoded video frame byte overflow")? as usize;
        if self.width == 0
            || self.height == 0
            || self.row_bytes != row_bytes
            || self.pixels.len() != bytes
            || self.timestamp_100ns < 0
        {
            return Err("invalid decoded dashboard video frame".into());
        }
        Ok(())
    }
}

/// One GPU texture whose storage can be updated by decoded video frames with
/// stable dimensions. It is deliberately independent from playback scheduling.
pub struct DashboardVideoFrameTexture {
    texture: wgpu::Texture,
    width: u32,
    height: u32,
    last_timestamp_100ns: i64,
    update_serial: u64,
}

impl DashboardVideoFrameTexture {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        frame: &DecodedDashboardVideoFrame,
    ) -> Result<Self, String> {
        frame.validate()?;
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep Engine dashboard video frame v1"),
            size: wgpu::Extent3d {
                width: frame.width,
                height: frame.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Bgra8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let mut resident = Self {
            texture,
            width: frame.width,
            height: frame.height,
            last_timestamp_100ns: -1,
            update_serial: 0,
        };
        resident.update(queue, frame)?;
        Ok(resident)
    }

    pub fn update(
        &mut self,
        queue: &wgpu::Queue,
        frame: &DecodedDashboardVideoFrame,
    ) -> Result<(), String> {
        frame.validate()?;
        if frame.width != self.width || frame.height != self.height {
            return Err("dashboard video frame dimensions changed".into());
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &frame.pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(frame.row_bytes),
                rows_per_image: Some(frame.height),
            },
            wgpu::Extent3d {
                width: frame.width,
                height: frame.height,
                depth_or_array_layers: 1,
            },
        );
        self.last_timestamp_100ns = frame.timestamp_100ns;
        self.update_serial = self
            .update_serial
            .checked_add(1)
            .ok_or("dashboard video texture update serial exhausted")?;
        Ok(())
    }

    pub fn texture(&self) -> &wgpu::Texture {
        &self.texture
    }

    pub fn update_serial(&self) -> u64 {
        self.update_serial
    }

    pub fn last_timestamp_100ns(&self) -> i64 {
        self.last_timestamp_100ns
    }
}

/// Decodes the first presentation frame from validated packaged MP4 bytes.
/// The package identity and 32 MiB bound are rechecked at the decoder boundary.
pub fn decode_first_packaged_mp4_frame(
    media: &DashboardVideoMedia,
) -> Result<DecodedDashboardVideoFrame, String> {
    let mut decoder = DashboardVideoDecoder::new(media)?;
    decoder
        .next_frame()?
        .ok_or_else(|| "MP4 ended before a video frame was decoded".into())
}

pub struct DashboardVideoDecoder {
    inner: media_foundation::MediaFoundationVideoDecoder,
}

impl DashboardVideoDecoder {
    pub fn new(media: &DashboardVideoMedia) -> Result<Self, String> {
        Ok(Self {
            inner: media_foundation::MediaFoundationVideoDecoder::new(validated_media_bytes(
                media,
            )?)?,
        })
    }

    pub fn next_frame(&mut self) -> Result<Option<DecodedDashboardVideoFrame>, String> {
        self.inner.next_frame()
    }

    pub fn restart(&mut self) -> Result<(), String> {
        self.inner.restart()
    }

    pub fn duration_100ns(&self) -> i64 {
        self.inner.duration_100ns()
    }

    pub fn seek(&mut self, position_100ns: i64) -> Result<(), String> {
        self.inner.seek(position_100ns)
    }
}

fn validated_media_bytes(media: &DashboardVideoMedia) -> Result<Vec<u8>, String> {
    let bytes = crate::deep2d::runtime_base64::decode(&media.data_base64)
        .map_err(|error| format!("dashboard video base64: {error}"))?;
    if bytes.len() > MEDIA_BYTES_LIMIT
        || bytes.len() != media.byte_length
        || media.revision != 1
        || media.mime != "video/mp4"
        || media.format != "mp4-isobmff"
        || crate::shader_package::hash::sha256(&bytes) != media.sha256
        || media.id != format!("media.{}", media.sha256)
        || !crate::runtime_package::is_mp4_isobmff(&bytes)
    {
        return Err("invalid packaged dashboard MP4 at decode boundary".into());
    }
    Ok(bytes)
}

mod media_foundation;
