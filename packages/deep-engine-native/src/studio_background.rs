//! Studio 渐变背景 pass(视觉一致性收口:与 Three `getSkyboxTexture("studio")`
//! 同源的屏幕空间垂直三 stop 渐变)。
//!
//! 合同:环境 v10(`native-aces-studio-gradient-v10`,kind builtin-ibl)。
//! Three 侧画布渐变是 sRGB 域的三 stop(0→#081116,0.52→#17272e,1→#314149),
//! 全屏直接消费;本 pass 输出线性 HDR(与 forward 缓冲同域),三 stop 经
//! [`inverse_output`] 预逆固定 ACES,屏显与 Three 的 sRGB 画布对齐。
//! 常量在编译期由 [`gradient_stops_linear`] 计算,单一来源,无 uniform。


/// Three `palettes.studio` 的三个 sRGB stop(#081116 / #17272e / #314149)。
pub const STUDIO_GRADIENT_STOPS_SRGB: [[f64; 3]; 3] = [
    [0x08 as f64 / 255.0, 0x11 as f64 / 255.0, 0x16 as f64 / 255.0],
    [0x17 as f64 / 255.0, 0x27 as f64 / 255.0, 0x2e as f64 / 255.0],
    [0x31 as f64 / 255.0, 0x41 as f64 / 255.0, 0x49 as f64 / 255.0],
];

/// 与 `runtime_package::solid_environment::inverse_output` 同式(预逆固定 ACES)。
fn inverse_output(srgb: f64) -> f64 {
    let y = if srgb <= 0.04045 {
        srgb / 12.92
    } else {
        ((srgb + 0.055) / 1.055).powf(2.4)
    };
    let a = 2.51 - 2.43 * y;
    let b = 0.03 - 0.59 * y;
    (-b + (b * b + 0.56 * a * y).sqrt()) / (2.0 * a)
}

/// 三个 stop 的线性 HDR 值(WGSL 常量注入的唯一来源)。
pub fn gradient_stops_linear() -> [[f32; 3]; 3] {
    let mut stops = [[0f32; 3]; 3];
    for (index, stop) in STUDIO_GRADIENT_STOPS_SRGB.iter().enumerate() {
        stops[index] = [
            inverse_output(stop[0]) as f32,
            inverse_output(stop[1]) as f32,
            inverse_output(stop[2]) as f32,
        ];
    }
    stops
}

fn studio_background_shader() -> String {
    let stops = gradient_stops_linear();
    let format_stop = |stop: [f32; 3]| format!("vec3f({:.8}, {:.8}, {:.8})", stop[0], stop[1], stop[2]);
    format!(
        r#"
// 屏幕空间垂直三 stop 渐变(与 Three studio 画布同源;t: 0=顶,1=底)。
const deepStudioTop = {top};
const deepStudioMid = {mid};
const deepStudioBottom = {bottom};
struct SkyVertex {{ @builtin(position) position: vec4f, @location(0) ndc: vec2f }};
@vertex fn vertex_main(@builtin(vertex_index) i: u32) -> SkyVertex {{
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[i];
  var v: SkyVertex; v.position = vec4f(p, 0.0, 1.0); v.ndc = p; return v;
}}
@fragment fn fragment_main(v: SkyVertex) -> @location(0) vec4f {{
  let t = clamp(0.5 - v.ndc.y * 0.5, 0.0, 1.0);
  let a = mix(deepStudioTop, deepStudioMid, clamp(t / 0.52, 0.0, 1.0));
  let b = mix(a, deepStudioBottom, clamp((t - 0.52) / 0.48, 0.0, 1.0));
  return vec4f(b, 1.0);
}}
"#,
        top = format_stop(stops[0]),
        mid = format_stop(stops[1]),
        bottom = format_stop(stops[2]),
    )
}

/// Studio 渐变背景管线(MSAA 目标与 forward 相同;无 uniform 无顶点缓冲)。
pub fn create_studio_background_pipeline(
    device: &wgpu::Device,
    target_format: wgpu::TextureFormat,
    sample_count: u32,
) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Deep Engine native studio gradient background shader"),
        source: wgpu::ShaderSource::Wgsl(studio_background_shader().into()),
    });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Deep Engine native studio gradient background layout"),
        bind_group_layouts: &[],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Deep Engine native studio gradient background pipeline"),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vertex_main"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState {
            count: sample_count,
            ..Default::default()
        },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fragment_main"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: target_format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

/// 渐变背景 pass:清兜底底色后画全屏三角;不接深度(mesh pass 自行 Clear 深度、
/// 颜色 Load 本 pass 结果)。顶点由 shader 内联生成,无绑定资源。
/// 本模块在 lib 侧双编译(常量合同供 runtime_package 消费),渲染目标以视图
/// 参数传入,不引用 bin 侧 ForwardTargets。
pub fn encode_studio_background_pass(
    encoder: &mut wgpu::CommandEncoder,
    msaa_view: &wgpu::TextureView,
    resolve_view: &wgpu::TextureView,
    pipeline: &wgpu::RenderPipeline,
) {
    let [r, g, b] = gradient_stops_linear()[2];
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Deep Engine native studio gradient background pass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: msaa_view,
            depth_slice: None,
            resolve_target: Some(resolve_view),
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color { r: f64::from(r), g: f64::from(g), b: f64::from(b), a: 1.0 }),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        ..Default::default()
    });
    pass.set_pipeline(pipeline);
    pass.draw(0..3, 0..1);
}
