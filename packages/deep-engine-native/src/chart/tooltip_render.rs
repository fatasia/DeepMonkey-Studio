//! Token-driven tooltip pixels composed with the committed chart geometry.
use super::ChartRuntime;
use crate::deep2d::{Deep2dCommand, Deep2dDisplayList, Deep2dResource, validate_display_list};
use crate::native_ui::{control_render::ControlCanvas, design_tokens::DesignTokenTheme};
use crate::platform_text::{TextRasterRequest, TextRasterizer};

pub fn compose_tooltip(
    chart: &ChartRuntime,
    rasterizer: &mut TextRasterizer,
    theme: &DesignTokenTheme,
    anchor: [f64; 2],
) -> Result<Deep2dDisplayList, String> {
    let mut list = chart.frame().display_list().clone();
    list.revision = chart.revision();
    let Some(tooltip) = super::tooltip_content::tooltip_content(chart) else {
        return Ok(list);
    };
    let color = theme
        .colors
        .text_strong
        .ok_or("tooltip text token missing")?;
    let background = theme
        .colors
        .surface1
        .ok_or("tooltip surface token missing")?;
    if color
        .into_iter()
        .chain(background)
        .any(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
    {
        return Err("tooltip color token invalid".into());
    }
    let padding = theme.spacing.space_2;
    let font_size = theme.typography.font_size_base;
    let line_height = font_size * theme.typography.line_height;
    if [padding, font_size, line_height, theme.radii.radius_sm]
        .into_iter()
        .any(|v| !v.is_finite() || v < 0.0)
        || padding > 64.0
        || !(1.0..=256.0).contains(&font_size)
        || !(1.0..=512.0).contains(&line_height)
    {
        return Err("tooltip metrics invalid".into());
    }
    let canvas = [list.logical_width, list.logical_height];
    let width = 240.0_f64.min(canvas[0] - padding * 2.0).floor();
    let lines = 1 + tooltip.entries.len() + usize::from(tooltip.omitted > 0);
    let height = (line_height * (lines.max(4) as f64) + padding * 2.0)
        .ceil()
        .min(canvas[1] - padding * 2.0)
        .floor();
    let rect = tooltip_rect(canvas, anchor, [width, height], padding)?;
    let inner = [
        (width - 2.0 * padding).floor(),
        (height - 2.0 * padding).floor(),
    ];
    if inner.into_iter().any(|v| v < 1.0) {
        return Err("chart is too small for tooltip text".into());
    }
    let family = theme
        .typography
        .font_family
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(['\'', '"']);
    // 每行整体按 inner 宽度实测截断(替代按字符数截断),保证窄窗与长中文不撑破版面。
    let mut fit = |line: &str| -> Result<String, String> {
        super::legend_render::fit_ellipsis(
            rasterizer,
            line,
            family,
            font_size as f32,
            line_height as f32,
            inner[0],
            64,
        )
    };
    let mut text = fit(&tooltip.heading)?;
    for entry in &tooltip.entries {
        let line = format!("{}: {}", entry.label, entry.value);
        text.push('\n');
        text.push_str(&fit(&line)?);
    }
    if tooltip.omitted > 0 {
        text.push('\n');
        text.push_str(&fit(&format!("另 {} 项", tooltip.omitted))?);
    }
    let pixels = rasterizer.rasterize_for_display(TextRasterRequest {
        text: &text,
        family,
        font_size: font_size as f32,
        line_height: line_height as f32,
        width: inner[0] as u32,
        height: inner[1] as u32,
        color: color.map(|v| (v * 255.0).round() as u8),
    })?;
    let key = crate::runtime_package::runtime_content_sha256(&serde_json::json!([
        "chart-tooltip",
        chart.source().id
    ]));
    let mut paint = ControlCanvas::new();
    paint.fill_rect(
        &format!("tooltip-{key}"),
        rect,
        background,
        theme.radii.radius_sm,
        1.0,
    );
    let mut panel = paint.into_display_list(canvas[0], canvas[1]);
    for resource in &mut panel.resources {
        if let Deep2dResource::Path(path) = resource {
            path.revision = chart.revision();
        }
    }
    for command in &mut panel.commands {
        if let Deep2dCommand::Path(path) = command {
            path.z_order = i32::MAX - 1;
        }
    }
    let mut label = pixels.into_display_list(
        &format!("tooltip-{key}"),
        chart.revision(),
        canvas,
        [rect[0] + padding, rect[1] + padding],
        i32::MAX,
    )?;
    list.resources.append(&mut panel.resources);
    list.commands.append(&mut panel.commands);
    list.resources.append(&mut label.resources);
    list.commands.append(&mut label.commands);
    list.atlases.append(&mut label.atlases);
    let validation = validate_display_list(&list);
    if !validation.valid {
        return Err(format!("chart tooltip: {:?}", validation.issues));
    }
    Ok(list)
}

/// Flip at the right/bottom edge, then clamp to the logical canvas.
pub fn tooltip_rect(
    canvas: [f64; 2],
    anchor: [f64; 2],
    size: [f64; 2],
    gap: f64,
) -> Result<[f64; 4], String> {
    if canvas
        .into_iter()
        .chain(anchor)
        .chain(size)
        .chain([gap])
        .any(|v| !v.is_finite())
        || gap < 0.0
        || (0..2).any(|i| size[i] <= 0.0 || size[i] + gap * 2.0 > canvas[i])
    {
        return Err("invalid tooltip bounds".into());
    }
    let origin = std::array::from_fn::<_, 2, _>(|i| {
        let forward = anchor[i] + gap;
        let proposed = if forward + size[i] > canvas[i] - gap {
            anchor[i] - gap - size[i]
        } else {
            forward
        };
        proposed.clamp(gap, canvas[i] - size[i] - gap)
    });
    Ok([origin[0], origin[1], size[0], size[1]])
}
