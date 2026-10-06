//! Cluster LOD 选层 compute 管线探针(wgpu 真设备;#[ignore] 真机门,
//! `cargo test --lib gpu_cluster_lod_gpu_probe -- --ignored` 显式跑)。
//!
//! 闭环:打包节点 64B ABI → compute dispatch(64 workgroup)→ 读回 selection
//! 与 CPU 权威镜像(select_cluster_lod)位级对拍 + selectionFaults 零哨兵。

use crate::gpu_cluster_lod_gpu::ClusterLodSelectionPipeline;
use crate::gpu_cluster_lod_selection::{
    pack_cluster_lod_node, select_cluster_lod, ClusterLodCamera, ClusterLodNode,
    CLUSTER_LOD_REFINE_SENTINEL, CLUSTER_LOD_SELECTION_WORKGROUP_SIZE,
};

#[test]
#[ignore = "requires a real GPU adapter (NVIDIA/Intel/AMD); run with -- --ignored"]
fn selection_compute_matches_cpu_authority() {
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

    // 三节点(根粗/两叶细),相机近场:根未过阈、两叶选中。
    let nodes = vec![
        ClusterLodNode {
            id: "root".into(),
            level: 0,
            error: 4.0,
            bounds_min: [0.0, 0.0, 0.0],
            bounds_max: [2.0, 2.0, 2.0],
            first_triangle: 0,
            triangle_count: 16,
            children: vec!["a".into(), "b".into()],
        },
        ClusterLodNode {
            id: "a".into(),
            level: 1,
            error: 0.5,
            bounds_min: [0.0, 0.0, 0.0],
            bounds_max: [1.0, 2.0, 2.0],
            first_triangle: 0,
            triangle_count: 8,
            children: vec![],
        },
        ClusterLodNode {
            id: "b".into(),
            level: 1,
            error: 0.5,
            bounds_min: [1.0, 0.0, 0.0],
            bounds_max: [2.0, 2.0, 2.0],
            first_triangle: 8,
            triangle_count: 8,
            children: vec![],
        },
    ];
    let camera = ClusterLodCamera {
        position: [1.0, 1.0, 3.0],
        forward: [0.0, 0.0, -1.0],
        viewport_height_pixels: 1080.0,
        tan_half_fov_y: 0.5,
        pixel_threshold: 4.0,
    };
    let cpu = select_cluster_lod(&nodes, &camera).expect("CPU authority selects");

    let node_bytes: Vec<u8> = nodes
        .iter()
        .enumerate()
        .flat_map(|(index, node)| pack_cluster_lod_node(node, index as u32))
        .collect();
    let node_count = nodes.len() as u32;

    let mut camera_uniform = [0u8; 48];
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
        camera_uniform[word * 4..word * 4 + 4]
            .copy_from_slice(&(value as f32).to_bits().to_le_bytes());
    }

    let pipeline = ClusterLodSelectionPipeline::new(&device);
    let node_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("cluster_nodes"),
        size: node_bytes.len() as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    queue.write_buffer(&node_buffer, 0, &node_bytes);
    let selection_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("selection"),
        size: 4 * nodes.len() as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let faults_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("selection_faults"),
        size: 4,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: true,
    });
    faults_buffer.unmap();
    let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("cluster_camera_uniform"),
        size: camera_uniform.len() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&camera_buffer, 0, &camera_uniform);

    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("cluster_lod_selection_bg"),
        layout: &pipeline.bind_group_layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: node_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: selection_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: faults_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: camera_buffer.as_entire_binding() },
        ],
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("cluster_lod_selection_probe"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("cluster_lod_selection_probe_pass"),
            timestamp_writes: None,
        });
        pipeline.encode_selection(&mut pass, &bind_group, node_count);
    }
    let selection_read = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("cluster_selection_readback"),
        size: 4 * nodes.len() as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let faults_read = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("cluster_faults_readback"),
        size: 4,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    encoder.copy_buffer_to_buffer(&selection_buffer, 0, &selection_read, 0, 4 * nodes.len() as u64);
    encoder.copy_buffer_to_buffer(&faults_buffer, 0, &faults_read, 0, 4);
    queue.submit([encoder.finish()]);

    let read_back = |label: &'static str, staging: &wgpu::Buffer| -> Vec<u32> {
        let (sender, receiver) = std::sync::mpsc::channel();
        staging.slice(..).map_async(wgpu::MapMode::Read, move |result| {
            sender.send(result).unwrap();
        });
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        receiver.recv().unwrap().unwrap_or_else(|error| panic!("{label}: map failed: {error}"));
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
    assert_eq!(faults, vec![0], "selection faults must be zero (fail-closed sentinel unused)");

    assert_eq!(selection_words, cpu.selection, "GPU selection must match CPU authority word-for-word");
    let _ = CLUSTER_LOD_REFINE_SENTINEL;
    let _ = CLUSTER_LOD_SELECTION_WORKGROUP_SIZE;
    });
}
