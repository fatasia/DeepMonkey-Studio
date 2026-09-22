use bytemuck::cast_slice;
use deep_engine_native::dashboard_runtime::{DashboardRuntime, DashboardVideoPlayback};
use deep_engine_native::dashboard_runtime::{DashboardVideoAdvance, DashboardVideoCommand};
use std::{collections::BTreeMap, time::Instant};
use wgpu::util::DeviceExt;

use crate::{deep2d_gpu::DashboardVideoSlot, deep2d_scissor::chunk_scissor};

const SHADER: &str = include_str!("../assets/shaders/native_dashboard_video_v1.wgsl");

struct ResidentVideo {
    playback: DashboardVideoPlayback,
    bind_group: wgpu::BindGroup,
    last_serial: u64,
    state: DashboardVideoAdvance,
}

struct DrawSlot {
    video_index: usize,
    layer_index: usize,
    clip: deep_engine_native::deep2d::Deep2dRect,
    vertex_buffer: wgpu::Buffer,
    controls_buffer: wgpu::Buffer,
}

pub(crate) struct DashboardVideoGpuCompositor {
    pipeline: wgpu::RenderPipeline,
    solid_pipeline: wgpu::RenderPipeline,
    frame_buffer: wgpu::Buffer,
    frame_bind_group: wgpu::BindGroup,
    _texture_layout: wgpu::BindGroupLayout,
    _sampler: wgpu::Sampler,
    videos: Vec<ResidentVideo>,
    video_ids: BTreeMap<String, usize>,
    slots: Vec<DrawSlot>,
    source_slots: Vec<DashboardVideoSlot>,
    logical_size: [f32; 2],
    last_physical_size: Option<(u32, u32)>,
    clock_epoch: Instant,
    suspended_at: Option<Instant>,
    uploaded_frames: u64,
}

