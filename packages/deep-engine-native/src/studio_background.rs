//! Studio panorama: the same gradient and softbox as the author canvas.
//!
//! 合同:环境 v10(`native-aces-studio-gradient-v10`,kind builtin-ibl)。
//! Three 侧画布渐变是 sRGB 域的三 stop(0→#081116,0.52→#17272e,1→#314149),
//! 本 pass 与 Three 纹理背景一样解码到线性 HDR，再由输出 pass 处理 ACES。
//! Camera projection uses the existing frame prefix; no per-frame allocations.

fn srgb_linear(value: f32) -> f32 {
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

/// sRGB author canvas sample, including its radial softbox and 8-bit storage.
pub fn author_studio_srgb(u: f32, v: f32) -> [f32; 3] {
    let t = v.clamp(0.0, 1.0);
    let (a, b, weight) = if t <= 0.52 {
        (0, 1, t / 0.52)
    } else {
        (1, 2, (t - 0.52) / 0.48)
    };
    let base: [f32; 3] = std::array::from_fn(|i| {
        STUDIO_GRADIENT_STOPS_SRGB[a][i] as f32 * (1.0 - weight)
            + STUDIO_GRADIENT_STOPS_SRGB[b][i] as f32 * weight
    });
    let x = u.rem_euclid(1.0) * 1024.0;
    let y = t * 512.0;
    let radius = (((x - 500.0).powi(2) + (y - 120.0).powi(2)).sqrt() - 15.0) / 295.0;
    let stops = [
        [205.0 / 255.0, 225.0 / 255.0, 231.0 / 255.0, 0.22],
        [156.0 / 255.0, 190.0 / 255.0, 200.0 / 255.0, 0.08],
        [210.0 / 255.0, 220.0 / 255.0, 224.0 / 255.0, 0.0],
    ];
    let (a, b, w) = if radius <= 0.45 {
        (0, 1, (radius / 0.45).clamp(0.0, 1.0))
    } else {
        (1, 2, ((radius - 0.45) / 0.55).clamp(0.0, 1.0))
    };
    let alpha = stops[a][3] * (1.0 - w) + stops[b][3] * w;
    std::array::from_fn(|i| {
        let color = base[i] * (1.0 - alpha)
            + stops[a][i] * stops[a][3] * (1.0 - w)
            + stops[b][i] * stops[b][3] * w;
        (color * 255.0).round() / 255.0
    })
}

pub struct StudioBackground {
    pipeline: wgpu::RenderPipeline,
    binding: wgpu::BindGroup,
    _texture: wgpu::Texture,
}

impl StudioBackground {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        frame: &wgpu::Buffer,
        target_format: wgpu::TextureFormat,
        sample_count: u32,
    ) -> Self {
        let pipeline = create_studio_background_pipeline(device, target_format, sample_count);
        const WIDTH: u32 = 256;
        const HEIGHT: u32 = 128;
        let mut bytes = Vec::with_capacity((WIDTH * HEIGHT * 8) as usize);
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let srgb = author_studio_srgb(
                    (x as f32 + 0.5) / WIDTH as f32,
                    (y as f32 + 0.5) / HEIGHT as f32,
                );
                let rgb = srgb.map(srgb_linear);
                for channel in [rgb[0], rgb[1], rgb[2], 1.0] {
                    bytes.extend_from_slice(&crate::half_float::f32_to_f16(channel).to_le_bytes());
                }
            }
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep author studio panorama"),
            size: wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            texture.as_image_copy(),
            &bytes,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(WIDTH * 8),
                rows_per_image: None,
            },
            texture.size(),
        );
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep studio camera and panorama"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: frame.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &texture.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        Self {
            pipeline,
            binding,
            _texture: texture,
        }
    }
}

