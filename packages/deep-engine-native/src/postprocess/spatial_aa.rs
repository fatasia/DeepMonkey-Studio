//! Native 空间域边缘 AA(FXAA,Three r185 `FXAAShader.js` 适配的逐式移植)。
//!
//! 仲裁基准是 Web 端 `postprocess/spatialAaWgsl.ts` + `spatialAaCpu.ts`
//! (MIT,版权声明见仓库 `packages/deep-engine/src/postprocess/spatialAa.LICENSE.md`):
//! - WGSL 核 `deepSpatialAa*` 与 TS `SPATIAL_AA_WGSL` 逐行同构(同 luma 权重
//!   0.3/0.59/0.11、同 6 步搜索阶梯 [1,1.5,2,2,2,4]、同 edge/pixel blend 公式);
//! - CPU 镜像 [`resolve_spatial_aa_cpu`] 与 TS `resolveSpatialAaCpu` 同式
//!   (f64 中间域、输出 f32,与 TS Float32Array 的舍入一致,golden 逐位对拍)。
//!
//! 域合同:输入/输出都是**显示编码(display-encoded)premultiplied RGBA**,
//! 本模块不做色调映射或传递函数——调用方必须先把 ACES/编码链做完(生产接线
//! 属 OutputPass 后继切片:中间 LDR 纹理 + resize rebind 合同)。当前对外提供:
//! - [`spatial_aa_shader`][]:present 着色器(binding 0 显示域纹理 + binding 1
//!   filtering sampler;`fragment_main` 写出编码值,面向 unorm 目标);
//! - [`create_spatial_aa_pipeline`][]:全屏三角渲染管线;
//! - [`resolve_spatial_aa_cpu`][]:CPU 参考(金样与 GPU 对拍基线)。
//!
//! 登记口径(J4):native spatial-aa = supported/harness-only——pass 经真机
//! GPU readback 对拍验证(tests/spatial_aa_gpu.rs),但生产出片链尚未接线。

/// FXAA 核:宿主供给 `deepSpatialAaSample(uv)` 与 `deepSpatialAaTexel()`。
/// 与 TS `SPATIAL_AA_WGSL` 逐行同构,算法源自 Three r185(MIT,见模块头)。
pub const SPATIAL_AA_WGSL: &str = r#"
fn deepSpatialAaLuma(uv: vec2f) -> f32 { return dot(deepSpatialAaSample(uv).rgb, vec3f(0.3, 0.59, 0.11)); }
fn deepSpatialAaSearch(uv: vec2f, step: vec2f, edgeLuma: f32, threshold: f32) -> vec2f {
  let steps = array<f32, 6>(1.0, 1.5, 2.0, 2.0, 2.0, 4.0);
  var distance = 0.0; var delta = 0.0; var found = false;
  for (var i = 0u; i < 6u; i++) {
    distance += steps[i]; delta = deepSpatialAaLuma(uv + step * distance) - edgeLuma;
    if (abs(delta) >= threshold) { found = true; break; }
  }
  if (!found) { distance += 8.0; }
  return vec2f(distance, delta);
}
fn deepSpatialAa(uv: vec2f) -> vec4f {
  let t = deepSpatialAaTexel();
  let m = deepSpatialAaLuma(uv); let n = deepSpatialAaLuma(uv + vec2f(0.0, t.y));
  let e = deepSpatialAaLuma(uv + vec2f(t.x, 0.0)); let s = deepSpatialAaLuma(uv - vec2f(0.0, t.y));
  let w = deepSpatialAaLuma(uv - vec2f(t.x, 0.0));
  let highest = max(max(max(m, n), max(e, s)), w);
  let contrast = highest - min(min(min(m, n), min(e, s)), w);
  if (contrast < max(0.0312, 0.063 * highest)) { return deepSpatialAaSample(uv); }
  let ne = deepSpatialAaLuma(uv + t); let nw = deepSpatialAaLuma(uv + vec2f(-t.x, t.y));
  let se = deepSpatialAaLuma(uv + vec2f(t.x, -t.y)); let sw = deepSpatialAaLuma(uv - t);
  let f = clamp(abs((2.0 * (n + e + s + w) + ne + nw + se + sw) / 12.0 - m) / contrast, 0.0, 1.0);
  let smoothed = f * f * (3.0 - 2.0 * f); let pixelBlend = smoothed * smoothed;
  let horizontal = abs(n + s - 2.0 * m) * 2.0 + abs(ne + se - 2.0 * e) + abs(nw + sw - 2.0 * w)
    >= abs(e + w - 2.0 * m) * 2.0 + abs(ne + nw - 2.0 * n) + abs(se + sw - 2.0 * s);
  let positive = select(e, n, horizontal); let negative = select(w, s, horizontal);
  let direction = select(1.0, -1.0, abs(positive - m) < abs(negative - m));
  let opposite = select(positive, negative, direction < 0.0);
  let normalStep = select(vec2f(t.x, 0.0), vec2f(0.0, t.y), horizontal) * direction;
  let edgeStep = select(vec2f(0.0, t.y), vec2f(t.x, 0.0), horizontal);
  let edgeLuma = (m + opposite) * 0.5; let threshold = abs(opposite - m) * 0.25;
  let edgeUv = uv + normalStep * 0.5;
  let p = deepSpatialAaSearch(edgeUv, edgeStep, edgeLuma, threshold);
  let q = deepSpatialAaSearch(edgeUv, -edgeStep, edgeLuma, threshold);
  let nearest = select(q, p, p.x <= q.x);
  var edgeBlend = 0.0;
  if ((nearest.y >= 0.0) != (m - edgeLuma >= 0.0)) { edgeBlend = 0.5 - nearest.x / (p.x + q.x); }
  return deepSpatialAaSample(uv + normalStep * max(pixelBlend, edgeBlend));
}
"#;

