//! native 内置地面/网格预览(ground-preview 能力行 native 缺位补齐)。
//!
//! 仲裁基准是 Web 端 ground 契约的三处单源,逐式镜像:
//! - 网格因子:`pbrShader.ts` shade() 内 ground 分支——格距 2.4 世界单位、
//!   `abs(fract(world.xz/2.4 − 0.5) − 0.5)` 三角波距离、径向衰减
//!   `exp(−length(world.xz)·0.06)`、总强度 `frame.floor.w`;
//! - 反照率调制:`pbrGroundAlbedo.ts::groundGridAlbedo`(对比度 0.32,
//!   `base + base·(1−base)·contrast`,有限域钳制,ground=false 直通);
//! - 预览平面:`primitives.ts::groundMesh`——y=0 平面 [-1,1]² 双三角,
//!   生产按 `pbrFrameUniforms.ts` groundMatrix 缩放 extent·8、y 偏移 −0.02。
//!
//! 域偏离(如实声明):TS 网格距离归一用 GPU 屏幕空间导数 `fwidth(...)`,
//! CPU 镜像不可复现;native 把它显式化为 uniform `footprint`(世界单位/像素,
//! CPU 侧由相机几何解析计算,GPU 侧生产接线时由该 uniform 供给,探针测试
//! 以正交相机解析值喂入)。公式形状与其余系数与 TS 逐式同构,数值由
//! TS 金样(纯算术 → f64 逐位)与真机 GPU readback(tests/ground_preview_gpu.rs)
//! 双向钉死。
//!
//! 登记口径(J4):native ground-preview = supported/harness-only——CPU 镜像
//! 逐位对拍 + WGSL 核真机 GPU 对拍,生产 forward pass 的地面实例接线
//! (mesh_pass 地面 quad + 深度测试)为后继切片。

/// 网格反照率调制核(与 TS `GROUND_ALBEDO_WGSL` 逐行同构)。
pub const GROUND_ALBEDO_WGSL: &str = r#"
fn groundGridAlbedo(baseInput: vec3f, grid: f32, ground: bool) -> vec3f {
  let base = clamp(baseInput, vec3f(0.0), vec3f(1.0));
  let contrast = 0.32 * clamp(grid, 0.0, 1.0);
  return select(baseInput, base + base * (vec3f(1.0) - base) * contrast, ground);
}
"#;

/// 地面预览核:网格因子(footprint 显式化偏离见模块头)+ 反照率调制。
/// 与 TS `pbrShader.ts` ground 分支逐式同构(格距 2.4、衰减 0.06、对比度 0.32)。
pub const GROUND_PREVIEW_WGSL: &str = r#"
fn deepGroundGridFactor(worldXZ: vec2f, intensity: f32, footprint: f32) -> f32 {
  if (intensity <= 0.0) { return 0.0; }
  let cell = worldXZ / 2.4;
  let gridDistance = abs(fract(cell - 0.5) - 0.5) / max(vec2f(footprint), vec2f(0.0001));
  return (1.0 - min(min(gridDistance.x, gridDistance.y), 1.0)) * exp(-length(worldXZ) * 0.06) * intensity;
}
"#;

