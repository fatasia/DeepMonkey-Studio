use std::sync::mpsc;

use bytemuck::cast_slice;
use deep_engine_native::pbr_brdf::direct_brdf;
use wgpu::util::DeviceExt;

const NORMAL: [f64; 3] = [0.0, 0.0, 1.0];
const VIEW: [f64; 3] = [0.3, 0.2, 1.0];
const LIGHT: [f64; 3] = [-0.4, 0.1, 1.0];
const BASE: [f64; 3] = [0.8, 0.35, 0.12];

#[test]
fn production_shader_uses_browser_schlick_correlated_smith_and_separate_diffuse() {
    let shader = include_str!("../assets/shaders/native_mesh_v1.wgsl");
    for contract in [
        "exp2((-5.55473 * cosine - 6.98316) * cosine)",
        "let gv = nl * sqrt(alpha_2 + (1.0 - alpha_2) * nv * nv)",
        "let gl = nv * sqrt(alpha_2 + (1.0 - alpha_2) * nl * nl)",
        "let visibility = 0.5 / max(gv + gl, 0.000001)",
        "let diffuse = (1.0 - metal) * base / 3.14159265",
        "clamp(input.material.x * mr_sample.g, 0.045, 1.0)",
    ] {
        assert!(
            shader.contains(contract),
            "missing BRDF contract: {contract}"
        );
    }
    assert!(!shader.contains("let k = (rough + 1.0)"));
    assert!(!shader.contains("return ((1.0 - f) * (1.0 - metal)"));
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn production_brdf_matches_cpu_golden_on_real_gpu() {
    pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
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
            .expect("GPU device");
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let source = format!(
            "{}\n{}\n{}",
            include_str!("../assets/shaders/native_mesh_v1.wgsl"),
            include_str!("../assets/shaders/native_cascaded_shadow_v1.wgsl"),
            "@group(0) @binding(7) var<storage, read_write> brdf_out: array<vec4f>;\n\
             @compute @workgroup_size(1) fn brdf_readback() {\n\
               brdf_out[0] = vec4f(direct_brdf(vec3f(0.0,0.0,1.0),\n\
                 safe_normalize(vec3f(0.3,0.2,1.0), vec3f(0.0,0.0,1.0)),\n\
                 safe_normalize(vec3f(-0.4,0.1,1.0), vec3f(0.0,0.0,1.0)),\n\
                 vec3f(0.8,0.35,0.12), 0.42, 0.31), 1.0);\n}"
        );
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("production BRDF readback"),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("production BRDF readback"),
            layout: None,
            module: &module,
            entry_point: Some("brdf_readback"),
            compilation_options: Default::default(),
            cache: None,
        });
        let output = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("BRDF output"),
            contents: &[0; 16],
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("BRDF output"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry {
                binding: 7,
                resource: output.as_entire_binding(),
            }],
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("BRDF readback"),
            size: 16,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, 16);
        queue.submit([encoder.finish()]);
        let (sender, receiver) = mpsc::sync_channel(1);
        readback.map_async(wgpu::MapMode::Read, .., move |result| {
            sender.send(result).unwrap()
        });
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        receiver.recv().unwrap().unwrap();
        let bytes = readback.get_mapped_range(..).unwrap();
        let actual: &[f32] = cast_slice(&bytes);
        let expected = direct_brdf(NORMAL, VIEW, LIGHT, BASE, 0.42, 0.31);
        for index in 0..3 {
            assert!(
                (actual[index] - expected[index] as f32).abs() < 2.0e-5,
                "channel {index}: gpu={} cpu={}",
                actual[index],
                expected[index]
            );
        }
        drop(bytes);
        readback.unmap();
        assert!(pollster::block_on(scope.pop()).is_none());
        println!(
            "Native/browser BRDF GPU parity passed: {:?}",
            adapter.get_info()
        );
    });
}
