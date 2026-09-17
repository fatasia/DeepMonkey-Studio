//! 逐类适配:认证过的输入 → 批量 display delta + 行为命令。
//!
//! 资源身份与预算全部由宿主注入(`N1HostAssets` / `N1Budget`,见父模块):
//! 适配器不发明任何资源、不读时钟、不做 IO。所有拒绝都携带显式原因,
//! 绝不截断、不降级、不猜测。图表扩展适配在 [`chart_overlay`]。

use serde::Serialize;

use super::schema::{
    AnimationAbiInputV1, AnimationTrackV1, AnimationValueV1 as ValueV1, N1InputKind,
    RichTextAlignV1, RichTextInlineInputV1, SvgInputV1,
};
use super::svg_parse::parse_svg_path_subset;
use super::validate::{
    MAX_STROKE_WIDTH, derived_id, require_bounded_coordinate, require_color, require_id,
    require_positive, require_positive_bounded,
};
use crate::behavior_ir::{BehaviorPayload, stable_node_id};
use crate::deep2d::{
    DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION, Deep2dCommand, Deep2dResource, FontStyle, ImageColorSpace,
    ImageCommand, ImageResource, LineCap, LineJoin, PathCommand, PathResource, TextCommand,
};
use crate::platform_text::{
    InlineObject, Paragraph, ParagraphAlign, StyleSpan, TextDocumentV1, TextStyleId,
};

/// 单位仿射矩阵:适配产出的命令几何即输入几何,摆放归宿主。
pub(super) const IDENTITY_MATRIX: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
/// 适配产物中的批量 display delta:与 TS 侧 `Deep2dDisplayList` 的
/// `resources` / `commands` 同形,可由宿主并回主 display list。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct N1DisplayDelta {
    /// 与 Deep2d display list 合同同版本,消费方据此拒绝未知版本。
    pub schema_version: u32,
    pub resources: Vec<Deep2dResource>,
    pub commands: Vec<Deep2dCommand>,
}

impl N1DisplayDelta {
    pub(super) fn empty() -> Self {
        Self {
            schema_version: DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION,
            resources: Vec::new(),
            commands: Vec::new(),
        }
    }
}

/// 一次成功适配的产物:批量 display delta + 行为命令(封闭载荷)。
#[derive(Debug, Clone, PartialEq)]
pub struct N1Adapted {
    pub kind: N1InputKind,
    pub delta: N1DisplayDelta,
    pub actions: Vec<BehaviorPayload>,
}

pub(super) fn adapt_svg(input: &SvgInputV1, budget: &super::N1Budget) -> Result<N1Adapted, String> {
    require_id(&input.id, "svg input id")?;
    if input.paths.len() > budget.max_paths {
        return Err(format!(
            "svg path budget exceeded: {} paths > max {}",
            input.paths.len(),
            budget.max_paths
        ));
    }
    require_bounded_coordinate(input.view_box[0], "viewBox.minX")?;
    require_bounded_coordinate(input.view_box[1], "viewBox.minY")?;
    require_positive(input.view_box[2], "viewBox.width")?;
    require_positive(input.view_box[3], "viewBox.height")?;
    let mut delta = N1DisplayDelta::empty();
    let mut seen_ids = std::collections::BTreeSet::new();
    for path in &input.paths {
        require_id(&path.id, "svg path id")?;
        // 重复资源 id 会让 delta 无法并入同一 display list(deep2d 合同),
        // 在适配层即拒绝,保证产物总是可并回。
        if !seen_ids.insert(path.id.clone()) {
            return Err(format!("duplicate svg path id '{}'", path.id));
        }
        if path.fill.is_none() && path.stroke.is_none() {
            return Err(format!(
                "svg path '{}' requires fill or stroke (empty paint is rejected)",
                path.id
            ));
        }
        if let Some(fill) = path.fill {
            require_color(&fill, &format!("path '{}' fill", path.id))?;
        }
        if let Some(stroke) = path.stroke {
            require_color(&stroke, &format!("path '{}' stroke", path.id))?;
        }
        if let Some(stroke_width) = path.stroke_width {
            require_positive_bounded(
                stroke_width,
                MAX_STROKE_WIDTH,
                &format!("path '{}' strokeWidth", path.id),
            )?;
        }
        let verbs = parse_svg_path_subset(&path.data)
            .map_err(|error| format!("svg path '{}' rejected: {error}", path.id))?;
        if verbs.len() > budget.max_verbs_per_path {
            return Err(format!(
                "svg path '{}' exceeds the verb budget: {} > max {}",
                path.id,
                verbs.len(),
                budget.max_verbs_per_path
            ));
        }
        delta.resources.push(Deep2dResource::Path(PathResource {
            id: path.id.clone(),
            revision: 0,
            verbs,
        }));
        delta.commands.push(Deep2dCommand::Path(PathCommand {
            id: derived_id(&format!("{}.paint", path.id))?,
            z_order: path.z_order,
            transform: IDENTITY_MATRIX,
            opacity: None,
            clip_path_ids: None,
            clip_rect: None,
            hit_id: None,
            path_id: path.id.clone(),
            fill: path.fill,
            fill_rule: None,
            stroke: path.stroke,
            stroke_width: path.stroke_width,
            // stroke 风格字段只允许伴随 stroke 颜色出现(deep2d 合同)。
            line_cap: path.stroke.map(|_| LineCap::Butt),
            line_join: path.stroke.map(|_| LineJoin::Miter),
            miter_limit: None,
            dash: None,
            dash_offset: None,
        }));
    }
    finish(delta, N1InputKind::Svg, input.paths.len(), budget)
}