/// Present 包装:binding 0 显示域源纹理 + binding 1 filtering sampler,
/// 全屏三角;面向 unorm 目标直接写显示编码值(源纹理不得是 sRGB 格式——
/// 硬件自动解码会破坏域,与 TS `SPATIAL_AA_PRESENT_WGSL` 同一约束)。
pub const SPATIAL_AA_PRESENT_WGSL: &str = r#"
@group(0) @binding(0) var spatialSource: texture_2d<f32>;
@group(0) @binding(1) var spatialSampler: sampler;
fn deepSpatialAaSample(uv: vec2f) -> vec4f { return textureSampleLevel(spatialSource, spatialSampler, uv, 0.0); }
fn deepSpatialAaTexel() -> vec2f { return 1.0 / vec2f(textureDimensions(spatialSource)); }
"#;

/// 组装好的 present 着色器(包装 + 核 + 顶点/片段入口)。
pub fn spatial_aa_shader() -> String {
    let mut shader = String::from(SPATIAL_AA_PRESENT_WGSL);
    shader.push_str(SPATIAL_AA_WGSL);
    shader.push_str(
        r#"
struct SpatialVertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertex_main(@builtin(vertex_index) i: u32) -> SpatialVertex {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var v: SpatialVertex; v.position = vec4f(positions[i], 0.0, 1.0);
  v.uv = positions[i] * vec2f(0.5, -0.5) + 0.5; return v;
}
@fragment fn fragment_main(v: SpatialVertex) -> @location(0) vec4f { return deepSpatialAa(v.uv); }
"#,
    );
    shader
}

/// 全屏 FXAA 渲染管线(unorm 目标;生产接线切片如需 sRGB 目标,
/// 追加线性化入口而非静默双重编码)。
pub fn create_spatial_aa_pipeline(
    device: &wgpu::Device,
    target_format: wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Deep Engine native spatial AA (FXAA) shader"),
        source: wgpu::ShaderSource::Wgsl(spatial_aa_shader().into()),
    });
    let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native spatial AA bind layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    });
    let real_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Deep Engine native spatial AA pipeline layout (bound)"),
        bind_group_layouts: &[Some(&bind_layout)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Deep Engine native spatial AA pipeline"),
        layout: Some(&real_layout),
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vertex_main"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
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

/// CPU 参考输入:显示编码 RGBA,行主序,length = width*height*4。
pub struct SpatialAaImage<'a> {
    pub width: u32,
    pub height: u32,
    pub color: &'a [f32],
}

