//! R4 遮挡消费链(R4 GPU-driven 第二切片)。
//!
//! 消费 [`GpuOcclusionStage`](crate::gpu_occlusion) 的 per-instance 可见标志,
//! 经全定序 scan+compact(见 `native_gpu_occlusion_compact_v1.wgsl`)产出:
//! - `compact_visible`:幸存行按 instance id 升序写入「批次 instance_start +
//!   批次内幸存序」槽位,与 frustum 输出逐槽兼容(144B 行、批次区域);
//! - `compact_indirect`:每批次 `instance_count` 重写为遮挡幸存数。
//!
//! 主视锥 draw 换绑这对缓冲即减少 draw/顶点工作量;阴影视锥(view ≥ 1)
//! 不经过本 stage。确定性:五 kernel 全部按下标升序归约,无原子、无
//! workgroup 共享内存;输出是输入的位级确定函数。

use bytemuck::cast_slice;
use deep_engine_native::culling_contract::{
    GPU_CULLING_INDIRECT_BYTES, GPU_CULLING_INSTANCE_BYTES, GPU_CULLING_WORKGROUP_SIZE,
};
use std::sync::mpsc;
use wgpu::util::DeviceExt;

const COMPACT_PARAMS_BYTES: u64 = 16;
/// 消费链诊断读数:紧凑后每批次 instance_count 与幸存行内容。
#[derive(Clone, Debug, PartialEq)]
pub struct ConsumeCompacted {
    pub per_batch: Vec<u32>,
    pub rows: Vec<[f32; (GPU_CULLING_INSTANCE_BYTES / 4) as usize]>,
}

impl ConsumeCompacted {
    #[allow(dead_code)] // Diagnostics consumed by the bin-side GPU evidence tests.
    pub fn total(&self) -> u32 {
        self.per_batch.iter().sum()
    }

    #[allow(dead_code)] // Diagnostics consumed by the bin-side GPU evidence tests.
    pub fn draws(&self) -> u32 {
        self.per_batch.iter().filter(|count| **count > 0).count() as u32
    }
}

/// 消费链 readback 档位:`Off` 不读回;`Counts` 仅每批次 compact 计数
/// (20B/批,生产门控路径:空批次 draw 跳过 + 查准/查全校准钩子);
/// `CountsAndRows` 计数 + 幸存行(测试/诊断:位级对照,行区随实例数放大)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // Off/CountsAndRows are constructed at the bin-side evidence tests.
pub enum ConsumeReadbackMode {
    Off,
    Counts,
    CountsAndRows,
}
pub struct OcclusionConsumeStage {
    /// 与 CONSUME_ENTRY_POINTS 一一对应:(pipeline, entry 专属 bind group)。
    stages: Vec<(wgpu::ComputePipeline, wgpu::BindGroup)>,
    instance_count: u32,
    block_count: u32,
    batch_count: u32,
    _block_sums: wgpu::Buffer,
    _block_offsets: wgpu::Buffer,
    _instance_prefix: wgpu::Buffer,
    pub(crate) compact_visible: wgpu::Buffer,
    pub(crate) compact_indirect: wgpu::Buffer,
    indirect_template: Vec<u8>,
    readback: Option<ConsumeReadback>,
}

