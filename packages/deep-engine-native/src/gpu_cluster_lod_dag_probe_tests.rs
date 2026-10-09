//! 簇 LOD DAG 运行时 GPU 端到端探针(#[ignore] 真机门,批 D):
//! 金样 `.dgc` 字节 → [`ClusterLodDagRuntime`] 构建 → 64B 节点表直入 compute storage
//! → 选层 dispatch(批 B 二管线)→ 读回 selection 与 CPU 权威位级对拍 + faults 零哨兵
//! → GPU selection 喂 indirect 计划(批 B 一镜像)→ 前沿闭合。
//!
//! 运行:`cargo test --lib gpu_cluster_lod_dag_probe -- --ignored`

use crate::gpu_cluster_lod_dag::ClusterLodDagRuntime;
use crate::gpu_cluster_lod_dag_tests::{camera_for, golden_variant};
use crate::gpu_cluster_lod_gpu::ClusterLodSelectionPipeline;
use crate::gpu_cluster_lod_indirect::plan_cluster_lod_indirect;
use crate::gpu_cluster_lod_selection::{
    CLUSTER_LOD_NODE_STRIDE_BYTES, ClusterLodCamera, select_cluster_lod,
};

/// 打包相机 uniform(48B;与批 B 二探针同式,TS packClusterLodCamera 同构)。
fn pack_camera_uniform(camera: &ClusterLodCamera, node_count: u32) -> [u8; 48] {
    let mut uniform = [0u8; 48];
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
        uniform[word * 4..word * 4 + 4].copy_from_slice(&(value as f32).to_bits().to_le_bytes());
    }
    uniform
}

#[test]
#[ignore = "requires a real GPU adapter (NVIDIA/Intel/AMD); run with -- --ignored"]
fn dag_runtime_golden_bytes_gpu_selection_and_plan_end_to_end() {
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

        // 金样字节 → 运行时构建(与 CPU 侧测试同一入库工件)。
        let bytes = golden_variant("compressed");
        let runtime = ClusterLodDagRuntime::from_dgc(&bytes, "quick_sphere-golden")
            .expect("golden .dgc builds");
        assert_eq!(
            runtime.node_storage.len() % CLUSTER_LOD_NODE_STRIDE_BYTES,
            0
        );
        let node_count = runtime.nodes.len() as u32;

        let pipeline = ClusterLodSelectionPipeline::new(&device);
        let node_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cluster_dag_nodes"),
            size: runtime.node_storage.len() as u64,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        queue.write_buffer(&node_buffer, 0, &runtime.node_storage);
        let selection_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cluster_dag_selection"),
            size: 4 * runtime.nodes.len() as u64,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let faults_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cluster_dag_selection_faults"),
            size: 4,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: true,
        });
        faults_buffer.unmap();
        let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cluster_dag_camera_uniform"),
            size: 48,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // 双臂:细化(阈值极小,前沿=全叶)与粗化(阈值极大,前沿=全根)。
        for (label, pixel_threshold) in [("refine", 1e-9), ("coarse", 1e12)] {
            let camera = camera_for(&runtime, pixel_threshold);
            let cpu = select_cluster_lod(&runtime.nodes, &camera).expect("CPU authority");
            queue.write_buffer(&camera_buffer, 0, &pack_camera_uniform(&camera, node_count));
            queue.write_buffer(&faults_buffer, 0, &[0u8; 4]);

            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("cluster_lod_dag_probe_bg"),
                layout: &pipeline.bind_group_layout,
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
                        resource: camera_buffer.as_entire_binding(),
                    },
                ],
            });
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("cluster_lod_dag_probe"),
            });
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("cluster_lod_dag_probe_pass"),
                    timestamp_writes: None,
                });
                pipeline.encode_selection(&mut pass, &bind_group, node_count);
            }
            let selection_read = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("cluster_dag_selection_readback"),
                size: 4 * runtime.nodes.len() as u64,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let faults_read = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("cluster_dag_faults_readback"),
                size: 4,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            encoder.copy_buffer_to_buffer(
                &selection_buffer,
                0,
                &selection_read,
                0,
                4 * runtime.nodes.len() as u64,
            );
            encoder.copy_buffer_to_buffer(&faults_buffer, 0, &faults_read, 0, 4);
            queue.submit([encoder.finish()]);

            let read_back = |label: &'static str, staging: &wgpu::Buffer| -> Vec<u32> {
                let (sender, receiver) = std::sync::mpsc::channel();
                staging
                    .slice(..)
                    .map_async(wgpu::MapMode::Read, move |result| {
                        sender.send(result).unwrap();
                    });
                device
                    .poll(wgpu::PollType::wait_indefinitely())
                    .expect("poll");
                receiver
                    .recv()
                    .unwrap()
                    .unwrap_or_else(|error| panic!("{label}: map failed: {error}"));
                let words: Vec<u32> = staging
                    .slice(..)
                    .get_mapped_range()
                    .unwrap_or_else(|error| panic!("{label}: map range failed: {error}"))
                    .chunks_exact(4)
                    .map(|chunk| u32::from_le_bytes(chunk.try_into().expect("4B")))
                    .collect();
                staging.unmap();
                words
            };
            let selection_words = read_back("selection", &selection_read);
            let faults = read_back("faults", &faults_read);
            assert_eq!(faults, vec![0], "{label}: faults sentinel must stay zero");
            assert_eq!(
                selection_words, cpu.selection,
                "{label}: GPU selection must match CPU authority word-for-word"
            );

            // GPU selection → indirect 计划:前沿闭合 fail-closed 合同直接背书。
            let plan = plan_cluster_lod_indirect(
                &runtime.plan_nodes,
                &selection_words,
                &runtime.level_summaries,
            )
            .unwrap_or_else(|error| panic!("{label}: plan rejected GPU selection: {error}"));
            assert_eq!(
                plan.draw_count,
                cpu.frontier.len(),
                "{label}: plan draws match frontier"
            );
            assert!(
                plan.covered_leaf_clusters > 0,
                "{label}: every leaf covered exactly once (closure)"
            );
        }
    });
}
