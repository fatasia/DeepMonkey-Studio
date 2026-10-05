//! 布局 solution → 标准 `Deep2dCommand`(零新增枚举变体)。
//!
//! 映射:
//! - 带视觉节点 → `PathCommand`:矩形 path 资源(本地 (0,0,w,h))+ 平移
//!   transform;`background` → `fill`(纯色或刀 1 渐变),`corner_radius` →
//!   解析圆角,`shadow` → 刀 1 `BoxShadow`(命令 cornerRadius 字段按校验链
//!   要求必须存在,缺省 0)。
//! - 文本 leaf → `TextCommand`(位置=rect 左上,字体资源由宿主提供,缺失
//!   fail-closed)。
//! - z_order = 前序 DFS 序(容器先于子渲染,天然满足背景在下)。
//!
//! 退化盒(非正宽高)跳过视觉/文本产出——布局塌缩为 0 的节点不可见是合法状态,
//! 不算错误;资源与命令 id 由 `id_prefix` + 节点序号确定性派生,资源面与命令面
//! 由同一个 [`CommandPlan`] 派生,无第二份判定逻辑。

use super::solve::LayoutRect;
use super::tree::{LayoutBoxVisual, LayoutLeaf, LayoutTree, LayoutTextSpec, NodeId};
use crate::deep2d::command_types::{Deep2dCommand, PathCommand, TextCommand};
use crate::deep2d::types::{
    Deep2dDisplayList, Deep2dPathVerb, Deep2dResource, FontResource, PathResource,
};

/// 命令产出参数。
#[derive(Debug, Clone)]
pub struct CommandParams<'a> {
    /// 资源/命令 id 前缀(须为合法 deep2d id 字符)。
    pub id_prefix: &'a str,
    /// 文本 leaf 引用的字体资源表(font_id → 资源);文本 font_id 缺失时报错。
    pub fonts: &'a [FontResource],
}

/// 中间计划:可见节点的(节点, 矩形)前序序列;命令与资源都从这里派生。
struct CommandPlan {
    entries: Vec<(NodeId, LayoutRect)>,
}

impl CommandPlan {
    fn build(
        tree: &LayoutTree,
        solution: &super::solve::LayoutSolution,
        params: &CommandParams<'_>,
    ) -> Result<Self, String> {
        validate_id_prefix(params.id_prefix)?;
        for id in tree.creation_order() {
            let node = tree.node(id);
            if let LayoutLeaf::Text(spec) = &node.leaf {
                let rect = solution.rect(id);
                if rect.width > 0.0 && rect.height > 0.0 {
                    require_font(params.fonts, &spec.font_id)?;
                }
            }
        }
        let entries = tree
            .creation_order()
            .filter(|id| {
                let rect = solution.rect(*id);
                rect.width > 0.0 && rect.height > 0.0
            })
            .map(|id| (id, solution.rect(id)))
            .collect();
        Ok(Self { entries })
    }
}

/// solution + 树 → 命令序列(z_order 升序、创建序:容器背景先于子)。
pub fn to_commands(
    tree: &LayoutTree,
    solution: &super::solve::LayoutSolution,
    params: &CommandParams<'_>,
) -> Result<Vec<Deep2dCommand>, String> {
    to_commands_from_plan(&CommandPlan::build(tree, solution, params)?, tree, params)
}

fn to_commands_from_plan(
    plan: &CommandPlan,
    tree: &LayoutTree,
    params: &CommandParams<'_>,
) -> Result<Vec<Deep2dCommand>, String> {
    let mut commands = Vec::new();
    for (index, (id, rect)) in plan.entries.iter().enumerate() {
        let node = tree.node(*id);
        let z_order = index as i32;
        match (&node.leaf, &node.visual) {
            (LayoutLeaf::Text(spec), _) => commands.push(Deep2dCommand::Text(text_command(
                params.id_prefix, *id, z_order, *rect, spec,
            ))),
            // Box 视觉必须有 background:无 fill 的圆角/阴影盒画不出来,且
            // 冻结校验链以 EmptyPaint 拒绝无 fill/stroke 的 Path 命令。
            (LayoutLeaf::Box, Some(visual)) if visual.background.is_some() => {
                commands.push(Deep2dCommand::Path(path_command(
                    params.id_prefix,
                    *id,
                    z_order,
                    *rect,
                    visual,
                )));
            }
            (LayoutLeaf::Box, _) => {}
        }
    }
    Ok(commands)
}

