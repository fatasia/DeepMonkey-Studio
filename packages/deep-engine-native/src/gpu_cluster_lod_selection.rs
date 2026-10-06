//! Cluster LOD 选层 CPU 权威镜像(TS `rayTracing/clusterLodSelection.ts` 逐式同构;
//! Nanite 对标 native 运行时的仲裁基准腿)。
//!
//! == 语义合同(与 TS 单源逐项对应,禁止单侧改动) ==
//! 1. 节点 storage 布局:stride 64B/16 words,word 偏移见 [`ClusterLodNodeWord`]
//!    (boundsMin xyz+pad / boundsMax xyz+pad / errorScalar / lodLevel / clusterIndex /
//!    firstTriangle / triangleCount / pad0..2)。
//! 2. 相机 uniform 48B(12 words):camPos xyz / tanHalfFovY / forward xyz /
//!    pixelThreshold / viewportHeightPixels / nodeCount / pad0..1。
//! 3. 选层公式:depth = max(dot(center − camPos, forward), MIN_VIEW_DEPTH);
//!    screenError = error × viewportHeightPixels / (2 × depth × tanHalfFovY);
//!    selected = triangleCount > 0 且 screenError ≤ pixelThreshold。
//! 4. fail-closed:相机非法 / 误差非有限负值 / 包围盒非有限 / 误差单调性被破坏
//!    (parent 必须 dominate child)一律 [`ClusterLodSelectionError`],绝不静默降级。
//! 5. 绘制前沿:从根下钻,首个选中或叶子节点入 frontier(叶子区域恰好一次覆盖)。
//!
//! 对拍:TS 生成器(`generateClusterLodNativeParity.mts`)以生产 `selectClusterLod`
//! 出黄金 fixture(selection/screenErrors(f32 量化)/frontier 序列),本模块
//! `parity_tests` 位级对拍(f32 词逐字、u32 逐字、frontier 顺序一致)。

/// 节点 storage stride(字节);与 TS `CLUSTER_LOD_NODE_STRIDE_BYTES` 同源。
pub const CLUSTER_LOD_NODE_STRIDE_BYTES: usize = 64;
/// 节点 storage stride(words)。
pub const CLUSTER_LOD_NODE_STRIDE_WORDS: usize = 16;
/// 未选中(继续细化)哨兵;与 TS `CLUSTER_LOD_REFINE_SENTINEL` 同源。
pub const CLUSTER_LOD_REFINE_SENTINEL: u32 = 0xffff_ffff;
/// GPU 选层 workgroup 大小(compute 腿用);与 TS 同源。
pub const CLUSTER_LOD_SELECTION_WORKGROUP_SIZE: u32 = 64;
/// 相机 uniform 字节数。
pub const CLUSTER_LOD_CAMERA_UNIFORM_BYTES: usize = 48;
/// 缺省像素阈值。
pub const CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD: f64 = 1.0;
/// 最小视深度(除法下限)。
pub const CLUSTER_LOD_MIN_VIEW_DEPTH: f64 = 1e-6;

/// 节点 word 偏移(64B stride 内的 u32/f32 槽位)。
pub struct ClusterLodNodeWord;
#[allow(dead_code)]
impl ClusterLodNodeWord {
    pub const BOUNDS_MIN_X: usize = 0;
    pub const BOUNDS_MIN_Y: usize = 1;
    pub const BOUNDS_MIN_Z: usize = 2;
    pub const BOUNDS_MIN_PAD: usize = 3;
    pub const BOUNDS_MAX_X: usize = 4;
    pub const BOUNDS_MAX_Y: usize = 5;
    pub const BOUNDS_MAX_Z: usize = 6;
    pub const BOUNDS_MAX_PAD: usize = 7;
    pub const ERROR_SCALAR: usize = 8;
    pub const LOD_LEVEL: usize = 9;
    pub const CLUSTER_INDEX: usize = 10;
    pub const FIRST_TRIANGLE: usize = 11;
    pub const TRIANGLE_COUNT: usize = 12;
    pub const PAD0: usize = 13;
    pub const PAD1: usize = 14;
    pub const PAD2: usize = 15;
}

/// 相机 uniform word 偏移。
pub struct ClusterLodCameraWord;
#[allow(dead_code)]
impl ClusterLodCameraWord {
    pub const CAM_POS_X: usize = 0;
    pub const CAM_POS_Y: usize = 1;
    pub const CAM_POS_Z: usize = 2;
    pub const TAN_HALF_FOV_Y: usize = 3;
    pub const FORWARD_X: usize = 4;
    pub const FORWARD_Y: usize = 5;
    pub const FORWARD_Z: usize = 6;
    pub const PIXEL_THRESHOLD: usize = 7;
    pub const VIEWPORT_HEIGHT_PIXELS: usize = 8;
    pub const NODE_COUNT: usize = 9;
    pub const PAD0: usize = 10;
    pub const PAD1: usize = 11;
}