impl DashboardVideoGpuCompositor {
    pub(crate) fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target_format: wgpu::TextureFormat,
        runtime: &DashboardRuntime,
        slots: &[DashboardVideoSlot],
        logical_size: [f32; 2],
    ) -> Result<Option<Self>, String> {
        let playable = runtime
            .video_diagnostics()
            .iter()
            .filter(|video| video.source.packaged && video.playback.muted)
            .map(|video| video.node_id.clone())
            .collect::<Vec<_>>();
        if playable.is_empty() {
            return Ok(None);
        }
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Dashboard video frame layout v1"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let texture_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Dashboard video texture layout v1"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Dashboard video shader v1"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Dashboard video pipeline layout v1"),
            bind_group_layouts: &[Some(&frame_layout), Some(&texture_layout)],
            immediate_size: 0,
        });
        let attributes = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Dashboard video pipeline v1"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vertex_main"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: 16,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &attributes,
                })],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fragment_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: target_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let solid_attributes = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4];
        let solid_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Dashboard video controls pipeline v1"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("solid_vertex_main"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: 24,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &solid_attributes,
                })],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("solid_fragment_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: target_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Dashboard video frame uniform v1"),
            contents: cast_slice(&[[logical_size[0], logical_size[1], 1.0f32, 1.0f32]]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let frame_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Dashboard video frame bindings v1"),
            layout: &frame_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: frame_buffer.as_entire_binding(),
            }],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Dashboard video sampler v1"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let mut videos = Vec::new();
        let mut video_ids = BTreeMap::new();
        for node_id in playable {
            let playback = runtime.prepare_video_playback(
                &node_id,
                device,
                queue,
                std::time::Duration::ZERO,
            )?;
            let view = playback.texture().create_view(&Default::default());
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Dashboard video texture bindings v1"),
                layout: &texture_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                ],
            });
            let index = videos.len();
            video_ids.insert(node_id, index);
            let state = playback.state();
            videos.push(ResidentVideo {
                last_serial: 1,
                playback,
                bind_group,
                state,
            });
        }
        let mut compositor = Self {
            pipeline,
            solid_pipeline,
            frame_buffer,
            frame_bind_group,
            _texture_layout: texture_layout,
            _sampler: sampler,
            videos,
            video_ids,
            slots: Vec::new(),
            source_slots: Vec::new(),
            logical_size,
            last_physical_size: None,
            clock_epoch: Instant::now(),
            suspended_at: None,
            uploaded_frames: 0,
        };
        compositor.sync_slots(device, slots, logical_size)?;
        Ok(Some(compositor))
    }

    pub(crate) fn sync_slots(
        &mut self,
        device: &wgpu::Device,
        slots: &[DashboardVideoSlot],
        logical_size: [f32; 2],
    ) -> Result<bool, String> {
        if logical_size
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return Err("invalid dashboard video logical size".into());
        }
        if self.logical_size == logical_size && self.source_slots == slots {
            return Ok(false);
        }
        let mut next = Vec::new();
        for slot in slots {
            let Some(&video_index) = self.video_ids.get(&slot.node_id) else {
                continue;
            };
            let placement = self.videos[video_index]
                .playback
                .placement(slot.frame[2], slot.frame[3])?;
            let [dx, dy, dw, dh] = placement.destination;
            let [ux, uy, uw, uh] = placement.uv;
            let x = slot.frame[0] + dx;
            let y = slot.frame[1] + dy;
            let vertices = [
                [x, y, ux, uy],
                [x + dw, y, ux + uw, uy],
                [x + dw, y + dh, ux + uw, uy + uh],
                [x, y, ux, uy],
                [x + dw, y + dh, ux + uw, uy + uh],
                [x, y + dh, ux, uy + uh],
            ];
            let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Dashboard video fitted quad v1"),
                contents: cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
            let controls = control_vertices(slot.frame, self.videos[video_index].state);
            let controls_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Dashboard video controls vertices v1"),
                contents: cast_slice(&controls),
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            });
            next.push(DrawSlot {
                video_index,
                layer_index: slot.layer_index,
                clip: slot.clip,
                vertex_buffer,
                controls_buffer,
            });
        }
        next.sort_by_key(|slot| slot.layer_index);
        self.slots = next;
        self.source_slots = slots.to_vec();
        self.logical_size = logical_size;
        self.last_physical_size = None;
        Ok(true)
    }

    pub(crate) fn advance(&mut self, queue: &wgpu::Queue) -> Result<bool, String> {
        if self.suspended_at.is_some() {
            return Ok(false);
        }
        let elapsed = self.clock_epoch.elapsed();
        let mut updated = false;
        let mut active = vec![false; self.videos.len()];
        for slot in &self.slots {
            active[slot.video_index] = true;
        }
        for (video_index, video) in self.videos.iter_mut().enumerate() {
            if !active[video_index] {
                continue;
            }
            let previous = video.state;
            let result = video.playback.advance_to(queue, elapsed)?;
            video.state = result;
            if result.texture_serial != video.last_serial {
                self.uploaded_frames = self
                    .uploaded_frames
                    .checked_add(1)
                    .ok_or("dashboard video upload counter exhausted")?;
                video.last_serial = result.texture_serial;
                updated = true;
            }
            if result != previous {
                for slot in self
                    .slots
                    .iter()
                    .filter(|slot| slot.video_index == video_index)
                {
                    let frame = self
                        .source_slots
                        .iter()
                        .find(|source| source.layer_index == slot.layer_index)
                        .map(|source| source.frame)
                        .ok_or("dashboard video advance slot missing")?;
                    queue.write_buffer(
                        &slot.controls_buffer,
                        0,
                        cast_slice(&control_vertices(frame, result)),
                    );
                }
            }
        }
        Ok(updated)
    }

    pub(crate) fn control(
        &mut self,
        node_id: &str,
        queue: &wgpu::Queue,
        command: DashboardVideoCommand,
    ) -> Result<DashboardVideoAdvance, String> {
        let index = *self
            .video_ids
            .get(node_id)
            .ok_or("dashboard video compositor node missing")?;
        let video = &mut self.videos[index];
        let result = video
            .playback
            .control(queue, self.clock_epoch.elapsed(), command)?;
        video.state = result;
        if result.texture_serial != video.last_serial {
            self.uploaded_frames = self
                .uploaded_frames
                .checked_add(1)
                .ok_or("dashboard video upload counter exhausted")?;
            video.last_serial = result.texture_serial;
        }
        for slot in self.slots.iter().filter(|slot| slot.video_index == index) {
            let frame = self
                .source_slots
                .iter()
                .find(|source| source.layer_index == slot.layer_index)
                .map(|source| source.frame)
                .ok_or("dashboard video control slot missing")?;
            queue.write_buffer(
                &slot.controls_buffer,
                0,
                cast_slice(&control_vertices(frame, result)),
            );
        }
        Ok(result)
    }

    pub(crate) fn duration_100ns(&self, node_id: &str) -> Option<i64> {
        self.video_ids
            .get(node_id)
            .map(|index| self.videos[*index].state.duration_100ns)
    }

    pub(crate) fn suspend(&mut self, queue: &wgpu::Queue) -> Result<(), String> {
        if self.suspended_at.is_some() {
            return Ok(());
        }
        let now = Instant::now();
        let elapsed = now.duration_since(self.clock_epoch);
        for video in &mut self.videos {
            video.playback.suspend_for_lifecycle(queue, elapsed)?;
        }
        self.suspended_at = Some(now);
        Ok(())
    }

    pub(crate) fn resume(&mut self) -> Result<(), String> {
        let suspended = self
            .suspended_at
            .take()
            .ok_or("dashboard video compositor is not suspended")?;
        let now = Instant::now();
        self.clock_epoch += now.duration_since(suspended);
        let elapsed = now.duration_since(self.clock_epoch);
        for video in &mut self.videos {
            video.playback.resume_from_lifecycle(elapsed)?;
        }
        Ok(())
    }

    pub(crate) fn update_frame_uniform(&mut self, queue: &wgpu::Queue, physical_size: (u32, u32)) {
        if self.last_physical_size == Some(physical_size) {
            return;
        }
        queue.write_buffer(
            &self.frame_buffer,
            0,
            cast_slice(&[[
                self.logical_size[0],
                self.logical_size[1],
                physical_size.0 as f32,
                physical_size.1 as f32,
            ]]),
        );
        self.last_physical_size = Some(physical_size);
    }

    #[cfg(test)]
    pub(crate) fn layer_indices(&self) -> impl Iterator<Item = usize> + '_ {
        self.slots.iter().map(|slot| slot.layer_index)
    }

    pub(crate) fn max_layer_index(&self) -> Option<usize> {
        self.slots.last().map(|slot| slot.layer_index)
    }

    pub(crate) fn draw_layer<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        layer_index: usize,
        physical_size: (u32, u32),
    ) {
        for slot in self
            .slots
            .iter()
            .filter(|slot| slot.layer_index == layer_index)
        {
            let Some(scissor) = chunk_scissor(Some(slot.clip), self.logical_size, physical_size)
            else {
                continue;
            };
            pass.set_scissor_rect(scissor[0], scissor[1], scissor[2], scissor[3]);
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.frame_bind_group, &[]);
            pass.set_bind_group(1, &self.videos[slot.video_index].bind_group, &[]);
            pass.set_vertex_buffer(0, slot.vertex_buffer.slice(..));
            pass.draw(0..6, 0..1);
            pass.set_pipeline(&self.solid_pipeline);
            pass.set_bind_group(0, &self.frame_bind_group, &[]);
            pass.set_vertex_buffer(0, slot.controls_buffer.slice(..));
            pass.draw(0..CONTROL_VERTEX_COUNT as u32, 0..1);
        }
    }

    #[cfg(test)]
    pub(crate) fn uploaded_frames(&self) -> u64 {
        self.uploaded_frames
    }

    pub(crate) fn has_autoplay(&self) -> bool {
        self.slots
            .iter()
            .any(|slot| self.videos[slot.video_index].playback.is_playing())
    }
}

