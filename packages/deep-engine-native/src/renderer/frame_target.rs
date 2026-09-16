use super::Renderer;
use crate::events::RenderOutcome;

pub(super) struct FrameTarget {
    pub view: wgpu::TextureView,
    output: Option<wgpu::SurfaceTexture>,
    pub suboptimal: bool,
}
impl FrameTarget {
    pub fn present(self, queue: &wgpu::Queue) {
        if let Some(output) = self.output {
            queue.present(output);
        }
    }
}
impl Renderer {
    pub(super) fn acquire_frame_target(&self, present: bool) -> Result<FrameTarget, RenderOutcome> {
        if !present {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("unpublished package validation target"),
                size: wgpu::Extent3d {
                    width: self.size.width,
                    height: self.size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: self.config.format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            return Ok(FrameTarget {
                view: texture.create_view(&Default::default()),
                output: None,
                suboptimal: false,
            });
        }
        let (output, suboptimal) = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(output) => (output, false),
            wgpu::CurrentSurfaceTexture::Suboptimal(output) => (output, true),
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return Err(RenderOutcome::Skipped);
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
                return Err(RenderOutcome::Skipped);
            }
            _ => return Err(RenderOutcome::Recover),
        };
        Ok(FrameTarget {
            view: output.texture.create_view(&Default::default()),
            output: Some(output),
            suboptimal,
        })
    }
}
