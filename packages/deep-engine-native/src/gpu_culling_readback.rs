use std::sync::mpsc;

use deep_engine_native::culling_contract::GPU_CULLING_INDIRECT_BYTES;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GpuCullingViewMetrics {
    pub visible_instances: u32,
    pub indirect_draws: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GpuCullingFrameMetrics {
    pub main: GpuCullingViewMetrics,
    pub cascades: Vec<GpuCullingViewMetrics>,
}

impl GpuCullingFrameMetrics {
    pub fn report(&self) {
        let visible = self
            .cascades
            .iter()
            .map(|metrics| metrics.visible_instances)
            .collect::<Vec<_>>();
        let draws = self
            .cascades
            .iter()
            .map(|metrics| metrics.indirect_draws)
            .collect::<Vec<_>>();
        println!(
            "native GPU culling: main_visible={} main_draws={} cascade_visible={visible:?} cascade_draws={draws:?}",
            self.main.visible_instances, self.main.indirect_draws
        );
    }
}

pub struct CullingReadback {
    buffer: wgpu::Buffer,
    view_stride: u64,
    view_count: usize,
    batch_count: usize,
    pending: bool,
}

impl CullingReadback {
    pub fn new(device: &wgpu::Device, view_count: usize, batch_count: usize) -> Self {
        let view_stride = (batch_count as u64 * GPU_CULLING_INDIRECT_BYTES).max(4);
        Self {
            buffer: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Deep Engine native GPU culling indirect readback"),
                size: view_stride * view_count as u64,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            }),
            view_stride,
            view_count,
            batch_count,
            pending: false,
        }
    }

    pub fn encode_copy(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        view_index: usize,
        indirect: &wgpu::Buffer,
    ) {
        if self.batch_count == 0 {
            return;
        }
        encoder.copy_buffer_to_buffer(
            indirect,
            0,
            &self.buffer,
            view_index as u64 * self.view_stride,
            self.batch_count as u64 * GPU_CULLING_INDIRECT_BYTES,
        );
    }

    pub fn commit(&mut self) {
        self.pending = true;
    }

    pub fn take(
        &mut self,
        device: &wgpu::Device,
    ) -> Result<Option<GpuCullingFrameMetrics>, String> {
        if !self.pending {
            return Ok(None);
        }
        self.pending = false;
        let (sender, receiver) = mpsc::sync_channel(1);
        self.buffer
            .map_async(wgpu::MapMode::Read, .., move |result| {
                let _ = sender.send(result);
            });
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("GPU culling readback device poll failed: {error}"))?;
        receiver
            .recv()
            .map_err(|error| format!("GPU culling readback callback failed: {error}"))?
            .map_err(|error| format!("GPU culling readback map failed: {error}"))?;
        let mapped = self
            .buffer
            .get_mapped_range(..)
            .map_err(|error| format!("GPU culling mapped range failed: {error}"))?;
        let mut views = Vec::with_capacity(self.view_count);
        for view_index in 0..self.view_count {
            let base = view_index * self.view_stride as usize;
            let mut visible_instances = 0;
            let mut indirect_draws = 0;
            for batch in 0..self.batch_count {
                let offset = base + batch * GPU_CULLING_INDIRECT_BYTES as usize + 4;
                let count = u32::from_le_bytes(mapped[offset..offset + 4].try_into().unwrap());
                visible_instances += count;
                indirect_draws += u32::from(count > 0);
            }
            views.push(GpuCullingViewMetrics {
                visible_instances,
                indirect_draws,
            });
        }
        drop(mapped);
        self.buffer.unmap();
        let main = views.remove(0);
        Ok(Some(GpuCullingFrameMetrics {
            main,
            cascades: views,
        }))
    }
}