/// 选层相机(TS `ClusterLodCamera` 同构)。
#[derive(Clone, Debug, PartialEq)]
pub struct ClusterLodCamera {
    pub position: [f64; 3],
    /// 视轴(须归一)。
    pub forward: [f64; 3],
    pub viewport_height_pixels: f64,
    pub tan_half_fov_y: f64,
    pub pixel_threshold: f64,
}

/// 已序列化节点(从 64B stride 解出;对拍验证用)。
#[derive(Clone, Debug, PartialEq)]
pub struct SerializedClusterLodNode {
    pub error_scalar: f32,
    pub lod_level: u32,
    pub cluster_index: u32,
    pub first_triangle: u32,
    pub triangle_count: u32,
    pub min: [f32; 3],
    pub max: [f32; 3],
}

/// 选层输入节点(TS `ClusterLodNodeDescriptor` 同构;id 用于错误消息与 frontier)。
#[derive(Clone, Debug)]
pub struct ClusterLodNode {
    pub id: String,
    pub level: u32,
    pub error: f64,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
    pub first_triangle: u32,
    pub triangle_count: u32,
    pub children: Vec<String>,
}

/// 选层结果(TS `ClusterLodSelection` 同构)。
pub struct ClusterLodSelection {
    /// 每 cluster 节点槽位:选中层级索引或 [`CLUSTER_LOD_REFINE_SENTINEL`]。
    pub selection: Vec<u32>,
    /// 每节点投影屏幕误差(f32 量化,对拍用 fround 口径)。
    pub screen_errors: Vec<f32>,
    /// 绘制前沿(根下钻首个选中或叶子)。
    pub frontier: Vec<String>,
}

/// fail-closed 错误族(TS 抛错文本同语义)。
#[derive(Clone, Debug, PartialEq)]
pub enum ClusterLodSelectionError {
    CameraPositionNotFinite,
    CameraForwardNotFinite,
    CameraForwardZero,
    CameraViewportHeightInvalid,
    CameraTanHalfFovInvalid,
    CameraPixelThresholdInvalid,
    NodeErrorInvalid(String),
    NodeBoundsInvalid(String),
    UnknownChild { parent: String, child: String },
    MonotonicityViolated { parent: String, child: String },
}

impl core::fmt::Display for ClusterLodSelectionError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::CameraPositionNotFinite => write!(f, "Cluster LOD camera position must be 3 finite numbers."),
            Self::CameraForwardNotFinite => write!(f, "Cluster LOD camera forward must be 3 finite numbers."),
            Self::CameraForwardZero => write!(f, "Cluster LOD camera forward must be nonzero."),
            Self::CameraViewportHeightInvalid => write!(f, "Cluster LOD camera viewportHeightPixels must be finite and positive."),
            Self::CameraTanHalfFovInvalid => write!(f, "Cluster LOD camera tanHalfFovY must be finite and positive."),
            Self::CameraPixelThresholdInvalid => write!(f, "Cluster LOD camera pixelThreshold must be finite and positive."),
            Self::NodeErrorInvalid(id) => write!(f, "Cluster LOD node {id} error must be finite and nonnegative."),
            Self::NodeBoundsInvalid(id) => write!(f, "Cluster LOD node {id} bounds must be finite."),
            Self::UnknownChild { parent, child } => write!(f, "Cluster LOD node {parent} references unknown child {child}."),
            Self::MonotonicityViolated { parent, child } => {
                write!(f, "Cluster LOD error monotonicity violated at {parent} -> {child}: parent error must dominate.")
            }
        }
    }
}

fn all_finite(values: &[f64]) -> bool {
    values.iter().all(|value| value.is_finite())
}