pub(super) fn adapt_rich_text(
    input: &RichTextInlineInputV1,
    budget: &super::N1Budget,
    assets: &super::N1HostAssets,
) -> Result<N1Adapted, String> {
    require_id(&input.id, "rich text input id")?;
    // 复用 TextDocumentV1 的簇/区间校验:越界、乱序、重叠都在这里被拒。
    let styles = input
        .styles
        .iter()
        .map(|span| StyleSpan {
            start_cluster: span.start_cluster,
            end_cluster: span.end_cluster,
            style: TextStyleId(span.style),
        })
        .collect::<Vec<_>>();
    let paragraphs = input
        .paragraphs
        .iter()
        .map(|paragraph| Paragraph {
            start_cluster: paragraph.start_cluster,
            end_cluster: paragraph.end_cluster,
            align: match paragraph.align {
                RichTextAlignV1::Start => ParagraphAlign::Start,
                RichTextAlignV1::Center => ParagraphAlign::Center,
                RichTextAlignV1::End => ParagraphAlign::End,
                RichTextAlignV1::Justify => ParagraphAlign::Justify,
            },
        })
        .collect::<Vec<_>>();
    let inline_objects = input
        .inline_objects
        .iter()
        .map(|object| InlineObject {
            at_cluster: object.at_cluster,
            object_id: object.object_id.clone(),
        })
        .collect::<Vec<_>>();
    let document = TextDocumentV1::new(&input.text, styles, paragraphs, inline_objects)
        .map_err(|error| format!("rich text document rejected: {error}"))?;

    let mut delta = N1DisplayDelta::empty();
    delta
        .resources
        .push(Deep2dResource::Font(crate::deep2d::FontResource {
            id: assets.font.id.clone(),
            revision: 0,
            asset_id: assets.font.asset_id.clone(),
            family: assets.font.family.clone(),
            weight: assets.font.weight,
            style: match assets.font.style {
                super::N1FontStyle::Normal => FontStyle::Normal,
                super::N1FontStyle::Italic => FontStyle::Italic,
            },
        }));
    let mut code_units = 0usize;
    for (index, paragraph) in document.paragraphs().iter().enumerate() {
        let text = paragraph_text(&document, paragraph)?;
        // The wire budget is defined in UTF-16 code units so that native and
        // TypeScript hosts reject the same payloads. `chars().count()` counts
        // Unicode scalar values and would under-count astral characters such
        // as emoji.
        code_units += text.encode_utf16().count();
        if code_units > budget.max_text_code_units {
            return Err(format!(
                "rich text code-unit budget exceeded: {code_units} > max {}",
                budget.max_text_code_units
            ));
        }
        delta.commands.push(Deep2dCommand::Text(TextCommand {
            id: derived_id(&format!("{}.text.{index}", input.id))?,
            z_order: 0,
            transform: IDENTITY_MATRIX,
            opacity: None,
            clip_path_ids: None,
            clip_rect: None,
            hit_id: None,
            text,
            x: 0.0,
            y: 0.0,
            font_id: assets.font.id.clone(),
            font_size: assets.font.font_size,
            color: assets.font.color,
            max_width: None,
            align: None,
            baseline: None,
            direction: None,
            atlas_id: None,
            baked_glyphs: None,
        }));
    }
    for object in document.inline_objects() {
        let Some(asset) = assets.inline_assets.get(object.object_id.as_str()) else {
            return Err(format!(
                "inline object '{}' has no host-injected asset identity (fail-closed: the adapter never invents resources)",
                object.object_id
            ));
        };
        delta.resources.push(Deep2dResource::Image(ImageResource {
            id: object.object_id.clone(),
            revision: 0,
            asset_id: asset.asset_id.clone(),
            width: asset.width,
            height: asset.height,
            color_space: ImageColorSpace::Srgb,
        }));
        delta.commands.push(Deep2dCommand::Image(ImageCommand {
            id: derived_id(&format!("{}.inline.{}", input.id, object.at_cluster))?,
            z_order: 0,
            transform: IDENTITY_MATRIX,
            opacity: None,
            clip_path_ids: None,
            clip_rect: None,
            hit_id: Some(object.object_id.clone()),
            image_id: object.object_id.clone(),
            x: 0.0,
            y: 0.0,
            width: f64::from(asset.width),
            height: f64::from(asset.height),
            atlas_id: None,
            source: None,
            sampling: None,
        }));
    }
    let command_count = delta.commands.len();
    finish(delta, N1InputKind::RichTextInline, command_count, budget)
}

