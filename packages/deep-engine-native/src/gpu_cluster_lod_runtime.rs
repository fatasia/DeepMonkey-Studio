//! Cluster LOD 渲染器接线运行时(批 C;六引擎对标 P1 收官件)。
//!
//! 消费链:`.dgc` → [`ClusterLodDagRuntime`](crate::gpu_cluster_lod_dag) 三面产物
//! (既有:节点表/计划面/拼接几何)→ 本模块 GPU 驻留 buffer 族 → 选层 compute dispatch
//! ([`ClusterLodSelectionPipeline`],批 B)→ faults 零门 → 计划
//! ([`plan_cluster_lod_indirect`],批 B)→ draw-indexed-indirect 命令字写入 →
//! 渲染 pass 消费([`ClusterLodGpuRuntime::encode_draws`])。
//!
//! == 合同 ==
//! 1. GPU 驻留:节点表 64B stride 直入 compute storage;拼接顶点/索引表按层升序
//!    (`baseVertex`/`firstIndex` 基址与计划 `level_spans` 逐值一致);创建前驻留预检
//!    (预算/层覆盖/逐节点三角形域/拼接表规模)fail-closed。
//! 2. 相机 uniform 48B:[`pack_cluster_lod_camera_uniform`](TS `packClusterLodCamera`
//!    同构:camPos xyz / tanHalfFovY / forward xyz / pixelThreshold / viewportHeightPixels /
//!    nodeCount / pad×2)。
//! 3. 帧循环:与 bin 侧 `GpuLod` 同形——`needs_encode` → `encode`(dispatch+staging 拷贝)
//!    → `commit_selection`(readback→计划→命令字写入 indirect buffer)。相机变更即置脏。
//! 4. fail-closed:`selectionFaults` 非零 = 整批拒绝——清空计划、命令字清零(全部 no-op 槽),
//!    返回 Err,绝不静默降级;驻留预检任一违规拒绝创建 GPU 资源。
//! 5. 空 cluster(triangleCount=0)按计划合同保留 indexCount=0 的 no-op 绘制槽位。

use crate::gpu_cluster_lod_dag::{ClusterLodDagRuntime, CLUSTER_LOD_MAX_NODES};
use crate::gpu_cluster_lod_gpu::ClusterLodSelectionPipeline;
use crate::gpu_cluster_lod_indirect::{
    plan_cluster_lod_indirect, ClusterLodIndirectPlan, ClusterLodLevelSpan,
    CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES,
};
use crate::gpu_cluster_lod_selection::{
    validate_camera, ClusterLodCamera, CLUSTER_LOD_CAMERA_UNIFORM_BYTES,
};

/// TS `packClusterLodCamera` 同构:相机 + 节点数 → 48B uniform 字节
/// (fail-closed:相机校验不过或节点数超预算返回 Err)。
pub fn pack_cluster_lod_camera_uniform(
    camera: &ClusterLodCamera,
    node_count: usize,
) -> Result<[u8; CLUSTER_LOD_CAMERA_UNIFORM_BYTES], String> {
    validate_camera(camera).map_err(|error| error.to_string())?;
    if node_count > CLUSTER_LOD_MAX_NODES {
        return Err(format!(
            "Cluster LOD camera nodeCount must be within maxBatchRays ({CLUSTER_LOD_MAX_NODES})."
        ));
    }
    let mut uniform = [0u8; CLUSTER_LOD_CAMERA_UNIFORM_BYTES];
    for (word, value) in [
        camera.position[0],
        camera.position[1],
        camera.position[2],
        camera.tan_half_fov_y,
        camera.forward[0],
        camera.forward[1],
        camera.forward[2],
        camera.pixel_threshold,
        camera.viewport_height_pixels,
        node_count as f64,
    ]
    .into_iter()
    .enumerate()
    {
        uniform[word * 4..word * 4 + 4]
            .copy_from_slice(&(value as f32).to_bits().to_le_bytes());
    }
    Ok(uniform)
}

