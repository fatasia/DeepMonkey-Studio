//! 刀 3:stencil-then-cover 动态路径填充(GPUI 对齐)。
//!
//! 静态路径继续走「CPU 细分 → 图集/顶点缓存」路线;每帧内容都在变的路径按
//! 滑窗变更计数自动分路到 stencil 管线:fence(竖直挤出边带)cover pass 写
//! 模板,fill pass 对模板区着色——CPU 每帧只剩 O(动词数) 的展平与 fence
//! 顶点发射,三角形化归零。判定是纯运行时决策,不改 wire schema,不设
//! 用户开关。
//!
//! 填充语义(fence 竖直挤出,Qt/GPUI 同族):对闭合多边形的每条边发射
//! 「边 → +Y 无穷」梯形(两个三角形),像素的模板值 = 其上方穿过的边带
//! 按 facing 累计的 winding;cover pass 之后 fill pass 只在
//! `nonzero: 模板≠0` / `evenodd: 模板==0(仅递增)` 的地方着色。CPU 镜像
//! (`paint_reference::rasterize_prepared` 的 dynamic 分支)用同一半开区间
//! 规则做逐像素中心判定,与 GPU 1× 硬边采样同语义。
//!
//! 分路条件(fail-safe,不满足即回落静态 CPU 细分,计数上报):
//! - 有 `fill`(`corner_radius` 命令本就是零 CPU 解析 SDF quad,不参与);
//! - 无 `clip_path_ids`(多边形剪刀需要 CPU 三角形);
//! - fill 单边预算/帧预算未超限。
//! 动态命令的 `stroke` 不在本刀范围,继续走既有 CPU 描边展开(如实降档)。

use std::collections::{HashMap, VecDeque};

use super::{
    FillRule, PathCommand, PathResource,
    painter::PathVertex,
    painter_math::{Point, transform_point},
    painter_path::LinearPath,
};

/// 滑窗观察帧数:每条命令保留最近 N 帧的「资源内容是否变更」记录。
pub const DYNAMIC_WINDOW_FRAMES: usize = 8;
/// 滑窗内变更次数达到该阈值即判为动态;旧记录滑出窗口后自动退回静态
/// (无迟滞:一个动画周期结束后命令自然回到缓存路线)。
pub const DYNAMIC_CHANGES_THRESHOLD: usize = 3;
/// 单条命令的 fence 边预算(超过即该帧回落静态路,防几何爆炸)。
pub const MAX_DYNAMIC_FILL_EDGES_PER_COMMAND: usize = 65_536;
/// 整帧动态 fence 边预算(6 顶点/边 × 8B ≈ 预算内上传量有界)。
pub const MAX_DYNAMIC_FILL_EDGES_TOTAL: usize = 524_288;

/// fence 竖直挤出目标(逻辑单位):任何可见纵横比下都高于画布;
/// 仿射映射与 GPU 裁剪对超大坐标均安全(f32 范围内,ulp 误差只移动
/// 带顶,不影响带内覆盖)。
const EXTRUDE_Y: f64 = 1.0e7;

/// 每条 fence 边的顶点数(两个三角形)。
pub const VERTICES_PER_EDGE: usize = 6;

/// 每命令滑窗变更记录:内容指纹 + 最近 N 帧的变更旗标。
#[derive(Debug, Default)]
struct DynamicRecord {
    window: VecDeque<bool>,
    last_hash: Option<u64>,
}

impl DynamicRecord {
    fn observe(&mut self, content_hash: u64) -> bool {
        // 冷启动(首次观察)不算变更:命令第一次出现是「结构」,不是
        // 「内容变化」——否则冷启动 + 2 次真实变更就会误判动态。
        let changed = match self.last_hash {
            Some(previous) => previous != content_hash,
            None => false,
        };
        self.last_hash = Some(content_hash);
        if self.window.len() >= DYNAMIC_WINDOW_FRAMES {
            self.window.pop_front();
        }
        self.window.push_back(changed);
        self.window.iter().filter(|flag| **flag).count() >= DYNAMIC_CHANGES_THRESHOLD
    }
}

