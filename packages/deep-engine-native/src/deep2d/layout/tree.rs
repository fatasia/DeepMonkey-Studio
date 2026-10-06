//! 布局树:arena 存储,父先于子(NodeId 即 arena 下标,天然确定性)。
//!
//! 节点 = 样式 + 叶子内容(Box/Text)+ 可选盒视觉(背景/圆角/阴影,消费刀 1
//! 的 `Deep2dPaint`/`BoxShadow`)。容器就是带子节点的节点;视觉可以挂在
//! 任意节点上(卡片本体=容器+视觉,图标占位=固定尺寸叶子+视觉)。

use super::style::LayoutStyle;
use super::LAYOUT_BUDGETS;
use crate::deep2d::{BackdropBlur, BoxShadow, Deep2dBlendMode, Deep2dPaint};

/// arena 下标;`Node::ROOT` 是 0 号(构造时的根)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId(pub(crate) u32);

impl NodeId {
    /// 根节点 id(arena 0 号)。
    pub const ROOT: NodeId = NodeId(0);

    pub fn index(self) -> usize {
        self.0 as usize
    }
}

/// 文本 leaf 的内容规格。测量经 [`crate::deep2d::layout::TextMeasurer`] 注入
/// (platform_text 接缝);命令产出时直接映射为 `TextCommand` 字段。
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutTextSpec {
    pub text: String,
    /// 宿主字体资源 id;命令产出时必须存在于传入的字体资源表(fail-closed)。
    pub font_id: String,
    pub font_size: f64,
    pub color: [f64; 4],
}

/// 盒视觉:容器/占位 leaf 的绘制面,逐字段映射到刀 1 `PathCommand`。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LayoutBoxVisual {
    /// 背景(纯色或刀 1 渐变)。渐变几何在节点本地空间(box = (0,0,w,h))。
    pub background: Option<Deep2dPaint>,
    /// 圆角半径(>= 0;负值 solve 时 fail-closed)。
    pub corner_radius: f64,
    /// 刀 1 盒阴影;需与圆角并存(命令校验链要求 cornerRadius 字段存在)。
    pub shadow: Option<BoxShadow>,
    /// 刀 4 固定函数混合模式(缺省 = normal;动态 gate 排除非 normal,
    /// 布局产出的盒命令恒为静态块)。
    pub blend: Option<Deep2dBlendMode>,
    /// 刀 4 毛玻璃背景模糊(盒形 SDF 掩罩);缺省无。命令校验链要求
    /// cornerRadius 字段存在,命令产出时由 backdrop 是否存在自动补齐。
    pub backdrop_blur: Option<BackdropBlur>,
}

/// 叶子内容。`Box` 无内容测量(尺寸只来自样式);
/// `Text` 的固有尺寸由注入的测量器给出。
#[derive(Debug, Clone, PartialEq, Default)]
pub enum LayoutLeaf {
    #[default]
    Box,
    Text(LayoutTextSpec),
}

/// 布局树节点。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LayoutNode {
    pub style: LayoutStyle,
    pub leaf: LayoutLeaf,
    pub visual: Option<LayoutBoxVisual>,
    pub(crate) children: Vec<NodeId>,
    pub(crate) depth: u32,
}

impl LayoutNode {
    /// 无视觉的盒子节点(容器或不绘制的结构节点)。
    pub fn box_node(style: LayoutStyle) -> Self {
        Self {
            style,
            ..Self::default()
        }
    }

    /// 文本 leaf 节点。
    pub fn text_node(style: LayoutStyle, spec: LayoutTextSpec) -> Self {
        Self {
            style,
            leaf: LayoutLeaf::Text(spec),
            ..Self::default()
        }
    }

    /// 挂盒视觉(builder 链式)。
    #[must_use]
    pub fn with_visual(mut self, visual: LayoutBoxVisual) -> Self {
        self.visual = Some(visual);
        self
    }
}

/// arena 布局树。0 号固定为根;`append` 保证父先于子存在。
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutTree {
    nodes: Vec<LayoutNode>,
}