/// 计划 → draw-indexed-indirect 命令字节流(5×u32 小端逐槽;运行时写入与测试对拍共用)。
pub fn cluster_lod_command_bytes(plan: &ClusterLodIndirectPlan) -> Vec<u8> {
    let mut bytes =
        Vec::with_capacity(plan.draws.len() * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES);
    for draw in &plan.draws {
        for word in draw.indirect_command {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
    }
    bytes
}

/// 驻留预检(GPU 资源创建前的运行时下限;DAG 合同签核已在 `ClusterLodDagRuntime`
/// 构建期完成,此处只拦「三面产物互相矛盾」):预算/层覆盖/逐节点三角形域落层/
/// 拼接表规模 = 逐层摘要和。fail-closed,任何违规拒绝创建 GPU 资源。
pub fn validate_cluster_lod_residency(dag: &ClusterLodDagRuntime) -> Result<(), String> {
    if dag.nodes.is_empty() {
        return Err("Cluster LOD residency requires at least one node.".into());
    }
    if dag.nodes.len() > CLUSTER_LOD_MAX_NODES {
        return Err(format!(
            "Cluster LOD node table exceeds maxBatchRays budget ({CLUSTER_LOD_MAX_NODES})."
        ));
    }
    if dag.node_storage.len() != dag.nodes.len() * 64 {
        return Err(format!(
            "Cluster LOD node storage must be {} bytes, got {}.",
            dag.nodes.len() * 64,
            dag.node_storage.len()
        ));
    }
    if dag.plan_nodes.len() != dag.nodes.len() {
        return Err("Cluster LOD plan face must mirror the node table.".into());
    }
    if dag.level_summaries.is_empty() {
        return Err("Cluster LOD residency requires at least one level geometry.".into());
    }
    if dag.nodes.iter().any(|node| node.level as usize >= dag.level_summaries.len()) {
        return Err("Cluster LOD node level exceeds residency levels.".into());
    }
    let mut index_total = 0usize;
    let mut vertex_total = 0usize;
    for (level, summary) in dag.level_summaries.iter().enumerate() {
        if summary.index_count % 3 != 0 {
            return Err(format!("Cluster LOD level {level} index table must be triangle triples."));
        }
        if summary.index_count > dag.index_buffer.len() - index_total
            || summary.vertex_count * 3 > dag.vertex_buffer.len() - vertex_total * 3
        {
            return Err(format!("Cluster LOD level {level} summary exceeds stitched tables."));
        }
        index_total += summary.index_count;
        vertex_total += summary.vertex_count;
    }
    if index_total != dag.index_buffer.len() {
        return Err(format!(
            "Cluster LOD stitched index table is {} bytes, summaries declare {index_total}.",
            dag.index_buffer.len()
        ));
    }
    if vertex_total * 3 != dag.vertex_buffer.len() {
        return Err(format!(
            "Cluster LOD stitched vertex table is {} floats, summaries declare {}.",
            dag.vertex_buffer.len(),
            vertex_total * 3
        ));
    }
    for node in &dag.nodes {
        let index_count = dag.level_summaries[node.level as usize].index_count;
        let first_index = node.first_triangle as usize * 3;
        let end_index = first_index + node.triangle_count as usize * 3;
        if end_index > index_count {
            return Err(format!(
                "Cluster LOD node {} triangle range [{first_index}, {end_index}) exceeds level {} index table ({index_count}).",
                node.id, node.level
            ));
        }
    }
    Ok(())
}

/// Cluster LOD GPU 运行时:驻留 buffer 族 + 选层 dispatch + indirect 命令字 + 渲染消费面。
///
/// 帧循环用法(bin 侧 `GpuLod` 同形;`GpuLod::attach_cluster_lod` 后由帧循环自动驱动):
/// 1. 相机变更(或每帧)调 [`update_camera`](Self::update_camera) 置脏;
/// 2. `needs_encode()` 为真时 `encode`(dispatch + staging 拷贝)并入提交;
/// 3. 提交后 `commit_selection`(readback → faults 零门 → 计划 → 命令字写入);
/// 4. 渲染 pass 内 `encode_draws`(绑定驻留顶点/索引并逐槽 `draw_indexed_indirect`)。
pub struct ClusterLodGpuRuntime {
    // 驻留 CPU 镜像(计划重建与对拍共用;与 ClusterLodDagRuntime 三面同源)。
    plan_nodes: Vec<crate::gpu_cluster_lod_indirect::ClusterLodPlanNode>,
    summaries: Vec<crate::gpu_cluster_lod_indirect::ClusterLodLevelGeometrySummary>,
    node_count: u32,
    // GPU 驻留 buffer 族。
    node_buffer: wgpu::Buffer,
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    selection_buffer: wgpu::Buffer,
    selection_staging: wgpu::Buffer,
    faults_buffer: wgpu::Buffer,
    faults_staging: wgpu::Buffer,
    camera_uniform: wgpu::Buffer,
    indirect_buffer: wgpu::Buffer,
    // 管线与绑定。
    selection_pipeline: ClusterLodSelectionPipeline,
    bind_group: wgpu::BindGroup,
    // 帧状态(AtomicBool:GpuLod 经 render_graph 跨线程,需 Sync;单线程帧语义,
    // Relaxed 即可):dirty = 相机变更待 dispatch;pending = 已提交待 readback。
    dirty: std::sync::atomic::AtomicBool,
    pending: std::sync::atomic::AtomicBool,
    /// 最近一次成功提交的计划(faults 非零或未提交时为 None)。
    plan: Option<ClusterLodIndirectPlan>,
}

impl ClusterLodGpuRuntime {
    /// 三面产物 → 驻留 buffer 族 + 选层管线(fail-closed:预检或设备限制不过即 Err)。
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        dag: &ClusterLodDagRuntime,
    ) -> Result<Self, String> {
        validate_cluster_lod_residency(dag)?;
        Self::validate_device(device, dag)?;
        let node_count = dag.nodes.len() as u32;
        let selection_bytes = 4 * dag.nodes.len() as u64;
        let indirect_bytes =
            dag.nodes.len() as u64 * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES as u64;

        let node_buffer = init_buffer(
            device,
            "cluster LOD resident nodes",
            &dag.node_storage,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        )?;
        let vertex_buffer = init_buffer(
            device,
            "cluster LOD stitched level vertices",
            bytemuck::cast_slice(&dag.vertex_buffer),
            wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        )?;
        let index_buffer = init_buffer(
            device,
            "cluster LOD stitched level indices",
            bytemuck::cast_slice(&dag.index_buffer),
            wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
        )?;
        let selection_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cluster LOD selection"),
            size: selection_bytes,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let selection_staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cluster LOD selection readback"),
            size: selection_bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let faults_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cluster LOD selection faults"),
            size: 4,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let faults_staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cluster LOD faults readback"),
            size: 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let camera_uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cluster LOD camera uniform"),
            size: CLUSTER_LOD_CAMERA_UNIFORM_BYTES as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let indirect_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cluster LOD indexed indirect commands"),
            size: indirect_bytes,
            usage: wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let selection_pipeline = ClusterLodSelectionPipeline::new(device);
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("cluster LOD selection bindings"),
            layout: &selection_pipeline.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: node_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: selection_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: faults_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: camera_uniform.as_entire_binding(),
                },
            ],
        });

        let runtime = Self {
            plan_nodes: dag.plan_nodes.clone(),
            summaries: dag.level_summaries.clone(),
            node_count,
            node_buffer,
            vertex_buffer,
            index_buffer,
            selection_buffer,
            selection_staging,
            faults_buffer,
            faults_staging,
            camera_uniform,
            indirect_buffer,
            selection_pipeline,
            bind_group,
            dirty: std::sync::atomic::AtomicBool::new(true),
            pending: std::sync::atomic::AtomicBool::new(false),
            plan: None,
        };
        // 初始命令字全零(indexCount=0 no-op 槽):首帧计划提交前任何误消费都画不出东西。
        queue.write_buffer(&runtime.indirect_buffer, 0, &vec![0u8; indirect_bytes as usize]);
        Ok(runtime)
    }

    /// 设备限制门(storage 计数/workgroup 上限/buffer 尺寸;bin 侧 gpu_lod_resources 同形)。
    fn validate_device(device: &wgpu::Device, dag: &ClusterLodDagRuntime) -> Result<(), String> {
        let limits = device.limits();
        if limits.max_storage_buffers_per_shader_stage < 3 {
            return Err("cluster LOD selection requires three storage bindings".into());
        }
        let workgroups = (dag.nodes.len() as u32)
            .div_ceil(crate::gpu_cluster_lod_gpu::CLUSTER_LOD_SELECTION_WORKGROUP_SIZE);
        if workgroups > limits.max_compute_workgroups_per_dimension {
            return Err("cluster LOD selection dispatch exceeds device workgroup limit".into());
        }
        let node_bytes = dag.node_storage.len() as u64;
        if node_bytes > limits.max_storage_buffer_binding_size || node_bytes > limits.max_buffer_size
        {
            return Err(format!(
                "cluster LOD resident nodes exceed device storage buffer limit ({node_bytes} bytes)"
            ));
        }
        for (label, bytes) in [
            ("stitched vertices", dag.vertex_buffer.len() as u64 * 4),
            ("stitched indices", dag.index_buffer.len() as u64 * 4),
            (
                "indirect commands",
                dag.nodes.len() as u64 * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES as u64,
            ),
        ] {
            if bytes > limits.max_buffer_size {
                return Err(format!("cluster LOD {label} exceed device buffer limit ({bytes} bytes)"));
            }
        }
        Ok(())
    }

    pub fn node_count(&self) -> u32 {
        self.node_count
    }

    /// indirect buffer 槽容量(= 节点数;前沿绘制数 ≤ 节点数)。
    pub fn draw_capacity(&self) -> u32 {
        self.node_count
    }

    /// 相机变更(或每帧)入口:校验并写入 uniform,置脏待 dispatch。fail-closed:
    /// 相机非法返回 Err,不触碰 GPU 状态。
    pub fn update_camera(
        &self,
        queue: &wgpu::Queue,
        camera: &ClusterLodCamera,
    ) -> Result<(), String> {
        let uniform = pack_cluster_lod_camera_uniform(camera, self.node_count as usize)?;
        queue.write_buffer(&self.camera_uniform, 0, &uniform);
        self.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    /// 待 dispatch(相机置脏且未入队)。
    pub fn needs_encode(&self) -> bool {
        self.dirty.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// dispatch 选层 compute + selection/faults → staging 拷贝(与调用方 encoder 同提交)。
    pub fn encode(&self, encoder: &mut wgpu::CommandEncoder) {
        if !self.dirty.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("cluster LOD selection dispatch"),
            ..Default::default()
        });
        self.selection_pipeline.encode_selection(&mut pass, &self.bind_group, self.node_count);
        drop(pass);
        encoder.copy_buffer_to_buffer(
            &self.selection_buffer,
            0,
            &self.selection_staging,
            0,
            4 * self.node_count as u64,
        );
        encoder.copy_buffer_to_buffer(&self.faults_buffer, 0, &self.faults_staging, 0, 4);
        self.dirty.store(false, std::sync::atomic::Ordering::Relaxed);
        self.pending.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// 最近一次成功提交的计划(无提交/faults 拒绝时 None)。
    pub fn plan(&self) -> Option<&ClusterLodIndirectPlan> {
        self.plan.as_ref()
    }

    /// 最近一次成功提交的层跨度(信息性;计划内 spans 同值)。
    pub fn level_spans(&self) -> &[ClusterLodLevelSpan] {
        self.plan
            .as_ref()
            .map(|plan| plan.level_spans.as_slice())
            .unwrap_or(&[])
    }

    /// readback → faults 零门 → 计划 → 命令字写入 indirect buffer。
    ///
    /// fail-closed:`selectionFaults` 非零 = 整批拒绝(计划清空、命令字清零、返回 Err)。
    /// 返回本次提交的前沿绘制数;无待提交时返回当前计划绘制数(幂等)。
    pub fn commit_selection(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
    ) -> Result<usize, String> {
        if !self.pending.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(self.plan.as_ref().map(|plan| plan.draw_count).unwrap_or(0));
        }
        self.pending.store(false, std::sync::atomic::Ordering::Relaxed);
        let selection = readback_words(device, &self.selection_staging, self.node_count as usize)?;
        let faults = readback_words(device, &self.faults_staging, 1)?;
        if faults[0] != 0 {
            // 整批拒绝:清计划 + 命令字清零 + 置脏待下一帧重试,绝不静默降级。
            self.plan = None;
            queue.write_buffer(
                &self.indirect_buffer,
                0,
                &vec![0u8; self.node_count as usize * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES],
            );
            self.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
            return Err(format!(
                "cluster LOD selection faults nonzero ({}): batch rejected, indirect commands zeroed",
                faults[0]
            ));
        }
        let plan = plan_cluster_lod_indirect(&self.plan_nodes, &selection, &self.summaries)
            .map_err(|error| error.to_string())?;
        queue.write_buffer(&self.indirect_buffer, 0, &cluster_lod_command_bytes(&plan));
        self.plan = Some(plan);
        Ok(self.plan.as_ref().map(|plan| plan.draw_count).unwrap_or(0))
    }

    /// 渲染 pass 消费面:绑定驻留顶点/索引,按计划逐槽 `draw_indexed_indirect`
    /// (空 cluster 保留 indexCount=0 no-op 槽,与计划合同一致)。无计划时零消费。
    /// 管线/material 绑定归调用方(消费方与普通几何 pass 同责)。
    pub fn encode_draws<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) -> usize {
        let Some(plan) = &self.plan else {
            return 0;
        };
        if plan.draw_count == 0 {
            return 0;
        }
        pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
        pass.set_index_buffer(self.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        for slot in 0..plan.draw_count {
            pass.draw_indexed_indirect(
                &self.indirect_buffer,
                slot as u64 * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES as u64,
            );
        }
        plan.draw_count
    }
}

