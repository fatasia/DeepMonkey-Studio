use std::sync::mpsc;

const BYTES_PER_PIXEL: u32 = 8;

pub struct HdrDifference {
    pub changed_pixels: usize,
    pub first_luminance: f64,
    pub second_luminance: f64,
}

pub struct HdrReadbackPair {
    first: wgpu::Buffer,
    second: wgpu::Buffer,
    width: u32,
    height: u32,
    padded_bytes_per_row: u32,
}

impl HdrReadbackPair {
    pub fn new(device: &wgpu::Device, size: winit::dpi::PhysicalSize<u32>, label: &str) -> Self {
        let width = size.width.max(1);
        let height = size.height.max(1);
        let unpadded = width * BYTES_PER_PIXEL;
        let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_bytes_per_row = unpadded.div_ceil(alignment) * alignment;
        let buffer_size = u64::from(padded_bytes_per_row) * u64::from(height);
        let readback = |suffix: &str| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(&format!("Deep Engine native {label} {suffix} HDR readback")),
                size: buffer_size,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        };
        Self {
            first: readback("first"),
            second: readback("second"),
            width,
            height,
            padded_bytes_per_row,
        }
    }

    pub fn copy_first(&self, encoder: &mut wgpu::CommandEncoder, texture: &wgpu::Texture) {
        self.copy(encoder, texture, &self.first);
    }

    pub fn copy_second(&self, encoder: &mut wgpu::CommandEncoder, texture: &wgpu::Texture) {
        self.copy(encoder, texture, &self.second);
    }

    pub fn finish(&self, device: &wgpu::Device, label: &str) -> Result<HdrDifference, String> {
        let first = map_buffer(device, &self.first, &format!("{label} first"))?;
        let second = map_buffer(device, &self.second, &format!("{label} second"))?;
        let mut changed_pixels = 0;
        let mut first_luminance = 0.0;
        let mut second_luminance = 0.0;
        for row in 0..self.height as usize {
            let row_start = row * self.padded_bytes_per_row as usize;
            for column in 0..self.width as usize {
                let offset = row_start + column * BYTES_PER_PIXEL as usize;
                let a = &first[offset..offset + BYTES_PER_PIXEL as usize];
                let b = &second[offset..offset + BYTES_PER_PIXEL as usize];
                if a != b {
                    changed_pixels += 1;
                }
                first_luminance += pixel_luminance(a)?;
                second_luminance += pixel_luminance(b)?;
            }
        }
        drop(first);
        drop(second);
        self.first.unmap();
        self.second.unmap();
        Ok(HdrDifference {
            changed_pixels,
            first_luminance,
            second_luminance,
        })
    }

    fn copy(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        texture: &wgpu::Texture,
        buffer: &wgpu::Buffer,
    ) {
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(self.padded_bytes_per_row),
                    rows_per_image: Some(self.height),
                },
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
    }
}

fn map_buffer(
    device: &wgpu::Device,
    buffer: &wgpu::Buffer,
    label: &str,
) -> Result<wgpu::BufferView, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|error| format!("{label} probe device poll failed: {error}"))?;
    receiver
        .recv()
        .map_err(|error| format!("{label} probe callback failed: {error}"))?
        .map_err(|error| format!("{label} probe map failed: {error}"))?;
    buffer
        .get_mapped_range(..)
        .map_err(|error| format!("{label} probe mapped range failed: {error}"))
}

fn pixel_luminance(pixel: &[u8]) -> Result<f64, String> {
    let channel = |offset| half_to_f32(u16::from_le_bytes([pixel[offset], pixel[offset + 1]]));
    let rgb = [channel(0), channel(2), channel(4)];
    if !rgb.iter().all(|value| value.is_finite()) {
        return Err("HDR probe produced a non-finite RGB channel".into());
    }
    Ok(f64::from(rgb[0]) * 0.2126 + f64::from(rgb[1]) * 0.7152 + f64::from(rgb[2]) * 0.0722)
}

pub(crate) use deep_engine_native::half_decode::half_to_f32;

#[cfg(test)]
mod tests {
    use super::half_to_f32;

    #[test]
    fn decodes_half_float_readback_channels() {
        assert_eq!(half_to_f32(0x0000), 0.0);
        assert_eq!(half_to_f32(0x3c00), 1.0);
        assert_eq!(half_to_f32(0xc000), -2.0);
        assert!(half_to_f32(0x7e00).is_nan());
    }
}