/// 组装好的地面预览着色器(uniform 0:viewProjection + base/intensity/plane;
/// 顶点自生成 [-1,1]² 双三角 y=0 平面,与 TS groundMesh 拓扑一致)。
pub fn ground_preview_shader() -> String {
    let mut shader = String::from(
        r#"
struct GroundUniforms {
  viewProjection: mat4x4f, // 列主序世界→剪裁
  baseGrid: vec4f,         // xyz = 地面基色(线性), w = 网格总强度(frame.floor.w)
  plane: vec4f,            // x = footprint(世界单位/像素), y = 平面高度, z = quad 半边长, w 备用
};
@group(0) @binding(0) var<uniform> ground: GroundUniforms;
"#,
    );
    shader.push_str(GROUND_ALBEDO_WGSL);
    shader.push_str(GROUND_PREVIEW_WGSL);
    shader.push_str(
        r#"
struct GroundVertex { @builtin(position) position: vec4f, @location(0) worldXZ: vec2f };
@vertex fn vertex_main(@builtin(vertex_index) i: u32) -> GroundVertex {
  let corner = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0))[i];
  let world = vec3f(corner.x * ground.plane.z, ground.plane.y, corner.y * ground.plane.z);
  var v: GroundVertex;
  v.position = ground.viewProjection * vec4f(world, 1.0);
  v.worldXZ = world.xz;
  return v;
}
@fragment fn fragment_main(v: GroundVertex) -> @location(0) vec4f {
  let grid = deepGroundGridFactor(v.worldXZ, ground.baseGrid.w, ground.plane.x);
  let albedo = groundGridAlbedo(ground.baseGrid.rgb, grid, true);
  return vec4f(albedo, 1.0);
}
"#,
    );
    shader
}

/// 地面预览 uniform 打包(96 B,repr(C),与 WGSL `GroundUniforms` 逐槽对齐)。
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GroundPreviewUniforms {
    /// 列主序 viewProjection(mat4x4f = 64 B,wgpu 列主序惯例)。
    pub view_projection: [[f32; 4]; 4],
    /// xyz = 基色(线性),w = 网格总强度。
    pub base_grid: [f32; 4],
    /// x = footprint,y = 平面高度,z = quad 半边长,w 备用。
    pub plane: [f32; 4],
}

/// 网格因子 CPU 镜像(TS `pbrShader.ts` ground 分支逐式同构,f64 域;
/// `footprint` 即 TS 侧 `fwidth(world.xz/2.4)` 的显式化)。
pub fn ground_grid_factor_cpu(world_x: f64, world_z: f64, intensity: f64, footprint: f64) -> f64 {
    if intensity <= 0.0 {
        return 0.0;
    }
    let fract = |v: f64| v - v.floor();
    let cell_x = world_x / 2.4;
    let cell_z = world_z / 2.4;
    let distance_x = (fract(cell_x - 0.5) - 0.5).abs() / footprint.max(1e-4);
    let distance_z = (fract(cell_z - 0.5) - 0.5).abs() / footprint.max(1e-4);
    (1.0 - distance_x.min(distance_z).min(1.0))
        * (-(world_x * world_x + world_z * world_z).sqrt() * 0.06).exp()
        * intensity
}

/// 网格反照率 CPU 镜像(TS `groundGridAlbedo` 逐式同构,纯算术逐位)。
pub fn ground_grid_albedo_cpu(base: [f64; 3], grid: f64, ground: bool) -> Result<[f64; 3], String> {
    if ![base[0], base[1], base[2], grid]
        .iter()
        .all(|v| v.is_finite())
    {
        return Err("Ground albedo and grid must be finite.".to_string());
    }
    if !ground {
        return Ok(base);
    }
    let contrast = 0.32 * grid.clamp(0.0, 1.0);
    Ok(base.map(|input| {
        let value = input.clamp(0.0, 1.0);
        value + value * (1.0 - value) * contrast
    }))
}

/// 全屏地面预览渲染管线(线性 HDR/浮点目标;无深度——预览参考平面,
/// 生产接线切片由 forward pass 以 less-equal 深度并入)。
pub fn create_ground_preview_pipeline(
    device: &wgpu::Device,
    target_format: wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Deep Engine native ground preview shader"),
        source: wgpu::ShaderSource::Wgsl(ground_preview_shader().into()),
    });
    let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native ground preview bind layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: Some(
                    std::num::NonZeroU64::new(std::mem::size_of::<GroundPreviewUniforms>() as u64)
                        .expect("non-zero uniform size"),
                ),
            },
            count: None,
        }],
    });
    let real_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Deep Engine native ground preview pipeline layout (bound)"),
        bind_group_layouts: &[Some(&bind_layout)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Deep Engine native ground preview pipeline"),
        layout: Some(&real_layout),
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vertex_main"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState {
            cull_mode: None, // TS groundMesh 双面(cullMode none),同构
            ..Default::default()
        },
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

