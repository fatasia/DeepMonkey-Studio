//! Cluster LOD 接线运行时 GPU 探针(wgpu 真设备;#[ignore] 真机门,
//! `cargo test --lib gpu_cluster_lod_runtime_gpu -- --ignored` 显式跑)。
//!
//! 闭环:golden `.dgc` → `ClusterLodDagRuntime` → GPU 驻留 buffer 族 → 相机 uniform →
//! 选层 dispatch → readback → faults 零门 → indirect 计划 → 命令字写入 →
//! 渲染 pass 消费(`encode_draws` 真发起 draw_indexed_indirect;任何 wgpu 校验错
//! 经默认 uncaptured handler 恐慌 = 门咬人)。与 CPU 权威镜像逐命令字对拍
//! (fixture 与 CPU 腿同源:quick_sphere 黄金字节,粗化/细化双臂)。

use crate::gpu_cluster_lod_dag::ClusterLodDagRuntime;
use crate::gpu_cluster_lod_runtime::{ClusterLodGpuRuntime, cluster_lod_command_bytes};
use crate::gpu_cluster_lod_runtime_tests::{camera_for, golden_variant};
use crate::gpu_cluster_lod_selection::select_cluster_lod;

const CONSUME_WGSL: &str = r#"
struct VsOutput { @builtin(position) position: vec4<f32>, };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VsOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var out: VsOutput;
    out.position = vec4<f32>(positions[index % 3u], 0.0, 1.0);
    return out;
}
@fragment fn fs() -> @location(0) vec4<f32> {
    return vec4<f32>(0.25, 0.5, 0.75, 1.0);
}
"#;

/// CPU 权威计划命令字(与 GPU 腿同 fixture、同 selection 镜像)。
fn cpu_plan_commands(runtime: &ClusterLodDagRuntime, pixel_threshold: f64) -> Vec<[u32; 5]> {
    let camera = camera_for(runtime, pixel_threshold);
    let selection = select_cluster_lod(&runtime.nodes, &camera).expect("CPU authority selects");
    let plan = crate::gpu_cluster_lod_indirect::plan_cluster_lod_indirect(
        &runtime.plan_nodes,
        &selection.selection,
        &runtime.level_summaries,
    )
    .expect("CPU plan builds");
    plan.draws
        .iter()
        .map(|draw| draw.indirect_command)
        .collect()
}

#[test]
#[ignore = "requires a real GPU adapter (NVIDIA/Intel/AMD); run with -- --ignored"]
fn runtime_end_to_end_matches_cpu_authority_and_consumes_draws() {
    pollster::block_on(async {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let runtime_dag =
            ClusterLodDagRuntime::from_dgc(&golden_variant("compressed"), "quick_sphere-gpu-probe")
                .expect("golden builds");

        // 细化臂:阈值极小 → 全叶前沿,GPU 驱动计划与 CPU 权威逐命令字一致。
        let mut runtime =
            ClusterLodGpuRuntime::new(&device, &queue, &runtime_dag).expect("residency builds");
        assert_eq!(runtime.node_count() as usize, runtime_dag.nodes.len());
        assert_eq!(runtime.draw_capacity() as usize, runtime_dag.nodes.len());
        assert!(runtime.needs_encode(), "fresh runtime dispatches once");
        let leaves_threshold = 1e-9;
        runtime
            .update_camera(&queue, &camera_for(&runtime_dag, leaves_threshold))
            .expect("refine camera packs");
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("cluster_lod_runtime_refine"),
        });
        runtime.encode(&mut encoder);
        assert!(!runtime.needs_encode(), "encode clears camera dirty");
        queue.submit([encoder.finish()]);
        let draws = runtime
            .commit_selection(&device, &queue)
            .expect("refine commit");
        let expected_refine = cpu_plan_commands(&runtime_dag, leaves_threshold);
        assert_eq!(
            draws,
            expected_refine.len(),
            "GPU draw count must match CPU authority"
        );
        let actual: Vec<[u32; 5]> = runtime
            .plan()
            .expect("refine plan cached")
            .draws
            .iter()
            .map(|draw| draw.indirect_command)
            .collect();
        assert_eq!(
            actual, expected_refine,
            "refine arm command words word-for-word"
        );
        assert_eq!(
            cluster_lod_command_bytes(runtime.plan().unwrap()).len(),
            draws * 20,
            "command stream byte length"
        );

        // commit 幂等:无待提交时返回当前计划绘制数,不重复 readback。
        let again = runtime
            .commit_selection(&device, &queue)
            .expect("idempotent commit");
        assert_eq!(again, draws);

        // 粗化臂:相机变更即再 dispatch(帧循环合同),前沿收敛到根区域。
        let roots_threshold = 1e12;
        runtime
            .update_camera(&queue, &camera_for(&runtime_dag, roots_threshold))
            .expect("coarse camera packs");
        assert!(runtime.needs_encode(), "camera change re-dirties");
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("cluster_lod_runtime_coarse"),
        });
        runtime.encode(&mut encoder);
        queue.submit([encoder.finish()]);
        let draws = runtime
            .commit_selection(&device, &queue)
            .expect("coarse commit");
        let expected_coarse = cpu_plan_commands(&runtime_dag, roots_threshold);
        assert_eq!(draws, expected_coarse.len(), "coarse arm draw count");
        let actual: Vec<[u32; 5]> = runtime
            .plan()
            .expect("coarse plan cached")
            .draws
            .iter()
            .map(|draw| draw.indirect_command)
            .collect();
        assert_eq!(
            actual, expected_coarse,
            "coarse arm command words word-for-word"
        );

        // 渲染 pass 消费:最小管线 + 离屏目标,encode_draws 真发起全部计划槽位
        // (draw_indexed_indirect;校验错经默认 uncaptured handler 恐慌 = 门咬人)。
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("cluster_lod_runtime_consume_target"),
            size: wgpu::Extent3d {
                width: 4,
                height: 4,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("cluster_lod_runtime_consume_wgsl"),
            source: wgpu::ShaderSource::Wgsl(CONSUME_WGSL.into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("cluster_lod_runtime_consume_pipeline"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("cluster_lod_runtime_consume"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("cluster_lod_runtime_consume_pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                ..Default::default()
            });
            pass.set_pipeline(&pipeline);
            let issued = runtime.encode_draws(&mut pass);
            assert_eq!(issued, draws, "consumption must issue every planned slot");
        }
        queue.submit([encoder.finish()]);
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("consume poll");
    });
}
