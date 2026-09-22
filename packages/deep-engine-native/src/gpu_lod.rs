use bytemuck::cast_slice;
use deep_engine_native::{
    lod_contract::{LodDraw, PreparedGpuLod},
    mesh_abi::FrameUniform,
};
use winit::dpi::PhysicalSize;

use crate::{
    gpu_lod_resources::{self as resources, LodView},
    gpu_lod_views::pack_views,
    shadow_map::ShadowViewSource,
};

pub struct GpuLod {
    _objects: wgpu::Buffer,
    _levels: wgpu::Buffer,
    pipeline: wgpu::ComputePipeline,
    views: Vec<LodView>,
    batches: Vec<Vec<LodDraw>>,
    indirect_template: Vec<u8>,
    count: u32,
    dirty: bool,
}

impl GpuLod {
    pub fn new(
        device: &wgpu::Device,
        source: &wgpu::Buffer,
        prepared: &PreparedGpuLod,
        frame: &FrameUniform,
        size: PhysicalSize<u32>,
        shadows: &impl ShadowViewSource,
        near: f32,
    ) -> Result<Option<Self>, String> {
        if prepared.objects.is_empty() {
            return Ok(None);
        }
        resources::validate_device(device, prepared)?;
        let params = pack_views(frame, size, shadows, prepared.objects.len() as u32, near)?;
        let objects = resources::init(
            device,
            "native LOD objects",
            cast_slice(&prepared.objects),
            wgpu::BufferUsages::STORAGE,
        );
        let levels = resources::init(
            device,
            "native LOD levels",
            cast_slice(&prepared.levels),
            wgpu::BufferUsages::STORAGE,
        );
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Deep Engine native GPU LOD shader v1"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../assets/shaders/native_gpu_lod_v1.wgsl").into(),
            ),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Deep Engine native GPU LOD v1"),
            layout: None,
            module: &shader,
            entry_point: Some("select_lod"),
            compilation_options: Default::default(),
            cache: None,
        });
        let layout = pipeline.get_bind_group_layout(0);
        let views = params
            .iter()
            .map(|bytes| {
                resources::create_view(
                    device,
                    &layout,
                    [source, &objects, &levels],
                    prepared,
                    bytes,
                )
            })
            .collect();
        println!(
            "native GPU LOD v1: objects={} draws={} views={} visible_slots={}",
            prepared.objects.len(),
            prepared.indirect_template.len(),
            params.len(),
            prepared.visible_capacity
        );
        Ok(Some(Self {
            _objects: objects,
            _levels: levels,
            pipeline,
            views,
            batches: prepared.batches.clone(),
            indirect_template: cast_slice(&prepared.indirect_template).to_vec(),
            count: prepared.objects.len() as u32,
            dirty: true,
        }))
    }

    pub fn update_views(
        &mut self,
        queue: &wgpu::Queue,
        frame: &FrameUniform,
        size: PhysicalSize<u32>,
        shadows: &impl ShadowViewSource,
        near: f32,
    ) -> Result<(), String> {
        let packed = pack_views(frame, size, shadows, self.count, near)?;
        if packed.len() != self.views.len() {
            return Err("native GPU LOD view count changed after allocation".into());
        }
        for (view, bytes) in self.views.iter().zip(&packed) {
            queue.write_buffer(&view.uniform, 0, bytes);
        }
        self.dirty = true;
        Ok(())
    }

    pub fn needs_encode(&self) -> bool {
        self.dirty
    }

    pub fn reset_history(&mut self, queue: &wgpu::Queue) {
        let reset = vec![u32::MAX; self.count as usize];
        for view in &self.views {
            queue.write_buffer(&view._history, 0, cast_slice(&reset));
        }
        self.dirty = true;
    }

    pub fn encode(&self, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder) {
        for view in &self.views {
            queue.write_buffer(&view.indirect, 0, &self.indirect_template);
        }
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("native GPU LOD all views"),
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        for view in &self.views {
            pass.set_bind_group(0, &view.group, &[]);
            pass.dispatch_workgroups(self.count.div_ceil(64), 1, 1);
        }
    }

    pub fn commit_submission(&mut self) {
        self.dirty = false;
    }
    pub fn draws(&self, batch: usize) -> &[LodDraw] {
        &self.batches[batch]
    }
    pub fn visible(&self, view: usize) -> &wgpu::Buffer {
        &self.views[view].visible
    }
    pub fn indirect(&self, view: usize) -> &wgpu::Buffer {
        &self.views[view].indirect
    }
}