#[cfg(test)]
mod tests {
    use super::*;

    fn bits(value: f64) -> u64 {
        value.to_bits()
    }

    fn assert_bit(value: f64, expected_hex: &str, what: &str) {
        assert_eq!(
            format!("{:016x}", bits(value)),
            expected_hex,
            "bit drift on {what}"
        );
    }

    /// 反照率调制纯算术逐位(TS vitest 金样;采集场景写死在断言里)。
    #[test]
    fn ground_albedo_is_bit_exact_against_ts() {
        let mid = ground_grid_albedo_cpu([0.5, 0.5, 0.5], 0.5, true).expect("valid");
        assert_bit(mid[0], "3fe147ae147ae148", "mid_half r");
        let over = ground_grid_albedo_cpu([1.2, -0.1, 0.7], 0.8, true).expect("valid");
        assert_bit(over[0], "3ff0000000000000", "over r clamp");
        assert_bit(over[1], "0000000000000000", "over g clamp");
        assert_bit(over[2], "3fe81ecd4aa10e02", "over b modulation");
        let dark = ground_grid_albedo_cpu([0.02, 0.02, 0.02], 1.0, true).expect("valid");
        assert_bit(dark[0], "3f9ae70c1333b96b", "dark line lift");
        // f32 词与 TS Float32Array 舍入一致(0.54 → 3f0a3d71)。
        assert_eq!((mid[0] as f32).to_bits(), 0x3f0a3d71, "f32 rounding parity");
        // ground=false 直通;NaN fail-closed。
        assert_eq!(
            ground_grid_albedo_cpu([0.3, 0.6, 0.9], 0.9, false).expect("valid"),
            [0.3, 0.6, 0.9]
        );
        assert!(ground_grid_albedo_cpu([f64::NAN, 0.5, 0.5], 0.5, true).is_err());
        assert!(ground_grid_albedo_cpu([0.5, 0.5, 0.5], f64::INFINITY, true).is_err());
    }

    /// 网格因子逐位(TS 金样,显式 footprint 口径;exp/sqrt 哨兵
    /// ——on_line/off_grid 含 exp 与 sqrt,以 1e-9 相对复核)。
    #[test]
    fn grid_factor_matches_ts_golden() {
        let on_line = ground_grid_factor_cpu(2.4, 0.0, 1.0, 0.01);
        let expected = f64::from_bits(u64::from_str_radix("3febb55a38fd7be3", 16).unwrap());
        assert!(
            (on_line - expected).abs() / expected < 1e-9,
            "on_line {on_line}"
        );
        let near_line = ground_grid_factor_cpu(0.02, 0.05, 1.0, 0.01);
        let expected = f64::from_bits(u64::from_str_radix("3fc543b7384c07db", 16).unwrap());
        assert!(
            (near_line - expected).abs() / expected < 1e-9,
            "near_line {near_line}"
        );
        let half = ground_grid_factor_cpu(0.01, 0.0, 0.5, 0.05);
        let expected = f64::from_bits(u64::from_str_radix("3fdffb161611fb3b", 16).unwrap());
        assert!(
            (half - expected).abs() / expected < 1e-9,
            "half_intensity {half}"
        );
        let center = ground_grid_factor_cpu(0.0, 0.0, 1.0, 0.02);
        assert_bit(center, "3ff0000000000000", "center peak");
        let off = ground_grid_factor_cpu(0.6, 1.2, 1.0, 0.01);
        assert_bit(off, "0000000000000000", "far fades to zero");
        // 强度 ≤ 0 短路(TS if 分支同构)。
        assert_eq!(ground_grid_factor_cpu(0.01, 0.0, 0.0, 0.01), 0.0);
    }

