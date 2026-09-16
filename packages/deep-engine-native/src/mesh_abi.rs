pub const MESH_ABI_ID: &str = "deep.pbr.mesh.v1";

pub const FRAME_UNIFORM_FLOATS: usize = 52;
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
pub const MATERIAL_UNIFORM_FLOATS: usize = 40;
pub const MATERIAL_UNIFORM_BYTES: u64 = (MATERIAL_UNIFORM_FLOATS * size_of::<f32>()) as u64;

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

    [
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
    ]
}

pub fn frame_uniform_with_fog(aspect: f32, yaw: f32, fog: crate::fog::FogSettings) -> FrameUniform {
    let mut frame = frame_uniform(aspect, yaw);
    frame[12] = fog.frame_tuning();
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
    fn color_stream_abi_is_frozen() {
        assert_eq!(COLOR_VERTEX_FLOATS, 4);
        assert_eq!(COLOR_VERTEX_BYTES, 16);
        assert_eq!(COLOR_VERTEX_ATTRIBUTES.len(), 1);
        assert_eq!(COLOR_VERTEX_ATTRIBUTES[0].shader_location, 16);
        assert_eq!(COLOR_VERTEX_ATTRIBUTES[0].format, VertexFormat::Float32x4);
        assert_eq!(COLOR_VERTEX_ATTRIBUTES[0].offset, 0);
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