fn paragraph_text(document: &TextDocumentV1, paragraph: &Paragraph) -> Result<String, String> {
    let Some((start, _)) = document.cluster_bytes(paragraph.start_cluster) else {
        return Err(format!(
            "paragraph start cluster {} is out of range",
            paragraph.start_cluster
        ));
    };
    let Some(last) = paragraph.end_cluster.checked_sub(1) else {
        return Err("paragraph must cover at least one cluster".into());
    };
    let Some((_, end)) = document.cluster_bytes(last) else {
        return Err(format!(
            "paragraph end cluster {} is out of range",
            paragraph.end_cluster
        ));
    };
    Ok(document.text()[start..end].to_string())
}

/// 动画 ABI:在注入时刻做关键帧阶梯采样(取 `at_ms <= elapsed` 的最后一帧;
/// 早于首帧则保持首帧),产出封闭的 SetProperty 行为命令。
pub(super) fn adapt_animation(
    input: &AnimationAbiInputV1,
    elapsed_ms: u64,
    budget: &super::N1Budget,
) -> Result<N1Adapted, String> {
    require_id(&input.id, "animation input id")?;
    if input.tracks.len() > budget.max_animation_tracks {
        return Err(format!(
            "animation track budget exceeded: {} tracks > max {}",
            input.tracks.len(),
            budget.max_animation_tracks
        ));
    }
    let mut actions = Vec::new();
    for track in &input.tracks {
        validate_track(track, budget)?;
        let value = track
            .keyframes
            .iter()
            .rev()
            .find(|keyframe| keyframe.at_ms <= elapsed_ms)
            .unwrap_or(&track.keyframes[0])
            .value
            .to_scalar();
        actions.push(BehaviorPayload::SetProperty {
            node_id: track.node_id.clone(),
            property: track.property.into(),
            value,
        });
    }
    if actions.len() > budget.max_commands {
        return Err(format!(
            "command budget exceeded: {} actions > max {}",
            actions.len(),
            budget.max_commands
        ));
    }
    Ok(N1Adapted {
        kind: N1InputKind::AnimationAbi,
        delta: N1DisplayDelta::empty(),
        actions,
    })
}

fn validate_track(track: &AnimationTrackV1, budget: &super::N1Budget) -> Result<(), String> {
    if !stable_node_id(&track.node_id) {
        return Err(format!(
            "animation track node id '{}' is not a stable id",
            track.node_id
        ));
    }
    if track.keyframes.is_empty() {
        return Err(format!(
            "animation track '{}' requires at least one keyframe",
            track.node_id
        ));
    }
    if track.keyframes.len() > budget.max_keyframes_per_track {
        return Err(format!(
            "animation track '{}' exceeds the keyframe budget: {} > max {}",
            track.node_id,
            track.keyframes.len(),
            budget.max_keyframes_per_track
        ));
    }
    for keyframe in &track.keyframes {
        if let ValueV1::Number(value) = keyframe.value
            && !value.is_finite()
        {
            return Err(format!(
                "animation track '{}' keyframe value must be finite",
                track.node_id
            ));
        }
    }
    for pair in track.keyframes.windows(2) {
        if pair[1].at_ms <= pair[0].at_ms {
            return Err(format!(
                "animation track '{}' keyframes must be strictly increasing in atMs",
                track.node_id
            ));
        }
    }
    Ok(())
}

/// 统一出口:总命令预算复核后打包。
pub(super) fn finish(
    delta: N1DisplayDelta,
    kind: N1InputKind,
    command_count: usize,
    budget: &super::N1Budget,
) -> Result<N1Adapted, String> {
    if command_count > budget.max_commands {
        return Err(format!(
            "command budget exceeded: {command_count} commands > max {}",
            budget.max_commands
        ));
    }
    Ok(N1Adapted {
        kind,
        delta,
        actions: Vec::new(),
    })
}
