//! Actual legend labels use the existing text raster and image upload path.
use super::{
    ChartRuntime,
    legend::{LegendAction, LegendFrame},
};
use crate::{
    deep2d::{Deep2dDisplayList, validate_display_list},
    native_ui::design_tokens::DesignTokenTheme,
    platform_text::{TextRasterRequest, TextRasterizer},
};

pub fn append_legend(
    list: &mut Deep2dDisplayList,
    chart: &ChartRuntime,
    rasterizer: &mut TextRasterizer,
    theme: &DesignTokenTheme,
    page: usize,
    legend_focus: Option<usize>,
) -> Result<LegendFrame, String> {
    let frame = LegendFrame::prepare(chart, page)?;
    let mut layers = Vec::new();
    for item in frame.items.iter() {
        let color = if item.hidden {
            theme.colors.text_muted
        } else {
            theme.colors.text_strong
        }
        .ok_or("legend text token missing")?;
        if color
            .into_iter()
            .any(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
        {
            return Err("legend color token invalid".into());
        }
        let font_size = theme.typography.font_size_base;
        let line_height = font_size * theme.typography.line_height;
        let padding = theme.spacing.space_1;
        let width = (item.rect[2] - padding * 2.0).floor();
        let height = item.rect[3].floor();
        if !padding.is_finite()
            || padding < 0.0
            || !width.is_finite()
            || !(1.0..=2048.0).contains(&width)
            || !(height.is_nan() || (1.0..=2048.0).contains(&height))
        {
            return Err("legend text viewport invalid".into());
        }
        let family = theme
            .typography
            .font_family
            .split(',')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches(['\'', '"']);
        // 图标前缀按同一字体实测宽度;标签按可用宽度测量截断,替代字符数硬截断。
        let icon = match &item.action {
            LegendAction::Toggle(_) => Some(if item.hidden { "○ " } else { "✓ " }),
            LegendAction::Page(_) => None,
        };
        let available = width
            - icon
                .map(|prefix| {
                    f64::from(
                        rasterizer
                            .measure(prefix, family, font_size as f32, line_height as f32)
                            .unwrap_or(0.0),
                    )
                    .ceil()
                })
                .unwrap_or(0.0);
        let label = fit_ellipsis(
            rasterizer,
            &item.label,
            family,
            font_size as f32,
            line_height as f32,
            available,
            24,
        )?;
        let text = match icon {
            Some(prefix) => format!("{prefix}{label}"),
            None => label,
        };
        let pixels = rasterizer.rasterize(TextRasterRequest {
            text: &text,
            family,
            font_size: font_size as f32,
            line_height: line_height as f32,
            width: width as u32,
            height: height as u32,
            color: color.map(|v| (v * 255.0).round() as u8),
        })?;
        let identity = match &item.action {
            LegendAction::Toggle(id) => serde_json::json!(["series", id]),
            LegendAction::Page(page) => serde_json::json!(["page", page]),
        };
        let key = crate::runtime_package::runtime_content_sha256(&serde_json::json!([
            "chart-legend",
            chart.source().id,
            identity
        ]));
        layers.push(pixels.into_display_list(
            &key,
            chart.revision(),
            [list.logical_width, list.logical_height],
            [item.rect[0] + padding, item.rect[1]],
            i32::MAX - 2,
        )?);
    }
    // Build a candidate so failed font/contract preparation never partly appends.
    let mut candidate = list.clone();
    for mut layer in layers {
        candidate.resources.append(&mut layer.resources);
        candidate.commands.append(&mut layer.commands);
        candidate.atlases.append(&mut layer.atlases);
    }
    if let Some(item) = legend_focus.and_then(|index| frame.items.get(index)) {
        draw_focus_ring(&mut candidate, item, chart.revision(), page, theme)?;
    }
    let validation = validate_display_list(&candidate);
    if !validation.valid {
        return Err(format!("chart legend: {:?}", validation.issues));
    }
    *list = candidate;
    Ok(frame)
}

/// 键盘焦点环:围绕图例项的外扩描边(native_ui 控件环是内缩方向,小尺寸文本行
/// 需要外扩避免压住标签);与图例文本同 z,追加在其后自然盖在其上。
fn draw_focus_ring(
    list: &mut Deep2dDisplayList,
    item: &super::legend::LegendItem,
    revision: u64,
    page: usize,
    theme: &DesignTokenTheme,
) -> Result<(), String> {
    use crate::deep2d::{Deep2dCommand, Deep2dPathVerb, Deep2dResource};
    const EXPAND: f64 = 3.0;
    let accent = theme
        .colors
        .accent
        .ok_or("legend focus accent token missing")?;
    if accent
        .into_iter()
        .any(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
    {
        return Err("legend focus accent token invalid".into());
    }
    let [x, y, width, height] = item.rect;
    if [x, y, width, height]
        .into_iter()
        .any(|v| !v.is_finite() || v < -EXPAND)
    {
        return Err("legend focus ring rect invalid".into());
    }
    let ring = [
        x - EXPAND,
        y - EXPAND,
        width + EXPAND * 2.0,
        height + EXPAND * 2.0,
    ];
    let id = format!("legend.focus-ring.p{page}");
    list.resources
        .push(Deep2dResource::Path(crate::deep2d::PathResource {
            id: id.clone(),
            revision,
            // 环中心线落在原始 rect 边界上,外扩由 transform 原点承担,顶点用本地坐标。
            verbs: vec![
                Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
                Deep2dPathVerb::Line { x: ring[2], y: 0.0 },
                Deep2dPathVerb::Line {
                    x: ring[2],
                    y: ring[3],
                },
                Deep2dPathVerb::Line { x: 0.0, y: ring[3] },
                Deep2dPathVerb::Close,
            ],
        }));
    list.commands
        .push(Deep2dCommand::Path(crate::deep2d::PathCommand {
            id: format!("{id}.focus"),
            z_order: i32::MAX - 2,
            transform: [1.0, 0.0, 0.0, 1.0, ring[0], ring[1]],
            opacity: None,
            clip_path_ids: None,
            clip_rect: None,
            hit_id: None,
            path_id: id,
            fill: None,
            fill_rule: None,
            stroke: Some(accent),
            stroke_width: Some(STROKE_RING_WIDTH),
            line_cap: None,
            line_join: None,
            miter_limit: None,
            dash: None,
            dash_offset: None,
        }));
    Ok(())
}

const STROKE_RING_WIDTH: f64 = 2.0;

/// 按真实字形测量把标签截到可用宽度;二分前缀,O(log n) 次测量,字符数只作搜索上界。
pub fn fit_ellipsis(
    rasterizer: &mut TextRasterizer,
    text: &str,
    family: &str,
    font_size: f32,
    line_height: f32,
    max_width: f64,
    max_chars: usize,
) -> Result<String, String> {
    let normalized: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if !max_width.is_finite() || max_width < 1.0 || max_chars == 0 {
        return Err("legend text fit budget invalid".into());
    }
    if rasterizer.measure(&normalized, family, font_size, line_height)? <= max_width as f32 {
        return Ok(normalized);
    }
    let chars: Vec<char> = normalized.chars().take(max_chars).collect();
    let ellipsis = '…';
    let fits = |prefix_len: usize, rasterizer: &mut TextRasterizer| -> Result<bool, String> {
        let candidate: String = chars[..prefix_len]
            .iter()
            .chain(std::iter::once(&ellipsis))
            .collect();
        Ok(rasterizer.measure(&candidate, family, font_size, line_height)? <= max_width as f32)
    };
    let mut lo = 0usize;
    let mut hi = chars.len();
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if fits(mid, rasterizer)? {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    if lo == 0 {
        return Ok(ellipsis.to_string());
    }
    let mut fitted: String = chars[..lo].iter().collect();
    fitted.push(ellipsis);
    Ok(fitted)
}