impl LayoutTree {
    /// 以根节点开树。根样式即顶层容器样式。
    pub fn new(root: LayoutNode) -> Self {
        Self {
            nodes: vec![LayoutNode {
                depth: 0,
                ..root
            }],
        }
    }

    pub fn node(&self, id: NodeId) -> &LayoutNode {
        &self.nodes[id.index()]
    }

    pub fn children(&self, id: NodeId) -> &[NodeId] {
        &self.nodes[id.index()].children
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// 把 `node` 追加为 `parent` 的最后一个孩子,返回新 id。
    /// 父不存在、预算超限、深度超限均 fail-closed。
    pub fn append(&mut self, parent: NodeId, node: LayoutNode) -> Result<NodeId, String> {
        let parent_node = self
            .nodes
            .get(parent.index())
            .ok_or_else(|| format!("append: parent node {parent:?} does not exist"))?;
        if self.nodes.len() >= LAYOUT_BUDGETS.nodes {
            return Err(format!(
                "append: layout node budget of {} exceeded",
                LAYOUT_BUDGETS.nodes
            ));
        }
        if parent_node.children.len() >= LAYOUT_BUDGETS.children_per_node {
            return Err(format!(
                "append: children budget of {} per node exceeded",
                LAYOUT_BUDGETS.children_per_node
            ));
        }
        let depth = parent_node.depth + 1;
        if depth > LAYOUT_BUDGETS.depth as u32 {
            return Err(format!(
                "append: layout depth budget of {} exceeded",
                LAYOUT_BUDGETS.depth
            ));
        }
        let id = NodeId(self.nodes.len() as u32);
        self.nodes.push(LayoutNode {
            depth,
            ..node
        });
        self.nodes[parent.index()].children.push(id);
        Ok(id)
    }

    /// 创建序(arena 下标序):父先于子创建,即合法的拓扑序,z_order 与
    /// 命令产出都按此序——容器背景天然在子之前渲染。注意它不一定是 DFS 前序
    /// (先建兄弟再往兄挂子时),但父子先后保证恒成立。
    pub(crate) fn creation_order(&self) -> impl Iterator<Item = NodeId> + '_ {
        (0..self.nodes.len()).map(|index| NodeId(index as u32))
    }

}

#[cfg(test)]
mod tree_tests {
    use super::*;

    fn node() -> LayoutNode {
        LayoutNode::box_node(LayoutStyle::size(10.0, 10.0))
    }

    #[test]
    fn append_links_children_and_assigns_depth() {
        let mut tree = LayoutTree::new(node());
        let child = tree.append(NodeId::ROOT, node()).expect("append child");
        let grand = tree.append(child, node()).expect("append grand");
        assert_eq!(tree.node_count(), 3);
        assert_eq!(tree.children(NodeId::ROOT), &[child]);
        assert_eq!(tree.children(child), &[grand]);
        assert_eq!(tree.node(grand).depth, 2);
    }

    #[test]
    fn append_fails_closed_on_missing_parent() {
        let mut tree = LayoutTree::new(node());
        let missing = NodeId(99);
        assert!(tree.append(missing, node()).is_err());
    }

    #[test]
    fn creation_order_visits_parents_before_children() {
        let mut tree = LayoutTree::new(node());
        let first = tree.append(NodeId::ROOT, node()).expect("first");
        let second = tree.append(NodeId::ROOT, node()).expect("second");
        let first_child = tree.append(first, node()).expect("first child");
        let order: Vec<_> = tree.creation_order().collect();
        // 创建序 = arena 下标序;second(2) 先于 first_child(3) 创建,
        // 但父子先后(first < first_child)保证恒成立。
        assert_eq!(order, vec![NodeId::ROOT, first, second, first_child]);
        assert!(order.iter().position(|id| *id == first).unwrap()
            < order.iter().position(|id| *id == first_child).unwrap());
    }

    #[test]
    fn visual_builder_attaches_box_visual() {
        let node = node().with_visual(LayoutBoxVisual {
            corner_radius: 8.0,
            ..LayoutBoxVisual::default()
        });
        assert_eq!(node.visual.as_ref().expect("visual").corner_radius, 8.0);
    }
}
