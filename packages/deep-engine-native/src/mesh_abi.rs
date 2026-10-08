pub const MESH_ABI_ID: &str = "deep.pbr.mesh.v1";
/// Stock material ABI v5 names normalColumn0.w; legacy custom ABI remains v1.
pub const STOCK_MATERIAL_ABI_ID: &str = "deep.pbr.mesh.v5";
pub const MATERIAL_IOR_FLOAT_OFFSET: usize = 15;

/// 只追加灯光参数；旧 v1/v2/v3 成员偏移保持不变。
/// Native frame v8 keeps the published camera/material prefix and expands local-shadow
/// storage to the product 16-light budget. The shader mirrors use the same row order:
/// 15 fixed rows + 16 local lights + 16 shadow matrices + fog projection + 4 softness
/// rows + fog profile.
pub const FRAME_ABI_ID: &str = "deep.native.frame.v8";
pub const FRAME_V1_BYTES: u64 = 208;
pub const FRAME_LOCAL_LIGHTS: usize = 16;
pub const FRAME_LOCAL_SHADOW_VIEWS: usize = 16;
pub const FRAME_LOCAL_SOFTNESS_LIGHTS: usize = 16;
/// J2-B7-migrate：总量切换到 schema 单源生成常量（parity 门见 frame_layout_gate.rs）。
pub const FRAME_UNIFORM_FLOATS: usize = crate::frame_layout_generated::FRAME_ABI_RUST_FLOATS;
pub const FRAME_FOG_PROJECTION_ROW: usize = 143;
pub const FRAME_LOCAL_SOFTNESS_ROW: usize = 144;
pub const FRAME_FOG_PROFILE_ROW: usize = 148;
pub const FRAME_UNIFORM_BYTES: u64 = (FRAME_UNIFORM_FLOATS * size_of::<f32>()) as u64;
pub const FRAME_MEMBER_BYTE_OFFSETS: [u64; 7] = [0, 64, 128, 144, 160, 176, 192];
pub type FrameUniform = [[f32; 4]; FRAME_UNIFORM_FLOATS / 4];
pub const FORWARD_COLOR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
pub const FORWARD_DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;
pub const FORWARD_SAMPLE_COUNT: u32 = 4;
pub const FORWARD_RESOLVE_REQUIRED: bool = true;
pub const SHADOW_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
pub const SHADOW_MAP_SIZE: u32 = 2_048;
pub const CAMERA_NEAR: f32 = 0.1;
pub const CAMERA_FAR: f32 = 100.0;
pub const CAMERA_FOCAL: f32 = 2.05;

pub const GEOMETRY_VERTEX_FLOATS: usize = 10;
pub const GEOMETRY_VERTEX_BYTES: wgpu::BufferAddress =
    (GEOMETRY_VERTEX_FLOATS * size_of::<f32>()) as wgpu::BufferAddress;
pub const TANGENT_VERTEX_FLOATS: usize = 4;
pub const TANGENT_VERTEX_BYTES: wgpu::BufferAddress =
    (TANGENT_VERTEX_FLOATS * size_of::<f32>()) as wgpu::BufferAddress;
/// DE26/C02 冻结的可选顶点色流：线性 RGBA f32，独立 vertex buffer；
/// 无颜色几何不产生该 buffer，旧 40B 顶点流布局逐字节不变。
pub const COLOR_VERTEX_FLOATS: usize = 4;
pub const COLOR_VERTEX_BYTES: wgpu::BufferAddress =
    (COLOR_VERTEX_FLOATS * size_of::<f32>()) as wgpu::BufferAddress;
pub const PACKED_INSTANCE_FLOATS: usize = 36;
pub const PACKED_INSTANCE_BYTES: wgpu::BufferAddress =
    (PACKED_INSTANCE_FLOATS * size_of::<f32>()) as wgpu::BufferAddress;