const CONTROL_VERTEX_COUNT: usize = 42;

fn control_vertices(
    frame: [f32; 4],
    state: DashboardVideoAdvance,
) -> [[f32; 6]; CONTROL_VERTEX_COUNT] {
    let [x, y, width, height] = frame;
    let bar_height = height.min(38.0);
    let bar_y = y + height - bar_height;
    let progress_x = x + 48.0;
    let progress_width = (width - 62.0).max(1.0);
    let ratio = if state.duration_100ns > 0 {
        (state.position_100ns as f32 / state.duration_100ns as f32).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let thumb_x = progress_x + progress_width * ratio;
    let mut out = [[0.0; 6]; CONTROL_VERTEX_COUNT];
    let mut cursor = 0;
    rect(
        &mut out,
        &mut cursor,
        [x, bar_y, width, bar_height],
        [0.02, 0.04, 0.05, 0.82],
    );
    rect(
        &mut out,
        &mut cursor,
        [x + 8.0, bar_y + 7.0, 26.0, 24.0],
        [0.12, 0.17, 0.18, 0.96],
    );
    if state.playing {
        rect(
            &mut out,
            &mut cursor,
            [x + 16.0, bar_y + 13.0, 3.0, 12.0],
            [0.91, 0.96, 0.95, 1.0],
        );
        rect(
            &mut out,
            &mut cursor,
            [x + 23.0, bar_y + 13.0, 3.0, 12.0],
            [0.91, 0.96, 0.95, 1.0],
        );
    } else {
        triangle(
            &mut out,
            &mut cursor,
            [
                [x + 17.0, bar_y + 12.0],
                [x + 17.0, bar_y + 26.0],
                [x + 27.0, bar_y + 19.0],
            ],
            [0.91, 0.96, 0.95, 1.0],
        );
        triangle(
            &mut out,
            &mut cursor,
            [[x + 17.0, bar_y + 12.0]; 3],
            [0.91, 0.96, 0.95, 1.0],
        );
        triangle(
            &mut out,
            &mut cursor,
            [[x + 17.0, bar_y + 12.0]; 3],
            [0.91, 0.96, 0.95, 1.0],
        );
        triangle(
            &mut out,
            &mut cursor,
            [[x + 17.0, bar_y + 12.0]; 3],
            [0.91, 0.96, 0.95, 1.0],
        );
    }
    rect(
        &mut out,
        &mut cursor,
        [progress_x, bar_y + 17.0, progress_width, 4.0],
        [0.36, 0.43, 0.44, 1.0],
    );
    rect(
        &mut out,
        &mut cursor,
        [progress_x, bar_y + 17.0, progress_width * ratio, 4.0],
        [0.30, 0.76, 0.68, 1.0],
    );
    rect(
        &mut out,
        &mut cursor,
        [thumb_x - 3.0, bar_y + 13.0, 6.0, 12.0],
        [0.76, 0.94, 0.89, 1.0],
    );
    out
}

fn rect(
    out: &mut [[f32; 6]; CONTROL_VERTEX_COUNT],
    cursor: &mut usize,
    r: [f32; 4],
    color: [f32; 4],
) {
    let [x, y, w, h] = r;
    let points = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y],
        [x + w, y + h],
        [x, y + h],
    ];
    for point in points {
        out[*cursor] = [point[0], point[1], color[0], color[1], color[2], color[3]];
        *cursor += 1;
    }
}

fn triangle(
    out: &mut [[f32; 6]; CONTROL_VERTEX_COUNT],
    cursor: &mut usize,
    points: [[f32; 2]; 3],
    color: [f32; 4],
) {
    for point in points {
        out[*cursor] = [point[0], point[1], color[0], color[1], color[2], color[3]];
        *cursor += 1;
    }
}

#[cfg(all(test, windows))]
#[path = "dashboard_video_gpu_tests.rs"]
mod tests;