/// 动态性判定器:按命令 id 记录滑窗内资源内容变更次数,达到阈值自动
/// 分路 stencil,旧变更滑出窗口自动退回静态缓存路线。内容以动词指纹
/// 比较(`resource_content_hash`),与缓存条目解耦——动态期条目原地
/// 保留,退静态时的失效归因仍走既有 miss 词表。
#[derive(Debug, Default)]
pub struct DynamicPathTracker {
    records: HashMap<String, DynamicRecord>,
}

impl DynamicPathTracker {
    /// 记录一次观察并返回该命令当前是否判为动态。只统计资源内容变更
    /// (相机/epoch/风格/clip 变化不是内容动态,不应把整批命令推向 stencil)。
    pub fn observe(&mut self, id: &str, content_hash: u64) -> bool {
        self.records
            .entry(id.to_owned())
            .or_default()
            .observe(content_hash)
    }

    /// 测试与可观测性入口:某 id 当前是否动态(不推进窗口)。
    pub fn is_dynamic(&self, id: &str) -> bool {
        self.records
            .get(id)
            .is_some_and(|record| record.window.iter().filter(|flag| **flag).count() >= DYNAMIC_CHANGES_THRESHOLD)
    }
}

/// 路径资源动词的内容指纹(f64 位模式哈希,-0.0/0.0 与 NaN 视为不同——
/// 与缓存条目逐字节相等口径一致)。碰撞只会延迟/提前一帧分路,不影响
/// 填充正确性:动态填充永远使用当前帧资源。
pub(crate) fn resource_content_hash(resource: &PathResource) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    resource.id.hash(&mut hasher);
    for verb in &resource.verbs {
        std::mem::discriminant(verb).hash(&mut hasher);
        match verb {
            super::Deep2dPathVerb::Move { x, y }
            | super::Deep2dPathVerb::Line { x, y } => {
                x.to_bits().hash(&mut hasher);
                y.to_bits().hash(&mut hasher);
            }
            super::Deep2dPathVerb::Quadratic { cx, cy, x, y } => {
                cx.to_bits().hash(&mut hasher);
                cy.to_bits().hash(&mut hasher);
                x.to_bits().hash(&mut hasher);
                y.to_bits().hash(&mut hasher);
            }
            super::Deep2dPathVerb::Cubic {
                c1x,
                c1y,
                c2x,
                c2y,
                x,
                y,
            } => {
                c1x.to_bits().hash(&mut hasher);
                c1y.to_bits().hash(&mut hasher);
                c2x.to_bits().hash(&mut hasher);
                c2y.to_bits().hash(&mut hasher);
                x.to_bits().hash(&mut hasher);
                y.to_bits().hash(&mut hasher);
            }
            super::Deep2dPathVerb::Close => {}
        }
    }
    hasher.finish()
}

/// stencil 分路资格:有 fill、非解析 SDF quad、无多边形剪刀、非
/// multiply/screen 等固定函数混合(动态 cover 走共享 fill 管线,混合
/// 模式仅静态块携带;non-normal blend 命令回落 CPU 细分保语义)。
pub(crate) fn stencil_eligible(command: &PathCommand) -> bool {
    command.fill.is_some()
        && command.corner_radius.is_none()
        && command.clip_path_ids.is_none()
        && !command
            .blend
            .is_some_and(|blend| blend != super::Deep2dBlendMode::Normal)
        && command.backdrop_blur.is_none()
}

/// 动态填充的生效 fill rule;wire 缺省(None)按 canvas 惯例取 nonzero。
pub(crate) fn dynamic_fill_rule(command: &PathCommand) -> FillRule {
    command.fill_rule.unwrap_or(FillRule::Nonzero)
}