fn init_buffer(
    device: &wgpu::Device,
    label: &str,
    bytes: &[u8],
    usage: wgpu::BufferUsages,
) -> Result<wgpu::Buffer, String> {
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: bytes.len() as u64,
        usage,
        mapped_at_creation: true,
    });
    let mut view = buffer
        .slice(..)
        .get_mapped_range_mut()
        .expect("mapped-at-creation buffer map");
    view.copy_from_slice(bytes);
    drop(view);
    buffer.unmap();
    Ok(buffer)
}

fn readback_words(
    device: &wgpu::Device,
    staging: &wgpu::Buffer,
    words: usize,
) -> Result<Vec<u32>, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    staging.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|error| format!("cluster LOD readback device poll failed: {error}"))?;
    receiver
        .recv()
        .map_err(|error| format!("cluster LOD readback callback failed: {error}"))?
        .map_err(|error| format!("cluster LOD readback map failed: {error}"))?;
    let mapped = staging
        .get_mapped_range(..)
        .map_err(|error| format!("cluster LOD mapped range failed: {error}"))?;
    let words: Vec<u32> = mapped[..words * 4]
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes(chunk.try_into().expect("chunks_exact(4)")))
        .collect();
    drop(mapped);
    staging.unmap();
    Ok(words)
}
