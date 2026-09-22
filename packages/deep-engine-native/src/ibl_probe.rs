use deep_engine_native::ibl::disabled_probe_environment;
use winit::dpi::PhysicalSize;

use crate::{gpu_ibl::GpuIblEnvironment, hdr_readback::HdrReadbackPair, shadow_map::ShadowMap};

#[derive(Clone, Copy, Debug)]
pub struct IblProbeMetrics {
    pub changed_pixels: usize,
    pub enabled_luminance: f64,
    pub disabled_luminance: f64,
}

pub struct IblProbe {
    _disabled_environment: GpuIblEnvironment,
    disabled_frame_bind_group: wgpu::BindGroup,
    readback: HdrReadbackPair,
}

impl IblProbe {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        frame_layout: &wgpu::BindGroupLayout,
        shadow_map: &ShadowMap,
        frame_buffer: &wgpu::Buffer,
        ies_buffer: &wgpu::Buffer,
        probe_frame_buffer: &wgpu::Buffer,
        size: PhysicalSize<u32>,
    ) -> Result<Self, String> {
        let disabled_environment =
            GpuIblEnvironment::new(device, queue, &disabled_probe_environment())?;
        let disabled_frame_bind_group = disabled_environment.create_frame_bind_group(
            device,
            frame_layout,
            frame_buffer,
            Some(ies_buffer),
            shadow_map,
            Some(probe_frame_buffer),
            "Deep Engine native IBL-off frame bindings",
            true,
        );
        Ok(Self {
            _disabled_environment: disabled_environment,
            disabled_frame_bind_group,
            readback: HdrReadbackPair::new(device, size, "IBL on/off"),
        })
    }

    pub fn disabled_frame_bind_group(&self) -> &wgpu::BindGroup {
        &self.disabled_frame_bind_group
    }

    pub fn copy_enabled(&self, encoder: &mut wgpu::CommandEncoder, texture: &wgpu::Texture) {
        self.readback.copy_first(encoder, texture);
    }

    pub fn copy_disabled(&self, encoder: &mut wgpu::CommandEncoder, texture: &wgpu::Texture) {
        self.readback.copy_second(encoder, texture);
    }

    pub fn finish(&self, device: &wgpu::Device) -> Result<IblProbeMetrics, String> {
        let difference = self.readback.finish(device, "IBL on/off")?;
        if difference.changed_pixels < 4 {
            return Err(format!(
                "IBL probe found only {} changed HDR pixels between IBL on/off",
                difference.changed_pixels
            ));
        }
        if difference.first_luminance - difference.second_luminance <= 0.01 {
            return Err(format!(
                "IBL probe brightness moved in the wrong direction: on={:.6} off={:.6}",
                difference.first_luminance, difference.second_luminance
            ));
        }
        Ok(IblProbeMetrics {
            changed_pixels: difference.changed_pixels,
            enabled_luminance: difference.first_luminance,
            disabled_luminance: difference.second_luminance,
        })
    }
}
