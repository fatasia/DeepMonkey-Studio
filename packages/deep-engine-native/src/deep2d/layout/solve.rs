//! 布局求解:LayoutTree + 视口 → 每个 node 的绝对 rect。
//!
//! 确定性合同:纯函数,无时钟/无随机/无环境读取;taffy 版本精确固定
//! (`=0.14.0`),`use_rounding` 显式开启(CSS 式像素取整,兄弟盒子共享边不
//! 出现半像素缝)。同一二进制 + 同一输入 → 输出逐位相同,黄金用例钉死。
//!
//! 坐标语义:输出 rect 是**绝对坐标**(视口原点为根),已含 padding/margin
//! 偏移;taffy 的子节点 location 相对父 border box 原点,这里逐层累加成绝对
//! 坐标(padding 语义由黄金用例钉住)。

use taffy::NodeId as TaffyNodeId;
use taffy::prelude::{AvailableSpace, Size as TaffySize, TaffyTree};

use super::MAX_LAYOUT_VALUE;
use super::style::LayoutEdges;
use super::tree::{LayoutLeaf, LayoutTextSpec, LayoutTree, NodeId};

/// 求解后的节点矩形(绝对坐标,已取整)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// 求解结果:根尺寸 + 按 arena 序排列的矩形(NodeId 下标即条目下标)。
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutSolution {
    /// 根节点 border-box 尺寸(取整后)。
    pub root_size: [f32; 2],
    /// 每个节点的绝对矩形;条目 i 对应 NodeId(i)。
    pub rects: Vec<LayoutRect>,
}

impl LayoutSolution {
    pub fn rect(&self, id: NodeId) -> LayoutRect {
        self.rects[id.index()]
    }
}

/// 文本测量的输入:已知尺寸(父强制)与可用空间(CSS available space,Definite
/// 之外的 MinContent/MaxContent 归一为 None,由测量器自行决定固有尺寸)。
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TextMeasureInput {
    pub known_width: Option<f32>,
    pub known_height: Option<f32>,
    pub max_width: Option<f32>,
    pub max_height: Option<f32>,
}

/// platform_text 接缝:给出文本固有尺寸。未注入且文本 leaf 需要测量时
/// fail-closed(报错,不静默按零布局)。
pub type TextMeasurer<'a> = &'a mut dyn FnMut(&LayoutTextSpec, TextMeasureInput) -> [f32; 2];

/// 求解布局。`viewport` 是根可用空间(Definite);非有限或负值 fail-closed。
pub fn solve<'a>(
    tree: &'a LayoutTree,
    viewport: [f32; 2],
    text_measurer: Option<TextMeasurer<'a>>,
) -> Result<LayoutSolution, String> {
    validate_viewport(viewport)?;
    validate_styles(tree)?;

    let mut taffy_tree: TaffyTree<NodeId> = TaffyTree::new();
    // arena 序映射:条目 i = arena NodeId(i) 的 taffy 节点(建树按前序创建)。
    let mut taffy_ids: Vec<TaffyNodeId> = Vec::with_capacity(tree.node_count());
    let root_taffy = build_taffy_tree(&mut taffy_tree, tree, NodeId::ROOT, &mut taffy_ids)?;
    let mut leaf_measurer = LeafMeasurer {
        tree,
        text_measurer,
    };
    taffy_tree
        .compute_layout_with_measure(
            root_taffy,
            TaffySize {
                width: AvailableSpace::Definite(viewport[0]),
                height: AvailableSpace::Definite(viewport[1]),
            },
            move |inputs, _taffy_node, context, style| {
                // leaf_measurer 由外层 move 闭包拥有;这里是它的可变借用
                // (每次外层调用一次新借用),内层闭包移动的是这个借用值。
                let measurer = &mut leaf_measurer;
                taffy::compute_leaf_layout(
                    inputs,
                    style,
                    |_, _| 0.0,
                    move |known, available| match context {
                        Some(node_id) => measurer.measure(*node_id, known, available),
                        None => TaffySize::ZERO,
                    },
                )
            },
        )
        .map_err(|error| format!("layout solve: taffy compute failed: {error}"))?;

    let mut rects = vec![
        LayoutRect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
        tree.node_count()
    ];
    let root_layout = taffy_tree
        .layout(root_taffy)
        .map_err(|error| format!("layout solve: root layout missing: {error}"))?;
    let root_size = [root_layout.size.width, root_layout.size.height];
    collect_node(
        &taffy_tree,
        tree,
        NodeId::ROOT,
        root_layout.location.x,
        root_layout.location.y,
        &taffy_ids,
        &mut rects,
    )?;
    Ok(LayoutSolution { root_size, rects })
}

fn validate_viewport(viewport: [f32; 2]) -> Result<(), String> {
    if viewport
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err(format!(
            "layout solve: viewport must be finite and non-negative, got {viewport:?}"
        ));
    }
    Ok(())
}

/// 全树样式数值 fail-closed:非有限/越界一律报错并携带节点定位。
fn validate_styles(tree: &LayoutTree) -> Result<(), String> {
    for id in tree.creation_order() {
        let node = tree.node(id);
        let where_ = format!("node {id:?}");
        validate_edges(&node.style.padding, "padding", false, &where_)?;
        validate_edges(&node.style.margin, "margin", true, &where_)?;
        for value in [node.style.width, node.style.height].into_iter().flatten() {
            validate_number(value, 0.0, &where_)?;
        }
        for value in [
            node.style.column_gap,
            node.style.row_gap,
            node.style.flex_grow,
            node.style.flex_shrink,
        ] {
            validate_number(value, 0.0, &where_)?;
        }
        if let Some(visual) = &node.visual
            && !(0.0..=f64::from(MAX_LAYOUT_VALUE)).contains(&visual.corner_radius)
        {
            return Err(format!(
                "layout solve: {where_} corner_radius must be within 0..={MAX_LAYOUT_VALUE}, got {}",
                visual.corner_radius
            ));
        }
    }
    Ok(())
}

