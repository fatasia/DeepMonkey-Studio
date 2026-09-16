//! N1 适配器共享校验:数值、颜色与 id 的 fail-closed 规则(拒绝即带原因)。

/// Deep2d 命令坐标与长度的统一上界(与 `deep2d::validate` 一致)。
pub(super) const MAX_DRAW_VALUE: f64 = 16_777_216.0;
/// 描边宽度上界(与 deep2d `strokeWidth` 合同一致)。
pub(super) const MAX_STROKE_WIDTH: f64 = 65_536.0;

/// Deep2d 兼容 id:`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`。
pub(super) fn require_id(value: &str, label: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '/' | '-'));
    if valid {
        Ok(())
    } else {
        Err(format!("{label} '{value}' is not a stable display id"))
    }
}

pub(super) fn derived_id(id: &str) -> Result<String, String> {
    require_id(id, "derived command id")?;
    Ok(id.to_string())
}

pub(super) fn require_color(color: &[f64; 4], label: &str) -> Result<(), String> {
    if color
        .iter()
        .all(|channel| channel.is_finite() && (0.0..=1.0).contains(channel))
    {
        Ok(())
    } else {
        Err(format!(
            "{label} must be four finite RGBA channels in [0, 1]"
        ))
    }
}

pub(super) fn require_bounded_coordinate(value: f64, label: &str) -> Result<(), String> {
    if value.is_finite() && value.abs() <= MAX_DRAW_VALUE {
        Ok(())
    } else {
        Err(format!("{label} must be finite within ±{MAX_DRAW_VALUE}"))
    }
}

pub(super) fn require_positive(value: f64, label: &str) -> Result<(), String> {
    require_positive_bounded(value, MAX_DRAW_VALUE, label)
}

pub(super) fn require_positive_bounded(value: f64, max: f64, label: &str) -> Result<(), String> {
    if value.is_finite() && value > 0.0 && value <= max {
        Ok(())
    } else {
        Err(format!("{label} must be finite in (0, {max}]"))
    }
}