/// 一次动态发射的产物:边带顶点(canvas 空间,逐边 2 三角形)与
/// cover bbox(canvas 空间)。
pub(crate) struct DynamicFence {
    pub edges: Vec<[f32; 2]>,
    pub bbox: [f64; 4],
    pub edge_count: usize,
}

/// 从展平子路径生成 fence:每条边(含闭合边)挤出为「边 → EXTRUDE_Y」
/// 两个三角形。局部点先变换到 canvas 空间,与 PathVertex 位置同源。
pub(crate) fn dynamic_fence(linear: &LinearPath, transform: &[f64; 6]) -> Option<DynamicFence> {
    let mut edges = Vec::new();
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    let mut edge_count = 0usize;
    let push_edge = |a: Point, b: Point, edges: &mut Vec<[f32; 2]>| {
        // 竖直挤出四边形 (a, b, b_up, a_up) 拆两个三角形,共享对角边
        // 方向相反,水密不裂缝。边向右(+x)时三角形为 CCW(前向)。
        let a_up = [a[0], EXTRUDE_Y];
        let b_up = [b[0], EXTRUDE_Y];
        for vertex in [a, b, b_up, a, b_up, a_up] {
            edges.push([vertex[0] as f32, vertex[1] as f32]);
        }
    };
    for subpath in &linear.subpaths {
        if !subpath.closed {
            continue;
        }
        for [a, b] in subpath.segments() {
            if edge_count >= MAX_DYNAMIC_FILL_EDGES_PER_COMMAND {
                return None;
            }
            let canvas_a = transform_point(a, *transform);
            let canvas_b = transform_point(b, *transform);
            for point in [canvas_a, canvas_b] {
                min[0] = min[0].min(point[0]);
                min[1] = min[1].min(point[1]);
                max[0] = max[0].max(point[0]);
                max[1] = max[1].max(point[1]);
            }
            push_edge(canvas_a, canvas_b, &mut edges);
            edge_count += 1;
        }
    }
    if edge_count == 0 || !min[0].is_finite() {
        return None;
    }
    Some(DynamicFence {
        edges,
        bbox: [min[0], min[1], max[0] - min[0], max[1] - min[1]],
        edge_count,
    })
}

/// cover quad 顶点(PathVertex 布局):bbox 两个三角形。local 取逆变换
/// 映射,保证渐变求值与多边形顶点同一局部空间;实心走 slot 0 顶点色。
pub(crate) fn cover_vertices(
    bbox: [f64; 4],
    transform: &[f64; 6],
    rgba: [f32; 4],
    paint_slot: u32,
) -> Vec<PathVertex> {
    let inverse = invert(transform);
    let corners = [
        [bbox[0], bbox[1]],
        [bbox[0] + bbox[2], bbox[1]],
        [bbox[0] + bbox[2], bbox[1] + bbox[3]],
        [bbox[0], bbox[1] + bbox[3]],
    ];
    let mut vertices = Vec::with_capacity(6);
    for corner in [0, 1, 2, 0, 2, 3] {
        let canvas = corners[corner];
        let local = transform_point(canvas, inverse);
        vertices.push([
            canvas[0] as f32,
            canvas[1] as f32,
            rgba[0],
            rgba[1],
            rgba[2],
            rgba[3],
            local[0] as f32,
            local[1] as f32,
            paint_slot as f32,
        ]);
    }
    vertices
}

/// [a, b, c, d, e, f](x' = a·x + c·y + e)的仿射逆;退化矩阵返回单位阵
/// (调用侧的多边形生成已拒绝退化变换,此处只保证 total 函数无 panic)。
pub(crate) fn invert(matrix: &[f64; 6]) -> [f64; 6] {
    let [a, b, c, d, e, f] = *matrix;
    let det = a * d - b * c;
    if det.abs() < 1e-12 {
        return [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    }
    [
        d / det,
        -b / det,
        -c / det,
        a / det,
        (c * f - d * e) / det,
        (b * e - a * f) / det,
    ]
}

#[cfg(test)]
#[path = "painter_dynamic_tests.rs"]
mod tests;