/// 材质 uniform 扩展带边界(T08/C9):核心块 40 float(legacy 逐字节不变)之上,
/// 40..46 消费 Web `packExtendedParameterBlock` 的 6 float,顺序 =
/// MATERIAL_PARAMETER_KEYS(ior, clearcoatFactor, clearcoatRoughness,
/// anisotropyStrength, anisotropyRotation, transmissionFactor)。native 求值子集
/// 只消费 ior+clearcoat;anisotropy/transmission 槽由合同 fail-closed 拒绝非零
/// (contract::validate),槽位仍占位以保持与 Web 192B 打包带同序。
pub const MATERIAL_UNIFORM_FLOATS: usize = 46;
/// 材质行 / GPU uniform 总 float:46 上取 16B 对齐到 48 + advanced 带 12(48..60,
/// 与 Web MATERIAL_PARAMETER_ADVANCED_FLOATS=60 布局同构)。native 保守子集只消费
/// advanced0 = sheen.rgb + sheen.roughness;iridescence/volume 槽(52..60)由合同
/// 保持零。扩展/advanced 带全零 → WGSL 走原 stock 分支,旧包逐位不变。
pub const MATERIAL_UNIFORM_ROW_FLOATS: usize = 80;
pub const MATERIAL_EXTENDED_BAND_FLOAT_OFFSET: usize = 40;
pub const MATERIAL_ADVANCED_BAND_FLOAT_OFFSET: usize = 48;
pub const MATERIAL_ADVANCED_BAND_FLOATS: usize = 12;
/// GPU minimum:320B (20 vec4 rows), preserving the old 240B prefix.
pub const MATERIAL_UNIFORM_BYTES: u64 = (MATERIAL_UNIFORM_ROW_FLOATS * size_of::<f32>()) as u64;
/// 材质 uniform 行类型(PreparedMaterial/GPU 上传/增量更新共用)。
pub type MaterialUniformRow = [f32; MATERIAL_UNIFORM_ROW_FLOATS];

pub const GEOMETRY_VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 4] =
    wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 10 => Float32x2, 13 => Float32x2];
pub const INSTANCE_VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 9] = wgpu::vertex_attr_array![
    2 => Float32x4, 3 => Float32x4, 4 => Float32x4, 5 => Float32x4,
    6 => Float32x4, 7 => Float32x4, 8 => Float32x4, 9 => Float32x4, 12 => Float32x4
];
pub const TANGENT_VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 1] =
    wgpu::vertex_attr_array![11 => Float32x4];
pub const COLOR_VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 1] =
    wgpu::vertex_attr_array![16 => Float32x4];

/// 把可选颜色流打包为独立顶点 buffer 内容。无颜色流返回 `None`——调用方不创建
/// 颜色 buffer，旧无颜色包的 GPU 上传序列与旧 ABI 逐字节一致。
pub fn pack_color_vertices(
    colors: Option<&[f32]>,
    vertex_count: usize,
) -> Option<Vec<[f32; COLOR_VERTEX_FLOATS]>> {
    let colors = colors?;
    debug_assert_eq!(colors.len(), vertex_count * COLOR_VERTEX_FLOATS);
    Some(
        colors
            .chunks_exact(COLOR_VERTEX_FLOATS)
            .map(|color| [color[0], color[1], color[2], color[3]])
            .collect(),
    )
}

pub fn frame_uniform(aspect: f32, yaw: f32) -> FrameUniform {
    let aspect = aspect.max(0.01);
    let (sin_yaw, cos_yaw) = yaw.sin_cos();
    let near = CAMERA_NEAR;
    let far = CAMERA_FAR;
    let focal = CAMERA_FOCAL;
    let depth_scale = far / (far - near);
    let depth_offset = depth_scale * 4.0 - near * far / (far - near);
    let light = light_view_projection(yaw);

    let legacy = [
        [
            focal / aspect * cos_yaw,
            0.0,
            depth_scale * sin_yaw,
            sin_yaw,
        ],
        [0.0, focal, 0.0, 0.0],
        [
            focal / aspect * sin_yaw,
            0.0,
            -depth_scale * cos_yaw,
            -cos_yaw,
        ],
        [0.0, 0.0, depth_offset, 4.0],
        light[0],
        light[1],
        light[2],
        light[3],
        [-4.0 * sin_yaw, 0.0, 4.0 * cos_yaw, 1.0],
        [0.012, 0.020, 0.035, 1.0],
        [0.0, 0.0, 0.0, 1.0],
        [
            0.55 * cos_yaw - 0.35 * sin_yaw,
            0.8,
            0.55 * sin_yaw + 0.35 * cos_yaw,
            0.0,
        ],
        [0.0; 4],
        [0.0; 4],             // sunColor.w=0 保持旧包固定灯光；v2 作者灯光显式设为 2。
        [1.0, 1.0, 0.0, 0.0], // exposure、shadowEnabled，legacy 分支不读取。
    ];
    let mut frame = [[0.0; 4]; FRAME_UNIFORM_FLOATS / 4];
    frame[..15].copy_from_slice(&legacy);
    frame[FRAME_FOG_PROJECTION_ROW] = [near, far, 0.0, 0.0];
    frame
}

