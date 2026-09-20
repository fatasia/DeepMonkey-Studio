use crate::{
    gpu_culling::GpuCulling,
    gpu_lod::GpuLod,
    gpu_scene::GpuScene,
    gpu_scene_draw::DrawFrame,
    pipeline::MeshPipelines,
    render_graph::GraphJob,
    shadow_map::ShadowMap,
    telemetry_gpu::{GpuSegment, GpuSegmentStamper},
};

/// 级联编码的共享输入(全部只读引用):串行与并行两条路径共用同一份
/// 上下文,wgpu 资源句柄均为 `Send+Sync`,可安全进入 executor 线程。
pub struct CascadeScene<'a> {
    pub shadow_map: &'a ShadowMap,
    pub scene: &'a GpuScene,
    pub culling: &'a GpuCulling,
    pub lod: Option<&'a GpuLod>,
    pub pipelines: &'a MeshPipelines,
}

impl<'a> CascadeScene<'a> {
    fn encode_cascade(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        cascade_index: usize,
        layer_view: &wgpu::TextureView,
    ) {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep Engine native cached cascade shadow pass"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: layer_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        let shadow_map = self.shadow_map;
        pass.set_bind_group(
            0,
            &shadow_map.shadow_frame_bind_group,
            &[shadow_map.dynamic_offset(cascade_index)],
        );
        let culling_view = cascade_index + 1;
        self.scene.draw_shadow_indirect(
            &mut pass,
            self.pipelines,
            self.culling,
            self.lod,
            DrawFrame {
                builtin: &shadow_map.shadow_frame_bind_group,
                cascade: Some((cascade_index, shadow_map.dynamic_offset(cascade_index))),
            },
            culling_view,
        );
    }
}

#[allow(dead_code)] // 串行参照:GPU 确定性测试的对照实现(并行/串行逐位一致),生产路径已切并行。
pub fn encode_shadow_cascades(
    encoder: &mut wgpu::CommandEncoder,
    scene: &CascadeScene<'_>,
    dirty_mask: u16,
) {
    for (cascade_index, layer_view) in scene.shadow_map.layer_views.iter().enumerate() {
        if dirty_mask & (1 << cascade_index) == 0 {
            continue;
        }
        scene.encode_cascade(encoder, cascade_index, layer_view);
    }
}

/// 波次5:Native RenderGraph 真多线程级联阴影 command 编码。
///
/// - 每个脏级联是一个独立编码节点:各写各自 texture array layer,只读
///   共享 wgpu 资源,在 executor 线程上各自创建 CommandEncoder 编码并
///   finish。
/// - 确定性提交:产物按级联升序收集,调用方以该序并入单次 `queue.submit`;
///   wgpu 队列对单次 submit 内的 command buffer 保证 FIFO 执行序,
///   因此 GPU 观察到的级联顺序与串行完全一致,阴影贴图内容逐位相同
///   (真机深度回读证明,见 `renderer::shadow_parallel_gpu_tests`)。
/// - 错误传播:任一级联节点失败即取消整批,返回 `GraphBatchError`,
///   调用方不得提交本帧任何 command buffer。
///
/// `executor_threads` 是并发 executor 上限(含调用线程);executor 会
/// 钳制到脏级联数,单级联批次在调用线程内联执行,零额外线程成本。
pub fn encode_shadow_cascades_parallel(
    device: &wgpu::Device,
    executor_threads: usize,
    scene: &CascadeScene<'_>,
    dirty_mask: u16,
    timestamps: Option<CascadeShadowTimestamps<'_>>,
) -> Result<Vec<wgpu::CommandBuffer>, crate::render_graph::GraphBatchError> {
    let dirty: Vec<usize> = (0..scene.shadow_map.layer_views.len())
        .filter(|&cascade_index| dirty_mask & (1 << cascade_index) != 0)
        .collect();
    let last_order = dirty.len().saturating_sub(1);
    let jobs = dirty
        .into_iter()
        .enumerate()
        .map(|(order, cascade_index)| {
            let is_first = order == 0;
            let is_last = order == last_order;
            GraphJob::new(format!("shadow-cascade-{cascade_index}"), move |_| {
                let label = format!(
                    "Deep Engine native parallel cascade shadow encoder [cascade {cascade_index}]"
                );
                let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some(&label),
                });
                if let Some(route) = timestamps.filter(|_| is_first) {
                    if route.frame_begin_on_first {
                        route.stamper.write_frame_begin(&mut encoder);
                    }
                    route
                        .stamper
                        .write_segment_begin(GpuSegment::Shadow, &mut encoder);
                }
                scene.encode_cascade(
                    &mut encoder,
                    cascade_index,
                    &scene.shadow_map.layer_views[cascade_index],
                );
                if let Some(route) = timestamps.filter(|_| is_last) {
                    route
                        .stamper
                        .write_segment_end(GpuSegment::Shadow, &mut encoder);
                }
                Ok(encoder.finish())
            })
        })
        .collect();
    crate::render_graph::execute_graph_batch(jobs, executor_threads).into_artifacts()
}

/// 并行级联编码时写进级联 command buffer 的 GPU 时间戳路由。
///
/// - `stamper`:段起止时间戳写在哪(阴影段的 GPU 时长必须包住级联工作,
///   与串行单 encoder 布局等价)。
/// - `frame_begin_on_first`:本帧没有 pre CB(culling/lod 未更新)时,
///   Frame 起点时间戳由首个级联 CB 携带,保证 Frame 段仍然覆盖整帧。
#[derive(Clone, Copy)]
pub struct CascadeShadowTimestamps<'a> {
    pub stamper: &'a GpuSegmentStamper<'a>,
    pub frame_begin_on_first: bool,
}

/// 阴影级联并行编码的 executor 并发上限。级联数典型为 2~6,超过部分
/// 由 executor 钳制;不按整机核数拉满,避免与其它帧段工作争抢调度。
pub fn shadow_executor_threads() -> usize {
    std::thread::available_parallelism()
        .map(|cores| cores.get())
        .unwrap_or(4)
        .min(8)
}