    /// 物理哨兵:格点峰值=1·exp(−r·0.06)·强度;远离格线归零;
    /// 径向衰减单调;确定性(同输入逐位同输出)。
    #[test]
    fn grid_factor_physical_sentinels_hold() {
        let near = ground_grid_factor_cpu(0.005, 0.0, 1.0, 0.01);
        let far = ground_grid_factor_cpu(5.0, 5.0, 1.0, 0.01);
        assert!(
            near > far,
            "radial falloff must be monotone: {near} vs {far}"
        );
        let peak = ground_grid_factor_cpu(0.0, 2.4, 1.0, 1e-6);
        let expected = (-2.4_f64 * 0.06).exp();
        assert!(
            (peak - expected).abs() / expected < 1e-9,
            "peak = exp(-0.144): {peak}"
        );
        assert_eq!(
            near,
            ground_grid_factor_cpu(0.005, 0.0, 1.0, 0.01),
            "determinism"
        );
    }

    /// 正交相机解析 footprint:顶视相机覆盖 extent·2、N 像素宽 →
    /// footprint = cell 内世界跨度/2.4(供 GPU 探针与生产接线同式)。
    #[test]
    fn analytic_footprint_helper_is_consistent() {
        let extent = 8.0_f64;
        let pixels = 64.0_f64;
        let footprint = (2.0 * extent / pixels) / 2.4;
        assert!((footprint - 0.10416666666666667).abs() < 1e-12);
        // 顶视格点中心(0,0)在解析 footprint 下仍为亮格点。
        let center = ground_grid_factor_cpu(0.0, 0.0, 1.0, footprint);
        assert!(
            (center - 1.0).abs() < 1e-9,
            "grid center stays bright: {center}"
        );
    }

    /// uniform 打包布局槽位核对(96 B,与 WGSL GroundUniforms 逐槽一致)。
    #[test]
    fn draw_uniforms_pack_slot_aligned() {
        let mut view_projection = [[0.0f32; 4]; 4];
        view_projection[0] = [0.1, 0.0, 0.0, 0.0];
        view_projection[3] = [0.0, 0.0, 0.0, 1.0];
        let uniforms = GroundPreviewUniforms {
            view_projection,
            base_grid: [0.9, 0.9, 0.92, 1.0],
            plane: [0.26, -0.02, 64.0, 0.0],
        };
        assert_eq!(uniforms.base_grid[3], 1.0);
        assert_eq!(uniforms.plane[1], -0.02);
        assert_eq!(std::mem::size_of::<GroundPreviewUniforms>(), 96);
    }

    /// WGSL 单源结构守门:TS 同款常数/公式形状必须在文本中存在,
    /// 防止单源漂移(真机数值对拍在 tests/ground_preview_gpu.rs)。
    #[test]
    fn wgsl_core_mirrors_ts_formula_shape() {
        let shader = ground_preview_shader();
        assert!(shader.contains("worldXZ / 2.4"), "grid spacing 2.4");
        assert!(
            shader.contains("abs(fract(cell - 0.5) - 0.5)"),
            "triangular distance"
        );
        assert!(
            shader.contains("exp(-length(worldXZ) * 0.06)"),
            "radial falloff 0.06"
        );
        assert!(
            shader.contains("0.32 * clamp(grid, 0.0, 1.0)"),
            "albedo contrast 0.32"
        );
        assert!(
            shader.contains("base + base * (vec3f(1.0) - base) * contrast"),
            "modulation form"
        );
        assert!(
            shader.contains("vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)"),
            "quad topology"
        );
        assert!(
            shader.contains("@fragment fn fragment_main"),
            "entry points"
        );
        assert!(
            GROUND_PREVIEW_WGSL.contains("max(vec2f(footprint), vec2f(0.0001))"),
            "footprint floor 1e-4"
        );
    }
}