/// 组装完整 `Deep2dDisplayList`:收集视觉节点矩形 path 资源 + 传入字体资源。
pub fn to_display_list(
    tree: &LayoutTree,
    solution: &super::solve::LayoutSolution,
    id: &str,
    revision: u64,
    params: &CommandParams<'_>,
) -> Result<Deep2dDisplayList, String> {
    let plan = CommandPlan::build(tree, solution, params)?;
    let commands = to_commands_from_plan(&plan, tree, params)?;
    let mut resources: Vec<Deep2dResource> = Vec::new();
    for (node_id, rect) in &plan.entries {
        let node = tree.node(*node_id);
        // 资源与命令同一可见性合同:Box 视觉必须有 background(冻结校验链
        // EmptyPaint 拒绝无 fill/stroke 的 Path 命令;纯结构盒不产出)。
        if matches!(node.leaf, LayoutLeaf::Box)
            && node
                .visual
                .as_ref()
                .is_some_and(|visual| visual.background.is_some())
        {
            resources.push(Deep2dResource::Path(rect_path_resource(
                params.id_prefix,
                *node_id,
                f64::from(rect.width),
                f64::from(rect.height),
            )));
        }
    }
    resources.extend(params.fonts.iter().cloned().map(Deep2dResource::Font));
    Ok(Deep2dDisplayList {
        schema_version: 1,
        id: id.to_string(),
        revision,
        logical_width: f64::from(solution.root_size[0]),
        logical_height: f64::from(solution.root_size[1]),
        scale_factor: 1.0,
        resources,
        commands,
        atlases: Vec::new(),
    })
}

fn validate_id_prefix(prefix: &str) -> Result<(), String> {
    if prefix.is_empty()
        || !prefix
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(format!(
            "layout commands: id_prefix must be non-empty [A-Za-z0-9_-], got {prefix:?}"
        ));
    }
    Ok(())
}

fn require_font(fonts: &[FontResource], font_id: &str) -> Result<(), String> {
    if fonts.iter().any(|font| font.id == font_id) {
        Ok(())
    } else {
        Err(format!(
            "layout commands: text references font_id {font_id:?} which is absent from the font table; \
             provide the host FontResource (platform_text seam) in CommandParams::fonts"
        ))
    }
}

fn text_command(
    prefix: &str,
    id: NodeId,
    z_order: i32,
    rect: LayoutRect,
    spec: &LayoutTextSpec,
) -> TextCommand {
    TextCommand {
        id: format!("{prefix}-text-{}", id.0),
        z_order,
        transform: [1.0, 0.0, 0.0, 1.0, f64::from(rect.x), f64::from(rect.y)],
        opacity: None,
        clip_path_ids: None,
        clip_rect: None,
        hit_id: None,
        text: spec.text.clone(),
        x: 0.0,
        y: 0.0,
        font_id: spec.font_id.clone(),
        font_size: spec.font_size,
        color: spec.color,
        max_width: None,
        align: None,
        baseline: None,
        direction: None,
        atlas_id: None,
        baked_glyphs: None,
    }
}

fn path_command(
    prefix: &str,
    id: NodeId,
    z_order: i32,
    rect: LayoutRect,
    visual: &LayoutBoxVisual,
) -> PathCommand {
    // 校验链要求 shadow 必须伴随命令 cornerRadius 字段;无阴影时圆角为 0
    // 不需要该字段(直角矩形零圆角与缺省同像素)。
    let corner_radius = if visual.corner_radius > 0.0 || visual.shadow.is_some() {
        Some(visual.corner_radius)
    } else {
        None
    };
    PathCommand {
        id: format!("{prefix}-box-{}", id.0),
        z_order,
        transform: [1.0, 0.0, 0.0, 1.0, f64::from(rect.x), f64::from(rect.y)],
        opacity: None,
        clip_path_ids: None,
        clip_rect: None,
        hit_id: None,
        path_id: format!("{prefix}-rect-{}", id.0),
        fill: visual.background.clone(),
        fill_rule: None,
        stroke: None,
        stroke_width: None,
        line_cap: None,
        line_join: None,
        miter_limit: None,
        dash: None,
        dash_offset: None,
        corner_radius,
        shadow: visual.shadow,
    }
}

/// 节点本地矩形 path 资源:闭合轴对齐矩形(刀 1 圆角 SDF 的形状前提)。
fn rect_path_resource(prefix: &str, id: NodeId, width: f64, height: f64) -> PathResource {
    PathResource {
        id: format!("{prefix}-rect-{}", id.0),
        revision: 1,
        verbs: vec![
            Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
            Deep2dPathVerb::Line { x: width, y: 0.0 },
            Deep2dPathVerb::Line {
                x: width,
                y: height,
            },
            Deep2dPathVerb::Line { x: 0.0, y: height },
            Deep2dPathVerb::Close,
        ],
    }
}