pub fn frame_uniform_with_fog(aspect: f32, yaw: f32, fog: crate::fog::FogSettings) -> FrameUniform {
    let mut frame = frame_uniform(aspect, yaw);
    frame[12] = fog.frame_tuning();
    frame[FRAME_FOG_PROJECTION_ROW] = fog.frame_projection(CAMERA_NEAR, CAMERA_FAR);
    frame[FRAME_FOG_PROFILE_ROW] = fog.frame_profile();
    frame
}

fn light_view_projection(yaw: f32) -> [[f32; 4]; 4] {
    let (sin_yaw, cos_yaw) = yaw.sin_cos();
    let eye = [
        3.3 * cos_yaw - 2.1 * sin_yaw,
        4.8,
        3.3 * sin_yaw + 2.1 * cos_yaw,
    ];
    multiply_matrix(
        [
            [1.0 / 3.5, 0.0, 0.0, 0.0],
            [0.0, 1.0 / 3.5, 0.0, 0.0],
            [0.0, 0.0, 1.0 / (0.1 - 18.0), 0.0],
            [0.0, 0.0, 0.1 / (0.1 - 18.0), 1.0],
        ],
        look_at(eye),
    )
}

fn look_at(eye: [f32; 3]) -> [[f32; 4]; 4] {
    let z = normalize(eye);
    let x = normalize(cross([0.0, 1.0, 0.0], z));
    let y = cross(z, x);
    [
        [x[0], y[0], z[0], 0.0],
        [x[1], y[1], z[1], 0.0],
        [x[2], y[2], z[2], 0.0],
        [-dot(x, eye), -dot(y, eye), -dot(z, eye), 1.0],
    ]
}

fn multiply_matrix(a: [[f32; 4]; 4], b: [[f32; 4]; 4]) -> [[f32; 4]; 4] {
    let mut out = [[0.0; 4]; 4];
    for column in 0..4 {
        for row in 0..4 {
            for k in 0..4 {
                out[column][row] += a[k][row] * b[column][k];
            }
        }
    }
    out
}