impl OcclusionConsumeStage {
    /// `flags` 来自遮挡判定 stage;`batch_ranges` 由 CPU 侧从
    /// prepared metadata 提取(culling_contract::batch_ranges_from_metadata),
    /// 场景重建时随 GpuCulling 一起重建,构造后不变。
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        device: &wgpu::Device,
        source_instances: &wgpu::Buffer,
        metadata: &wgpu::Buffer,
        flags: &wgpu::Buffer,
        batch_ranges: &[[u32; 4]],
        candidate_count: u32,
        batch_count: u32,
        indirect_template: &[u8],
        readback_mode: ConsumeReadbackMode,
    ) -> Result<Self, String> {
        if batch_ranges.len() != batch_count as usize {
            return Err(format!(
                "native GPU occlusion consume batch range count {} != batch count {batch_count}",
                batch_ranges.len()
            ));
        }
        if indirect_template.len() != batch_count as usize * GPU_CULLING_INDIRECT_BYTES as usize {
            return Err("native GPU occlusion consume indirect template size mismatch".into());
        }
        let instance_count = candidate_count;
        let block_count = instance_count.div_ceil(GPU_CULLING_WORKGROUP_SIZE).max(1);
        let prefix_count = u64::from(instance_count) + 1;
        let capacity = u64::from(instance_count.max(1));
        let entries = |bytes: u64| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Deep Engine native GPU occlusion consume scratch"),
                size: bytes,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            })
        };
        let block_sums = entries(u64::from(block_count) * 4);
        let block_offsets = entries(u64::from(block_count) * 4);
        let instance_prefix = entries(prefix_count * 4);
        let compact_visible = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Deep Engine native GPU occlusion compact visible"),
            size: capacity * GPU_CULLING_INSTANCE_BYTES,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::VERTEX
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let compact_indirect = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Deep Engine native GPU occlusion compact indirect"),
            size: u64::from(batch_count.max(1)) * GPU_CULLING_INDIRECT_BYTES,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::INDIRECT
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let ranges = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native GPU occlusion batch ranges"),
            contents: cast_slice(batch_ranges),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native GPU occlusion consume params"),
            contents: cast_slice(&[instance_count, block_count, batch_count, 0u32]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        // 每 entry point 一个 BGL + bind group:静态使用的缓冲子集各自不同,
        // 单一 BGL 会超出 max_storage_buffers_per_shader_stage(默认 8)。
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Deep Engine native GPU occlusion compaction shader v1"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../assets/shaders/native_gpu_occlusion_compact_v1.wgsl").into(),
            ),
        });
        let buffers: [&wgpu::Buffer; 9] = [
            flags,
            &block_sums,
            &block_offsets,
            &instance_prefix,
            source_instances,
            metadata,
            &compact_visible,
            &ranges,
            &compact_indirect,
        ];
        // (entry point, 静态使用的 binding 号, 其中 read-only 的号)。
        // 注意:read/write 资格按 WGSL 声明匹配而非实际用法——声明为
        // read_write 的缓冲(binding 1/2/3/6/8)在任何 BGL 中都是 read_write。
        let plans: [(&str, &[u32], &[u32]); 5] = [
            ("scan_blocks", &[0, 1, 9], &[0]),
            ("scan_block_offsets", &[1, 2, 9], &[]),
            ("scan_instance_prefix", &[0, 2, 3, 9], &[0]),
            ("compact_instances", &[0, 3, 4, 5, 6, 9], &[0, 4, 5]),
            ("write_indirect", &[3, 7, 8, 9], &[7]),
        ];
        let mut stages = Vec::with_capacity(plans.len());
        for (entry_point, bindings, read_only) in plans {
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some(entry_point),
                entries: &bindings
                    .iter()
                    .map(|&binding| {
                        if binding == 9 {
                            wgpu::BindGroupLayoutEntry {
                                binding,
                                visibility: wgpu::ShaderStages::COMPUTE,
                                ty: wgpu::BindingType::Buffer {
                                    ty: wgpu::BufferBindingType::Uniform,
                                    has_dynamic_offset: false,
                                    min_binding_size: wgpu::BufferSize::new(COMPACT_PARAMS_BYTES),
                                },
                                count: None,
                            }
                        } else {
                            wgpu::BindGroupLayoutEntry {
                                binding,
                                visibility: wgpu::ShaderStages::COMPUTE,
                                ty: wgpu::BindingType::Buffer {
                                    ty: wgpu::BufferBindingType::Storage {
                                        read_only: read_only.contains(&binding),
                                    },
                                    has_dynamic_offset: false,
                                    min_binding_size: None,
                                },
                                count: None,
                            }
                        }
                    })
                    .collect::<Vec<_>>(),
            });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(entry_point),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            });
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry_point),
                layout: Some(&pipeline_layout),
                module: &shader,
                entry_point: Some(entry_point),
                compilation_options: Default::default(),
                cache: None,
            });
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(entry_point),
                layout: &layout,
                entries: &bindings
                    .iter()
                    .map(|&binding| {
                        if binding == 9 {
                            buffer_entry(binding, &params)
                        } else {
                            buffer_entry(binding, buffers[binding as usize])
                        }
                    })
                    .collect::<Vec<_>>(),
            });
            stages.push((pipeline, bind_group));
        }
        Ok(Self {
            stages,
            instance_count,
            block_count,
            batch_count,
            _block_sums: block_sums,
            _block_offsets: block_offsets,
            _instance_prefix: instance_prefix,
            compact_visible,
            compact_indirect,
            indirect_template: indirect_template.to_vec(),
            readback: ConsumeReadback::new(device, instance_count, batch_count, readback_mode),
        })
    }

    pub fn summary(&self) -> (u32, u32, u32) {
        (self.instance_count, self.block_count, self.batch_count)
    }

    /// 模板重写 instance_count 之外的 4 字段后,五 kernel 依次派发;
    /// 每个 kernel 独立 compute pass,依赖经 pass 边界屏障定序。
    pub fn encode(&self, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder) {
        if self.instance_count == 0 {
            return;
        }
        queue.write_buffer(&self.compact_indirect, 0, &self.indirect_template);
        let dispatches = [
            self.block_count.div_ceil(GPU_CULLING_WORKGROUP_SIZE),
            1,
            self.instance_count.div_ceil(GPU_CULLING_WORKGROUP_SIZE),
            self.instance_count.div_ceil(GPU_CULLING_WORKGROUP_SIZE),
            self.batch_count.div_ceil(GPU_CULLING_WORKGROUP_SIZE),
        ];
        for ((pipeline, bind_group), workgroups) in self.stages.iter().zip(dispatches) {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Deep Engine native GPU occlusion compaction"),
                ..Default::default()
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.dispatch_workgroups(workgroups.max(1), 1, 1);
        }
    }

    pub fn encode_readback(&self, encoder: &mut wgpu::CommandEncoder) {
        if let Some(readback) = &self.readback {
            readback.encode_copy(encoder, &self.compact_indirect, &self.compact_visible);
        }
    }

    pub fn commit_submission(&mut self) {
        if let Some(readback) = &mut self.readback {
            readback.commit();
        }
    }

    pub fn take_compacted(
        &mut self,
        device: &wgpu::Device,
    ) -> Result<Option<ConsumeCompacted>, String> {
        match &mut self.readback {
            Some(readback) => readback.take(device),
            None => Ok(None),
        }
    }
}

