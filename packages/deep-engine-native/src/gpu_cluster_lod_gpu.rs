//! Cluster LOD 选层 compute 管线(wgpu;binding 合同 =
//! TS `CLUSTER_LOD_SELECTION_BINDINGS` 逐项:0 clusterNodes(ro storage)/
//! 1 selection(rw storage)/ 2 selectionFaults(rw storage atomic)/ 3 params(uniform))。
//!
//! 单源 WGSL:`gpu_cluster_lod_wgsl::CLUSTER_LOD_SELECTION_WGSL`。
//! 执行合同:workgroup 64;越界 lane 不触 buffer;`selectionFaults` 非零 = 批污染,
//! 消费方(渲染器接线,批 C)见到非零即整批拒绝,绝不静默降级。

use crate::gpu_cluster_lod_wgsl::CLUSTER_LOD_SELECTION_WGSL;
use wgpu;

/// 选层 compute 管线 + 绑定族(wgpu)。
pub struct ClusterLodSelectionPipeline {
    pub pipeline: wgpu::ComputePipeline,
    pub bind_group_layout: wgpu::BindGroupLayout,
}

impl ClusterLodSelectionPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("cluster_lod_selection"),
            source: wgpu::ShaderSource::Wgsl(CLUSTER_LOD_SELECTION_WGSL.into()),
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("cluster_lod_selection_bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(64),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(4),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(4),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(48),
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("cluster_lod_selection_layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("cluster_lod_selection_pipeline"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("select_cluster_lod"),
            compilation_options: Default::default(),

            cache: None,
        });
        Self {
            pipeline,
            bind_group_layout,
        }
    }

    /// 派发(workgroup 64;nodeCount 由调用方 ceil-div)。
    pub fn encode_selection<'a>(
        &self,
        pass: &mut wgpu::ComputePass<'a>,
        bind_group: &'a wgpu::BindGroup,
        node_count: u32,
    ) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, bind_group, &[]);
        let workgroups = node_count.div_ceil(CLUSTER_LOD_SELECTION_WORKGROUP_SIZE);
        pass.dispatch_workgroups(workgroups, 1, 1);
    }
}

pub const CLUSTER_LOD_SELECTION_WORKGROUP_SIZE: u32 =
    crate::gpu_cluster_lod_selection::CLUSTER_LOD_SELECTION_WORKGROUP_SIZE;
