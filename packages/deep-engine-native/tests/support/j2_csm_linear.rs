#[path = "j2_csm_sampling.rs"]
mod sampling;
use serde_json::{Value, json};

#[allow(dead_code)]
use deep_engine_native::shader_package::hash;
#[path = "j2_csm_oracle.rs"]
mod oracle;
const NATIVE: &str = include_str!("../../assets/shaders/native_cascaded_shadow_v1.wgsl");
const MATH: &str = include_str!("../../../deep-engine/wgsl/cascadedShadowMath.wgsl");

#[test]
#[ignore = "real Native production CSM common seven-point and linear-PCF depth edge"]
fn j2_b4_actual_native_csm_linear() {
    pollster::block_on(async {
        let f: Value = serde_json::from_str(oracle::FIXTURE).unwrap();
        let fixture_hash = hash::sha256(oracle::FIXTURE.as_bytes());
        let native = format!("{MATH}\n{NATIVE}");
        let library = format!(
            "struct ProbeFrame {{ eye: vec4f }};\nvar<private> frame: ProbeFrame;\n{}",
            native.split_once("fn local_spot_pcss(").unwrap().0
        );
        let points: Vec<_> = oracle::list(&f, "uvXs")
            .iter()
            .flat_map(|u| oracle::list(&f, "depths").into_iter().map(move |d| (*u, d)))
            .collect();
        let depths = points
            .iter()
            .map(|(_, d)| d.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let us = points
            .iter()
            .map(|(u, _)| u.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let code = format!(
            r#"{library}
@vertex fn probeVertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {{
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
}}
@fragment fn probeFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {{
  let depths = array<f32,{count}>({depths}); let us = array<f32,{count}>({us});
  let pixel = u32(position.x); let world = vec3f(us[pixel]*2.0-1.0,0,depths[pixel]);
  return vec4f(shadow_visibility(world,vec3f(0),1.0),0,0,1);
}}"#,
            count = points.len()
        );
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        let info = adapter.get_info();
        assert!(matches!(
            info.device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ));
        let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: None,
            source: wgpu::ShaderSource::Wgsl(code.clone().into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
            layout: None,
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("probeVertex"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("probeFragment"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba32Float,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let mut runs = Vec::new();
        for _round in 0..2 {
            let mut results = Vec::new();
            for blend in oracle::list(&f, "blendStarts") {
                for filter in ["nearest", "linear"] {
                    for edge in [false, true] {
                        let values = sampling::sample(
                            &device,
                            &queue,
                            &pipeline,
                            &f,
                            blend,
                            filter,
                            edge,
                            points.len(),
                        )
                        .await;
                        let expected: Vec<_> = points
                            .iter()
                            .map(|(u, d)| oracle::visibility(&f, filter, edge, blend, *d, *u))
                            .collect();
                        let max_error = values
                            .iter()
                            .zip(&expected)
                            .map(|(a, b)| (f64::from(*a) - b).abs())
                            .fold(0.0, f64::max);
                        assert!(
                            values.iter().all(|v| v.is_finite())
                                && max_error <= f["maxError"].as_f64().unwrap(),
                            "production CSM filter mismatch {filter}/{edge}: {max_error}"
                        );
                        results.push(json!({"id":"native-production-wgsl","filter":filter,"pattern":if edge{"edge"}else{"constant"},"blendStart":blend,
                    "values":values,"expected":expected,"maxError":max_error,"passed":true,"finite":true,"libraryHash":hash::sha256(library.as_bytes()),"sourceHash":hash::sha256(code.as_bytes())}));
                    }
                }
            }
            runs.push(json!({"results":results,"passed":true}));
        }
        assert!(validation.pop().await.is_none());
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/csm-linear");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("native.json"),serde_json::to_string_pretty(&json!({"fixtureHash":fixture_hash,"runs":runs,"passed":true,"adapter":format!("{info:?}")})).unwrap()).unwrap();
    });
}
