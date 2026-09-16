use super::Renderer;
use crate::hdr_readback::HdrReadbackPair;

pub struct SectionReadback {
    color: HdrReadbackPair,
    before: wgpu::Buffer,
    after: wgpu::Buffer,
}

impl SectionReadback {
    pub fn new(renderer: &Renderer) -> Self {
        let bytes = u64::from(renderer.shadow_map._texture.width())
            * u64::from(renderer.shadow_map._texture.height())
            * u64::from(renderer.shadow_map._texture.depth_or_array_layers())
            * 4;
        let buffer = || {
            renderer.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Section shadow readback"),
                size: bytes,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        };
        Self {
            color: HdrReadbackPair::new(&renderer.device, renderer.size, "section"),
            before: buffer(),
            after: buffer(),
        }
    }

    pub fn capture(&self, renderer: &Renderer, first: bool) {
        let mut encoder = renderer.device.create_command_encoder(&Default::default());
        if first {
            self.color
                .copy_first(&mut encoder, renderer.forward_targets.resolved_texture());
        } else {
            self.color
                .copy_second(&mut encoder, renderer.forward_targets.resolved_texture());
        }
        let texture = &renderer.shadow_map._texture;
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::DepthOnly,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: if first { &self.before } else { &self.after },
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(texture.width() * 4),
                    rows_per_image: Some(texture.height()),
                },
            },
            texture.size(),
        );
        renderer.queue.submit([encoder.finish()]);
    }

    pub fn finish(&self, renderer: &Renderer, restored: bool) -> Result<(), String> {
        let difference = self.color.finish(&renderer.device, "section")?;
        let (sender, receiver) = std::sync::mpsc::channel();
        for buffer in [&self.before, &self.after] {
            let sender = sender.clone();
            buffer
                .slice(..)
                .map_async(wgpu::MapMode::Read, move |result| {
                    let _ = sender.send(result);
                });
        }
        renderer
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|e| e.to_string())?;
        for _ in 0..2 {
            receiver
                .recv_timeout(std::time::Duration::from_secs(3))
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
        }
        let before = self
            .before
            .slice(..)
            .get_mapped_range()
            .map_err(|e| e.to_string())?;
        let after = self
            .after
            .slice(..)
            .get_mapped_range()
            .map_err(|e| e.to_string())?;
        let shadow_changes = before
            .chunks_exact(4)
            .zip(after.chunks_exact(4))
            .filter(|(a, b)| a != b)
            .count();
        drop(before);
        drop(after);
        self.before.unmap();
        self.after.unmap();
        if (!restored && (difference.changed_pixels < 4 || shadow_changes < 4))
            || (restored && (difference.changed_pixels != 0 || shadow_changes != 0))
        {
            return Err(format!(
                "section pixels mismatch: restored={restored} color={} shadow={shadow_changes}",
                difference.changed_pixels
            ));
        }
        println!(
            "native section pixels OK: restored={restored} color={} shadow={shadow_changes}",
            difference.changed_pixels
        );
        Ok(())
    }
}