/// 相机校验(TS `validateCamera` 同语义)。
pub fn validate_camera(camera: &ClusterLodCamera) -> Result<(), ClusterLodSelectionError> {
    if camera.position.len() != 3 || !all_finite(&camera.position) {
        return Err(ClusterLodSelectionError::CameraPositionNotFinite);
    }
    if camera.forward.len() != 3 || !all_finite(&camera.forward) {
        return Err(ClusterLodSelectionError::CameraForwardNotFinite);
    }
    let length = (camera.forward[0] * camera.forward[0]
        + camera.forward[1] * camera.forward[1]
        + camera.forward[2] * camera.forward[2])
        .sqrt();
    if !(length > 0.0) {
        return Err(ClusterLodSelectionError::CameraForwardZero);
    }
    if !camera.viewport_height_pixels.is_finite() || camera.viewport_height_pixels <= 0.0 {
        return Err(ClusterLodSelectionError::CameraViewportHeightInvalid);
    }
    if !camera.tan_half_fov_y.is_finite() || camera.tan_half_fov_y <= 0.0 {
        return Err(ClusterLodSelectionError::CameraTanHalfFovInvalid);
    }
    if !camera.pixel_threshold.is_finite() || camera.pixel_threshold <= 0.0 {
        return Err(ClusterLodSelectionError::CameraPixelThresholdInvalid);
    }
    Ok(())
}

/// 单节点投影屏幕误差(像素;f64,消费方落 f32 时按 TS Math.fround 口径)。
/// 与 WGSL kernel 表达式逐项对应,禁止单侧改动。
pub fn cluster_screen_error(
    bounds_min: [f64; 3],
    bounds_max: [f64; 3],
    error: f64,
    camera: &ClusterLodCamera,
) -> f64 {
    let center_x = (bounds_min[0] + bounds_max[0]) * 0.5;
    let center_y = (bounds_min[1] + bounds_max[1]) * 0.5;
    let center_z = (bounds_min[2] + bounds_max[2]) * 0.5;
    let axis_depth = (center_x - camera.position[0]) * camera.forward[0]
        + (center_y - camera.position[1]) * camera.forward[1]
        + (center_z - camera.position[2]) * camera.forward[2];
    let depth = axis_depth.max(CLUSTER_LOD_MIN_VIEW_DEPTH);
    error * camera.viewport_height_pixels / (2.0 * depth * camera.tan_half_fov_y)
}

/// CPU 参考选层(GPU kernel 的仲裁基准)。fail-closed:相机非法、误差/包围盒非有限、
/// 误差单调前提被破坏一律 [`ClusterLodSelectionError`],绝不静默降级。
pub fn select_cluster_lod(
    nodes: &[ClusterLodNode],
    camera: &ClusterLodCamera,
) -> Result<ClusterLodSelection, ClusterLodSelectionError> {
    validate_camera(camera)?;
    let index_of: std::collections::HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.id.as_str(), index))
        .collect();
    let mut selection = vec![0u32; nodes.len()];
    let mut screen_errors = vec![0.0f32; nodes.len()];
    for (index, node) in nodes.iter().enumerate() {
        if !node.error.is_finite() || node.error < 0.0 {
            return Err(ClusterLodSelectionError::NodeErrorInvalid(node.id.clone()));
        }
        if !all_finite(&node.bounds_min) || !all_finite(&node.bounds_max) {
            return Err(ClusterLodSelectionError::NodeBoundsInvalid(node.id.clone()));
        }
        for child in &node.children {
            let child_node = nodes
                .iter()
                .find(|candidate| candidate.id == *child)
                .ok_or_else(|| ClusterLodSelectionError::UnknownChild {
                    parent: node.id.clone(),
                    child: child.clone(),
                })?;
            if child_node.error > node.error {
                return Err(ClusterLodSelectionError::MonotonicityViolated {
                    parent: node.id.clone(),
                    child: child.clone(),
                });
            }
        }
        let error = cluster_screen_error(node.bounds_min, node.bounds_max, node.error, camera);
        screen_errors[index] = error as f32;
        let selected = node.triangle_count > 0 && (error as f32) <= camera.pixel_threshold as f32;
        selection[index] = if selected { node.level } else { CLUSTER_LOD_REFINE_SENTINEL };
    }
    let is_child: std::collections::HashSet<&str> = nodes
        .iter()
        .flat_map(|node| node.children.iter().map(String::as_str))
        .collect();
    let mut frontier = Vec::new();
    // 迭代 DFS(与 TS 递归 visit 同序;栈顶先弹保持兄弟顺序)。
    let mut stack: Vec<&ClusterLodNode> = nodes.iter().filter(|node| !is_child.contains(node.id.as_str())).collect();
    stack.reverse();
    while let Some(node) = stack.pop() {
        let index = index_of[node.id.as_str()];
        if selection[index] != CLUSTER_LOD_REFINE_SENTINEL || node.children.is_empty() {
            frontier.push(node.id.clone());
            continue;
        }
        let mut children: Vec<&ClusterLodNode> = node
            .children
            .iter()
            .map(|child| nodes.iter().find(|candidate| candidate.id == *child).expect("validated above"))
            .collect();
        children.reverse();
        stack.extend(children);
    }
    Ok(ClusterLodSelection {
        selection,
        screen_errors,
        frontier,
    })
}