fn normalize(value: [f32; 3]) -> [f32; 3] {
    let length = dot(value, value).sqrt();
    [value[0] / length, value[1] / length, value[2] / length]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[cfg(test)]
mod tests {
    use super::{
        COLOR_VERTEX_ATTRIBUTES, COLOR_VERTEX_BYTES, COLOR_VERTEX_FLOATS, pack_color_vertices,
    };
    use wgpu::VertexFormat;

    #[test]
    fn softness_extension_defaults_to_zero_without_moving_legacy_fields() {
        use super::*;
        assert_eq!(FRAME_UNIFORM_BYTES, 2384);
        assert_eq!(FRAME_FOG_PROJECTION_ROW * 16, 2288);
        assert_eq!(FRAME_LOCAL_SOFTNESS_ROW * 16, 2304);
        let mut frame = frame_uniform(1.0, 0.0);
        assert_eq!(&frame[FRAME_LOCAL_SOFTNESS_ROW..FRAME_LOCAL_SOFTNESS_ROW + 4], &[[0.0; 4]; 4]);
        let lights: Vec<_> = (0..16)
            .map(|index| {
                serde_json::json!({
                    "kind":"spot", "position":[0,4,0], "direction":[0,-1,0],
                    "radiance":[1,1,1], "range":12, "decay":2,
                    "innerCos":0.9, "outerCos":0.7, "shadowSoftness":index as f32 / 15.0,
                    "castShadow":index < 4
                })
            })
            .collect();
        let lighting: crate::scene_lighting::DirectionalLighting = serde_json::from_value(serde_json::json!({
            "direction":[0,1,0], "radiance":[1,1,1], "exposure":1, "shadows":true,"localLights":lights
        })).unwrap();
        lighting.validate().unwrap().apply(&mut frame);
        for index in 0..16 {
            assert_eq!(
                frame[FRAME_LOCAL_SOFTNESS_ROW + index / 4][index % 4],
                index as f32 / 15.0
            );
            assert_eq!(
                frame[18 + index * 4][2],
                if index < 4 { (index + 1) as f32 } else { 0.0 }
            );
        }
    }

    #[test]
    fn color_stream_abi_is_frozen() {
        assert_eq!(COLOR_VERTEX_FLOATS, 4);
        assert_eq!(COLOR_VERTEX_BYTES, 16);
        assert_eq!(COLOR_VERTEX_ATTRIBUTES.len(), 1);
        assert_eq!(COLOR_VERTEX_ATTRIBUTES[0].shader_location, 16);
        assert_eq!(COLOR_VERTEX_ATTRIBUTES[0].format, VertexFormat::Float32x4);
        assert_eq!(COLOR_VERTEX_ATTRIBUTES[0].offset, 0);
    }

    /// C9/native 扩展带 ABI 钉版:核心块 40 float 语义不变,40..46 = Web 扩展带,
    /// The 320B row keeps the first 60 floats and appends two UV transforms and F0/F90 values.
    #[test]
    fn material_uniform_extension_band_abi_is_frozen() {
        use super::*;
        assert_eq!(MATERIAL_UNIFORM_FLOATS, 46);
        assert_eq!(MATERIAL_EXTENDED_BAND_FLOAT_OFFSET, 40);
        assert_eq!(MATERIAL_UNIFORM_ROW_FLOATS, 80);
        assert_eq!(MATERIAL_ADVANCED_BAND_FLOAT_OFFSET, 48);
        assert_eq!(MATERIAL_ADVANCED_BAND_FLOATS, 12);
        assert_eq!(MATERIAL_UNIFORM_BYTES, 320);
        // WGSL MaterialTextures is 20 aligned vec4 rows.
        assert_eq!(MATERIAL_UNIFORM_BYTES % 16, 0);
        // 扩展带与 advanced 带不重叠,advanced 带不越行界。
        assert!(MATERIAL_ADVANCED_BAND_FLOAT_OFFSET >= MATERIAL_UNIFORM_FLOATS);
        assert_eq!(
            MATERIAL_ADVANCED_BAND_FLOAT_OFFSET + MATERIAL_ADVANCED_BAND_FLOATS,
            60
        );
    }

    #[test]
    fn absent_color_stream_stays_absent() {
        assert!(pack_color_vertices(None, 3).is_none());
    }

    #[test]
    fn color_stream_roundtrips_per_vertex() {
        let colors = vec![
            0.0_f32, 0.25, 0.5, 1.0, 1.0, 0.0, 0.0, 0.5, 0.5, 1.0, 0.0, 0.25,
        ];
        let packed = pack_color_vertices(Some(&colors), 3).expect("colors must pack");
        assert_eq!(packed.len(), 3);
        assert_eq!(packed[0], [0.0, 0.25, 0.5, 1.0]);
        assert_eq!(packed[1], [1.0, 0.0, 0.0, 0.5]);
        assert_eq!(packed[2], [0.5, 1.0, 0.0, 0.25]);
        let bytes: Vec<u8> = packed
            .iter()
            .flat_map(|c| c.iter().flat_map(|v| v.to_le_bytes()))
            .collect();
        assert_eq!(bytes.len(), 3 * 16);
    }
}