fn validate_number(value: f32, min: f32, where_: &str) -> Result<(), String> {
    if value.is_finite() && value >= min && value <= MAX_LAYOUT_VALUE {
        Ok(())
    } else {
        Err(format!(
            "layout solve: {where_} layout value must be finite and within {min}..={MAX_LAYOUT_VALUE}, got {value}"
        ))
    }
}

fn validate_edges(
    edges: &LayoutEdges,
    label: &str,
    allow_negative: bool,
    where_: &str,
) -> Result<(), String> {
    let min = if allow_negative {
        -MAX_LAYOUT_VALUE
    } else {
        0.0
    };
    for (name, value) in [
        ("top", edges.top),
        ("right", edges.right),
        ("bottom", edges.bottom),
        ("left", edges.left),
    ] {
        if !value.is_finite() || value < min || value > MAX_LAYOUT_VALUE {
            return Err(format!(
                "layout solve: {where_} {label} edge '{name}' must be finite and within {min}..={MAX_LAYOUT_VALUE}, got {value}"
            ));
        }
    }
    Ok(())
}

/// 深度优先镜像 arena → TaffyTree;节点上下文携带 arena id 供测量分发。
fn build_taffy_tree(
    taffy_tree: &mut TaffyTree<NodeId>,
    tree: &LayoutTree,
    id: NodeId,
    taffy_ids: &mut Vec<TaffyNodeId>,
) -> Result<TaffyNodeId, String> {
    let node = tree.node(id);
    let style = taffy::Style::from(&node.style);
    let mut children = Vec::with_capacity(node.children.len());
    for child in tree.children(id) {
        children.push(build_taffy_tree(taffy_tree, tree, *child, taffy_ids)?);
    }
    let taffy_id = if children.is_empty() {
        taffy_tree
            .new_leaf_with_context(style, id)
            .map_err(|error| format!("layout solve: leaf node {id:?} rejected: {error}"))?
    } else {
        taffy_tree
            .new_with_children(style, &children)
            .map_err(|error| format!("layout solve: container node {id:?} rejected: {error}"))?
    };
    // 每个 arena 节点恰好访问一次并写自己的槽位(taffy 建树是后序:子先建,
    // 父后建);槽位收集只在全部建完后被 collect_node 读取,占位值不会外泄。
    if taffy_ids.len() <= id.index() {
        taffy_ids.resize(id.index() + 1, taffy_id);
    }
    taffy_ids[id.index()] = taffy_id;
    Ok(taffy_id)
}

/// 叶子测量分发:Box → 零(尺寸完全来自样式,taffy 不消费该值当样式已定);
/// Text → 注入的测量器。文本无固定尺寸且无测量器是合同违规,fail-closed。
struct LeafMeasurer<'a> {
    tree: &'a LayoutTree,
    text_measurer: Option<TextMeasurer<'a>>,
}

impl LeafMeasurer<'_> {
    fn measure(
        &mut self,
        id: NodeId,
        known: TaffySize<Option<f32>>,
        available: TaffySize<AvailableSpace>,
    ) -> TaffySize<f32> {
        let node = self.tree.node(id);
        // 样式固定尺寸直通:固定尺寸文本永不依赖测量器(taffy 的 ComputeSize
        // 阶段 known_dimensions 可能为 None,样式才是确定尺寸的第一真源)。
        if let (Some(width), Some(height)) = (node.style.width, node.style.height) {
            return TaffySize { width, height };
        }
        let LayoutLeaf::Text(spec) = &node.leaf else {
            return TaffySize::ZERO;
        };
        if let (Some(width), Some(height)) = (known.width, known.height) {
            return TaffySize { width, height };
        }
        let Some(measurer) = self.text_measurer.as_deref_mut() else {
            panic!(
                "layout solve: text leaf {id:?} requires a TextMeasurer when auto-sized; \
                 inject one via solve(..., Some(&mut measurer)) or set fixed width/height"
            );
        };
        let definite = |space: AvailableSpace| match space {
            AvailableSpace::Definite(value) => Some(value),
            _ => None,
        };
        let measured = measurer(
            spec,
            TextMeasureInput {
                known_width: known.width,
                known_height: known.height,
                max_width: definite(available.width),
                max_height: definite(available.height),
            },
        );
        TaffySize {
            width: measured[0],
            height: measured[1],
        }
    }
}

/// DFS 累加父位置 → 绝对 rect(取整已在 taffy round_layout 内完成)。
#[allow(clippy::too_many_arguments)]
fn collect_node(
    taffy_tree: &TaffyTree<NodeId>,
    tree: &LayoutTree,
    id: NodeId,
    offset_x: f32,
    offset_y: f32,
    taffy_ids: &[TaffyNodeId],
    rects: &mut Vec<LayoutRect>,
) -> Result<(), String> {
    let taffy_id = taffy_ids
        .get(id.index())
        .ok_or_else(|| format!("layout solve: node {id:?} was never mirrored into taffy"))?;
    let layout = taffy_tree
        .layout(*taffy_id)
        .map_err(|error| format!("layout solve: layout for node {id:?} missing: {error}"))?;
    let x = offset_x + layout.location.x;
    let y = offset_y + layout.location.y;
    rects[id.index()] = LayoutRect {
        x,
        y,
        width: layout.size.width,
        height: layout.size.height,
    };
    for child in tree.children(id) {
        collect_node(taffy_tree, tree, *child, x, y, taffy_ids, rects)?;
    }
    Ok(())
}