/// CPU 镜像(f64 中间域、f32 输出):与 TS `resolveSpatialAaCpu` 逐式同构——
/// 输入校验(尺寸/长度/有限 [0,1])、双线性钳位采样、luma 0.3/0.59/0.11、
/// 6 步搜索阶梯、edge/pixel blend 与方向判定全部按 TS 表达式顺序。
pub fn resolve_spatial_aa_cpu(image: &SpatialAaImage<'_>) -> Result<Vec<f32>, String> {
    let width = image.width as usize;
    let height = image.height as usize;
    if width < 1
        || height < 1
        || width * height > 16_777_216
        || image.color.len() != width * height * 4
    {
        return Err("Invalid spatial AA image dimensions.".to_string());
    }
    if image
        .color
        .iter()
        .any(|&value| !value.is_finite() || !(0.0..=1.0).contains(&value))
    {
        return Err("Spatial AA requires finite display-encoded RGBA inside [0, 1].".to_string());
    }
    let clamp = |n: isize, lo: isize, hi: isize| n.max(lo).min(hi);
    // 双线性钳位采样(逐分量 f64,与 TS sample() 同序)。
    let sample = |x: f64, y: f64| -> [f64; 4] {
        let bx = x.floor();
        let by = y.floor();
        let fx = x - bx;
        let fy = y - by;
        let mut result = [0.0f64; 4];
        for j in 0..2i64 {
            for i in 0..2i64 {
                let px = clamp(bx as isize + i as isize, 0, width as isize - 1) as usize;
                let py = clamp(by as isize + j as isize, 0, height as isize - 1) as usize;
                let p = (py * width + px) * 4;
                let weight =
                    (if i != 0 { fx } else { 1.0 - fx }) * (if j != 0 { fy } else { 1.0 - fy });
                for (c, channel) in result.iter_mut().enumerate() {
                    *channel += f64::from(image.color[p + c]) * weight;
                }
            }
        }
        result
    };
    let luma = |x: f64, y: f64| -> f64 {
        let c = sample(x, y);
        c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11
    };
    let steps: [f64; 6] = [1.0, 1.5, 2.0, 2.0, 2.0, 4.0];
    let mut output = vec![0.0f32; image.color.len()];
    for y in 0..height {
        for x in 0..width {
            let xf = f64::from(x as u32);
            let yf = f64::from(y as u32);
            let m = luma(xf, yf);
            let n = luma(xf, yf + 1.0);
            let e = luma(xf + 1.0, yf);
            let s = luma(xf, yf - 1.0);
            let w = luma(xf - 1.0, yf);
            let high = m.max(n).max(e).max(s).max(w);
            let contrast = high - m.min(n).min(e).min(s).min(w);
            let out_index = (y * width + x) * 4;
            if contrast < 0.0312f64.max(0.063 * high) {
                output[out_index..out_index + 4]
                    .copy_from_slice(&image.color[out_index..out_index + 4]);
                continue;
            }
            let ne = luma(xf + 1.0, yf + 1.0);
            let nw = luma(xf - 1.0, yf + 1.0);
            let se = luma(xf + 1.0, yf - 1.0);
            let sw = luma(xf - 1.0, yf - 1.0);
            let f = (((2.0 * (n + e + s + w) + ne + nw + se + sw) / 12.0 - m).abs() / contrast)
                .clamp(0.0, 1.0);
            let smooth = f * f * (3.0 - 2.0 * f);
            let pixel_blend = smooth * smooth;
            let horizontal = (n + s - 2.0 * m).abs() * 2.0
                + (ne + se - 2.0 * e).abs()
                + (nw + sw - 2.0 * w).abs()
                >= (e + w - 2.0 * m).abs() * 2.0
                    + (ne + nw - 2.0 * n).abs()
                    + (se + sw - 2.0 * s).abs();
            let (positive, negative) = if horizontal { (n, s) } else { (e, w) };
            let sign: f64 = if (positive - m).abs() < (negative - m).abs() {
                -1.0
            } else {
                1.0
            };
            let opposite = if sign < 0.0 { negative } else { positive };
            let threshold = (opposite - m).abs() * 0.25;
            let edge_luma = (m + opposite) * 0.5;
            let edge_x = xf + if horizontal { 0.0 } else { sign * 0.5 };
            let edge_y = yf + if horizontal { sign * 0.5 } else { 0.0 };
            let search = |direction: f64| -> (f64, f64) {
                let mut distance = 0.0;
                let mut delta = 0.0;
                let mut found = false;
                for step in steps {
                    distance += step;
                    delta = luma(
                        edge_x
                            + if horizontal {
                                direction * distance
                            } else {
                                0.0
                            },
                        edge_y
                            + if horizontal {
                                0.0
                            } else {
                                direction * distance
                            },
                    ) - edge_luma;
                    if delta.abs() >= threshold {
                        found = true;
                        break;
                    }
                }
                if !found {
                    distance += 8.0;
                }
                (distance, delta)
            };
            let p = search(1.0);
            let q = search(-1.0);
            let nearest = if p.0 <= q.0 { p } else { q };
            let edge_blend = if (nearest.1 >= 0.0) == (m - edge_luma >= 0.0) {
                0.0
            } else {
                0.5 - nearest.0 / (p.0 + q.0)
            };
            let blend = pixel_blend.max(edge_blend);
            let blended = sample(
                xf + if horizontal { 0.0 } else { sign * blend },
                yf + if horizontal { sign * blend } else { 0.0 },
            );
            for c in 0..4 {
                output[out_index + c] = blended[c] as f32;
            }
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成边缘图(4 宽 2 高):左半暗右半亮,触发 FXAA 边缘分支。
    fn edge_image() -> Vec<f32> {
        let mut color = Vec::new();
        for _y in 0..2u32 {
            for x in 0..4u32 {
                let value = if x < 2 { 0.25f32 } else { 0.75f32 };
                color.extend_from_slice(&[value, value, value, 1.0]);
            }
        }
        color
    }

    /// 校验拒绝族与 TS resolveSpatialAaCpu 抛错同形。
    #[test]
    fn rejects_invalid_images() {
        let color = edge_image();
        assert!(
            resolve_spatial_aa_cpu(&SpatialAaImage {
                width: 0,
                height: 2,
                color: &color
            })
            .is_err()
        );
        assert!(
            resolve_spatial_aa_cpu(&SpatialAaImage {
                width: 4,
                height: 2,
                color: &color[..7]
            })
            .is_err()
        );
        let mut nan = color.clone();
        nan[0] = f32::NAN;
        assert!(
            resolve_spatial_aa_cpu(&SpatialAaImage {
                width: 4,
                height: 2,
                color: &nan
            })
            .is_err()
        );
        let mut over = color.clone();
        over[1] = 1.5;
        assert!(
            resolve_spatial_aa_cpu(&SpatialAaImage {
                width: 4,
                height: 2,
                color: &over
            })
            .is_err()
        );
    }

    /// 边缘行做 FXAA 混合(过渡像素被推向均值),非边缘像素与输入一致;
    /// 同输入下 CPU 镜像确定性(两次调用逐位相同)。
    #[test]
    fn blends_edge_transition_and_keeps_uniform_regions() {
        let color = edge_image();
        let output = resolve_spatial_aa_cpu(&SpatialAaImage {
            width: 4,
            height: 2,
            color: &color,
        })
        .unwrap();
        assert_eq!(output.len(), color.len());
        // 均匀内部像素(x=0、x=3)无边缘 → 原样。
        for x in [0usize, 3] {
            for y in 0..2usize {
                let i = (y * 4 + x) * 4;
                for c in 0..4 {
                    assert!(
                        (output[i + c] - color[i + c]).abs() < 1e-6,
                        "px({x},{y}) ch{c}"
                    );
                }
            }
        }
        // 过渡像素(x=1/x=2)的 luma 被拉向边缘两侧均值(混合幅度 > 0)。
        let luma = |px: usize| {
            let i = px * 4;
            f64::from(output[i]) * 0.3
                + f64::from(output[i + 1]) * 0.59
                + f64::from(output[i + 2]) * 0.11
        };
        assert!(luma(1) > 0.25, "dark side of edge must lift: {}", luma(1));
        assert!(luma(2) < 0.75, "bright side of edge must drop: {}", luma(2));
        let again = resolve_spatial_aa_cpu(&SpatialAaImage {
            width: 4,
            height: 2,
            color: &color,
        })
        .unwrap();
        assert_eq!(output, again);
    }

    /// TS 逐位 golden:常量来自真实 TS `resolveSpatialAaCpu` 运行输出
    /// (node type-stripping;f64 中间域 → Float32Array 舍入与本实现同规),
    /// 以 f32 位型逐位对拍——公式/顺序漂移即红。
    #[test]
    fn matches_ts_reference_bit_exact() {
        let color = edge_image();
        let output = resolve_spatial_aa_cpu(&SpatialAaImage {
            width: 4,
            height: 2,
            color: &color,
        })
        .unwrap();
        // TS 输出(两行同):[0.25×4, blend_dark×4, blend_bright×4, 0.75×4];
        // blend_dark = 0x3e913507, blend_bright = 0x3f37657d, alpha = 0x3f800000。
        let expected_bits: [u32; 16] = [
            0x3e800000, 0x3e800000, 0x3e800000, 0x3f800000, 0x3e913507, 0x3e913507, 0x3e913507,
            0x3f800000, 0x3f37657d, 0x3f37657d, 0x3f37657d, 0x3f800000, 0x3f400000, 0x3f400000,
            0x3f400000, 0x3f800000,
        ];
        let output_bits: Vec<u32> = output.iter().map(|v| v.to_bits()).collect();
        assert_eq!(
            output_bits,
            [expected_bits.as_slice(), expected_bits.as_slice()].concat()
        );
    }
}