/// 单节点 64B 打包(TS `packClusterLodNodes` 每槽位同式;f32 舍入 = JS Float32Array 写入)。
pub fn pack_cluster_lod_node(
    node: &ClusterLodNode,
    cluster_index: u32,
) -> [u8; CLUSTER_LOD_NODE_STRIDE_BYTES] {
    let mut buffer = [0u8; CLUSTER_LOD_NODE_STRIDE_BYTES];
    let floats = &mut buffer;
    let put_f32 = |buffer: &mut [u8], word: usize, value: f64| {
        let bits = (value as f32).to_bits();
        buffer[word * 4..word * 4 + 4].copy_from_slice(&bits.to_le_bytes());
    };
    let put_u32 = |buffer: &mut [u8], word: usize, value: u32| {
        buffer[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
    };
    put_f32(&mut buffer, ClusterLodNodeWord::BOUNDS_MIN_X, node.bounds_min[0]);
    put_f32(&mut buffer, ClusterLodNodeWord::BOUNDS_MIN_Y, node.bounds_min[1]);
    put_f32(&mut buffer, ClusterLodNodeWord::BOUNDS_MIN_Z, node.bounds_min[2]);
    put_f32(&mut buffer, ClusterLodNodeWord::BOUNDS_MIN_PAD, 0.0);
    put_f32(&mut buffer, ClusterLodNodeWord::BOUNDS_MAX_X, node.bounds_max[0]);
    put_f32(&mut buffer, ClusterLodNodeWord::BOUNDS_MAX_Y, node.bounds_max[1]);
    put_f32(&mut buffer, ClusterLodNodeWord::BOUNDS_MAX_Z, node.bounds_max[2]);
    put_f32(&mut buffer, ClusterLodNodeWord::BOUNDS_MAX_PAD, 0.0);
    put_f32(&mut buffer, ClusterLodNodeWord::ERROR_SCALAR, node.error);
    put_u32(&mut buffer, ClusterLodNodeWord::LOD_LEVEL, node.level);
    put_u32(&mut buffer, ClusterLodNodeWord::CLUSTER_INDEX, cluster_index);
    put_u32(&mut buffer, ClusterLodNodeWord::FIRST_TRIANGLE, node.first_triangle);
    put_u32(&mut buffer, ClusterLodNodeWord::TRIANGLE_COUNT, node.triangle_count);
    put_u32(&mut buffer, ClusterLodNodeWord::PAD0, 0);
    put_u32(&mut buffer, ClusterLodNodeWord::PAD1, 0);
    put_u32(&mut buffer, ClusterLodNodeWord::PAD2, 0);
    buffer
}

/// 从 64B stride 解出节点(TS `unpackClusterLodNodes` 同构;stride 校验 fail-closed)。
pub fn unpack_cluster_lod_nodes(buffer: &[u8]) -> Result<Vec<SerializedClusterLodNode>, String> {
    if buffer.len() % CLUSTER_LOD_NODE_STRIDE_BYTES != 0 {
        return Err(format!(
            "Cluster LOD node buffer must be a multiple of {CLUSTER_LOD_NODE_STRIDE_BYTES} bytes."
        ));
    }
    let words: Vec<u32> = buffer
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes(chunk.try_into().expect("chunks_exact(4)")))
        .collect();
    let floats: Vec<f32> = buffer
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("chunks_exact(4)")))
        .collect();
    let mut nodes = Vec::new();
    let mut base = 0usize;
    while base < words.len() {
        nodes.push(SerializedClusterLodNode {
            error_scalar: floats[base + ClusterLodNodeWord::ERROR_SCALAR],
            lod_level: words[base + ClusterLodNodeWord::LOD_LEVEL],
            cluster_index: words[base + ClusterLodNodeWord::CLUSTER_INDEX],
            first_triangle: words[base + ClusterLodNodeWord::FIRST_TRIANGLE],
            triangle_count: words[base + ClusterLodNodeWord::TRIANGLE_COUNT],
            min: [
                floats[base + ClusterLodNodeWord::BOUNDS_MIN_X],
                floats[base + ClusterLodNodeWord::BOUNDS_MIN_Y],
                floats[base + ClusterLodNodeWord::BOUNDS_MIN_Z],
            ],
            max: [
                floats[base + ClusterLodNodeWord::BOUNDS_MAX_X],
                floats[base + ClusterLodNodeWord::BOUNDS_MAX_Y],
                floats[base + ClusterLodNodeWord::BOUNDS_MAX_Z],
            ],
        });
        base += CLUSTER_LOD_NODE_STRIDE_WORDS;
    }
    Ok(nodes)
}