fn buffer_entry(binding: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: buffer.as_entire_binding(),
    }
}

/// 紧凑输出 readback:indirect 计数 + 可选幸存行内容。`Counts` 档只拷
/// 每批次 20B 计数(生产门控的轻量观测),`CountsAndRows` 另拷幸存行区
/// 供位级对照(诊断路径)。
struct ConsumeReadback {
    counts: wgpu::Buffer,
    counts_bytes: usize,
    rows: wgpu::Buffer,
    rows_bytes: usize,
    pending: bool,
}

impl ConsumeReadback {
    fn new(
        device: &wgpu::Device,
        instance_count: u32,
        batch_count: u32,
        mode: ConsumeReadbackMode,
    ) -> Option<Self> {
        let with_rows = match mode {
            ConsumeReadbackMode::Off => return None,
            ConsumeReadbackMode::Counts => false,
            ConsumeReadbackMode::CountsAndRows => true,
        };
        let counts_bytes = (batch_count as usize * GPU_CULLING_INDIRECT_BYTES as usize).max(4);
        let rows_bytes = if with_rows {
            instance_count as usize * GPU_CULLING_INSTANCE_BYTES as usize
        } else {
            0
        };
        let staging = |label: &'static str, size: usize| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: size.max(4) as u64,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        };
        Some(Self {
            counts: staging(
                "Deep Engine native GPU occlusion compact counts readback",
                counts_bytes,
            ),
            counts_bytes,
            rows: staging(
                "Deep Engine native GPU occlusion compact rows readback",
                rows_bytes,
            ),
            rows_bytes,
            pending: false,
        })
    }

    fn encode_copy(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        indirect: &wgpu::Buffer,
        visible: &wgpu::Buffer,
    ) {
        encoder.copy_buffer_to_buffer(indirect, 0, &self.counts, 0, self.counts_bytes as u64);
        if self.rows_bytes > 0 {
            encoder.copy_buffer_to_buffer(visible, 0, &self.rows, 0, self.rows_bytes as u64);
        }
    }

    fn commit(&mut self) {
        self.pending = true;
    }

    fn take(&mut self, device: &wgpu::Device) -> Result<Option<ConsumeCompacted>, String> {
        if !self.pending {
            return Ok(None);
        }
        self.pending = false;
        let counts = map_slice(&self.counts, device, "compact counts")?;
        let rows = if self.rows_bytes > 0 {
            map_slice(&self.rows, device, "compact rows")?
        } else {
            Vec::new()
        };
        let mut per_batch =
            Vec::with_capacity(self.counts_bytes / GPU_CULLING_INDIRECT_BYTES as usize);
        for chunk in counts.chunks_exact(GPU_CULLING_INDIRECT_BYTES as usize) {
            per_batch.push(u32::from_le_bytes(chunk[4..8].try_into().unwrap()));
        }
        let rows = rows
            .chunks_exact(GPU_CULLING_INSTANCE_BYTES as usize)
            .map(|row| {
                std::array::from_fn(|axis| {
                    f32::from_le_bytes(row[axis * 4..axis * 4 + 4].try_into().unwrap())
                })
            })
            .collect();
        Ok(Some(ConsumeCompacted { per_batch, rows }))
    }
}

fn map_slice(buffer: &wgpu::Buffer, device: &wgpu::Device, label: &str) -> Result<Vec<u8>, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|error| format!("GPU occlusion consume {label} device poll failed: {error}"))?;
    receiver
        .recv()
        .map_err(|error| format!("GPU occlusion consume {label} callback failed: {error}"))?
        .map_err(|error| format!("GPU occlusion consume {label} map failed: {error}"))?;
    let mapped = buffer
        .get_mapped_range(..)
        .map_err(|error| format!("GPU occlusion consume {label} mapped range failed: {error}"))?;
    let bytes = mapped.to_vec();
    drop(mapped);
    buffer.unmap();
    Ok(bytes)
}
