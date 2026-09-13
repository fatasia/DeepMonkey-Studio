use super::{Deep2dAtlasQuad, Deep2dIssue, Deep2dIssueCode, Deep2dValidationResult};

const MAX_DRAW_VALUE: f64 = 16_777_216.0;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn validate_quad_numbers(
    quad: &Deep2dAtlasQuad,
    path: &str,
    issues: &mut Vec<Deep2dIssue>,
) {
    if quad.transform.iter().any(|value| !bounded(*value)) {
        add(
            issues,
            Deep2dIssueCode::InvalidTransform,
            format!("{path}.transform"),
            "Expected six bounded finite affine values.",
        );
    }
    if quad.destination.iter().any(|value| !bounded(*value))
        || quad.destination[2] <= 0.0
        || quad.destination[3] <= 0.0
    {
        add(
            issues,
            Deep2dIssueCode::InvalidNumber,
            format!("{path}.destination"),
            "Destination must contain bounded finite x/y and positive width/height.",
        );
    }
    if quad
        .color
        .iter()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        add(
            issues,
            Deep2dIssueCode::InvalidColor,
            format!("{path}.color"),
            "Expected four finite RGBA channels in [0, 1].",
        );
    }
    if !quad.opacity.is_finite() || !(0.0..=1.0).contains(&quad.opacity) {
        add(
            issues,
            Deep2dIssueCode::InvalidNumber,
            format!("{path}.opacity"),
            "Opacity must be finite and in [0, 1].",
        );
    }
}

pub(super) fn validate_id(value: &str, path: &str, issues: &mut Vec<Deep2dIssue>) -> bool {
    let valid = (1..=256).contains(&value.len())
        && value.is_ascii()
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && b"._:/-".contains(&byte))
        })
        && !matches!(value, "__proto__" | "prototype" | "constructor");
    if !valid {
        add(
            issues,
            Deep2dIssueCode::InvalidId,
            path,
            "Expected a stable 1..256 character ASCII identifier.",
        );
    }
    valid
}

pub(super) fn validate_revision(value: u64, path: &str, issues: &mut Vec<Deep2dIssue>) {
    if value > MAX_SAFE_INTEGER {
        add(
            issues,
            Deep2dIssueCode::InvalidRevision,
            path,
            "Expected a JSON-safe revision.",
        );
    }
}

fn bounded(value: f64) -> bool {
    value.is_finite() && value.abs() <= MAX_DRAW_VALUE
}

pub(super) fn finish(issues: Vec<Deep2dIssue>) -> Deep2dValidationResult {
    Deep2dValidationResult {
        valid: issues.is_empty(),
        issues,
    }
}

pub(super) fn add(
    issues: &mut Vec<Deep2dIssue>,
    code: Deep2dIssueCode,
    path: impl Into<String>,
    message: impl Into<String>,
) {
    if issues.len() < 256 {
        issues.push(Deep2dIssue {
            code,
            path: path.into(),
            message: message.into(),
        });
    }
}