/// Three `palettes.studio` 的三个 sRGB stop(#081116 / #17272e / #314149)。
pub const STUDIO_GRADIENT_STOPS_SRGB: [[f64; 3]; 3] = [
    [
        0x08 as f64 / 255.0,
        0x11 as f64 / 255.0,
        0x16 as f64 / 255.0,
    ],
    [
        0x17 as f64 / 255.0,
        0x27 as f64 / 255.0,
        0x2e as f64 / 255.0,
    ],
    [
        0x31 as f64 / 255.0,
        0x41 as f64 / 255.0,
        0x49 as f64 / 255.0,
    ],
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
    r#"
struct Frame { viewProjection: mat4x4f, reserved: array<vec4f, 10>, exposure: vec4f };
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var panorama: texture_2d<f32>;
@group(0) @binding(2) var panoramaSampler: sampler;
struct SkyVertex { @builtin(position) position: vec4f, @location(0) ndc: vec2f };
@vertex fn vertex_main(@builtin(vertex_index) i: u32) -> SkyVertex {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[i];
  var v: SkyVertex; v.position = vec4f(p, 0.0, 1.0); v.ndc = p; return v;
}
@fragment fn fragment_main(v: SkyVertex) -> @location(0) vec4f {
  let m = frame.viewProjection;
  let right = vec3f(m[0].x, m[1].x, m[2].x);
  let up = vec3f(m[0].y, m[1].y, m[2].y);
  let forward = vec3f(m[0].w, m[1].w, m[2].w);
  let direction = normalize(forward + right * v.ndc.x / dot(right, right) + up * v.ndc.y / dot(up, up));
  let uv = vec2f(atan2(direction.z, direction.x) / 6.28318530718 + 0.5, acos(clamp(direction.y,-1.0,1.0)) / 3.14159265359);
  return vec4f(textureSampleLevel(panorama, panoramaSampler, uv, 0.0).rgb * max(frame.exposure.x, 0.0), 1.0);
}
"#.into()
}

/// Panorama pipeline uses the existing camera frame and the forward MSAA target.
pub fn create_studio_background_pipeline(
    device: &wgpu::Device,
    target_format: wgpu::TextureFormat,
    sample_count: u32,
) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Deep Engine native studio gradient background shader"),
        source: wgpu::ShaderSource::Wgsl(studio_background_shader().into()),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Deep Engine native studio gradient background pipeline"),
        layout: None,
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
/// 颜色 Load 本 pass 结果)。顶点由 shader 内联生成。
/// 本模块在 lib 侧双编译(常量合同供 runtime_package 消费),渲染目标以视图
/// 参数传入,不引用 bin 侧 ForwardTargets。
pub fn encode_studio_background_pass(
    encoder: &mut wgpu::CommandEncoder,
    msaa_view: &wgpu::TextureView,
    resolve_view: &wgpu::TextureView,
    resources: &StudioBackground,
) {
    let [r, g, b] = gradient_stops_linear()[2];
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Deep Engine native studio gradient background pass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: msaa_view,
            depth_slice: None,
            resolve_target: Some(resolve_view),
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color {
                    r: f64::from(r),
                    g: f64::from(g),
                    b: f64::from(b),
                    a: 1.0,
                }),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        ..Default::default()
    });
    pass.set_pipeline(&resources.pipeline);
    pass.set_bind_group(0, &resources.binding, &[]);
    pass.draw(0..3, 0..1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panorama_enters_output_as_linear_texture_not_inverse_tone_mapped_color() {
        use crate::output_color_profile::{OutputColorProfile, display_srgb};
        let linear = [23.0_f32 / 255.0, 39.0 / 255.0, 46.0 / 255.0].map(srgb_linear);
        let display = display_srgb(linear.map(f64::from), OutputColorProfile::ThreeAcesR185);
        for (actual, expected) in linear
            .into_iter()
            .zip([0.008568126, 0.020288563, 0.027320892])
        {
            assert!((actual - expected).abs() < 1e-7);
        }
        assert!(
            display[1] < 39.0 / 255.0,
            "ACES must remain applied to the background texture"
        );
    }

    #[test]
    fn author_panorama_matches_pixels_read_from_the_real_three_canvas() {
        let reference: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/author-studio-canvas-v1.json")).unwrap();
        for sample in reference["samples"].as_array().unwrap() {
            let actual = author_studio_srgb(
                sample["u"].as_f64().unwrap() as f32,
                sample["v"].as_f64().unwrap() as f32,
            );
            for axis in 0..3 {
                let expected = sample["rgb"][axis].as_f64().unwrap() as f32;
                assert!(
                    (actual[axis] * 255.0 - expected).abs() <= 2.0,
                    "author canvas pixel differs: {sample}, actual={actual:?}"
                );
            }
        }
    }
}
