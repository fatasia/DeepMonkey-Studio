use super::{
    DEEP_2D_DISPLAY_LIST_BUDGETS, DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION, Deep2dDisplayList,
    Deep2dIssue, Deep2dIssueCode, Deep2dMatrix, Deep2dValidationResult,
};

const MAX_INPUT_BYTES: usize = 160 * 1024 * 1024;
pub(super) const MAX_DRAW_VALUE: f64 = 16_777_216.0;
pub(super) const MAX_IMAGE_DIMENSION: u32 = 65_536;
const MAX_ISSUES: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ResourceKind {
    Path,
    Font,
    Image,
}

pub fn decode_display_list(bytes: &[u8]) -> Result<Deep2dDisplayList, String> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("Deep2dDisplayList exceeds the 160 MiB input limit".into());
    }
    let display_list: Deep2dDisplayList = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid Deep2dDisplayList JSON: {error}"))?;
    let result = validate_display_list(&display_list);
    if let Some(issue) = result.issues.first() {
        return Err(format!(
            "invalid Deep2dDisplayList: {} at {} ({:?})",
            issue.message, issue.path, issue.code
        ));
    }
    Ok(display_list)
}

pub fn validate_display_list(display_list: &Deep2dDisplayList) -> Deep2dValidationResult {
    let mut validator = Validator::default();
    if display_list.schema_version != DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION {
        validator.add(
            Deep2dIssueCode::InvalidSchemaVersion,
            "schemaVersion",
            format!("Expected schema version {DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION}."),
        );
    }
    validator.id(&display_list.id, "id");
    validator.revision(display_list.revision, "revision");
    validator.positive(display_list.logical_width, "logicalWidth", MAX_DRAW_VALUE);
    validator.positive(display_list.logical_height, "logicalHeight", MAX_DRAW_VALUE);
    validator.positive(display_list.scale_factor, "scaleFactor", 16.0);

    if display_list.resources.len() > DEEP_2D_DISPLAY_LIST_BUDGETS.resources {
        validator.add(
            Deep2dIssueCode::BudgetExceeded,
            "resources",
            format!(
                "At most {} resources are allowed.",
                DEEP_2D_DISPLAY_LIST_BUDGETS.resources
            ),
        );
    }
    if display_list.commands.len() > DEEP_2D_DISPLAY_LIST_BUDGETS.commands {
        validator.add(
            Deep2dIssueCode::BudgetExceeded,
            "commands",
            format!(
                "At most {} commands are allowed.",
                DEEP_2D_DISPLAY_LIST_BUDGETS.commands
            ),
        );
    }
    if display_list.resources.len() > DEEP_2D_DISPLAY_LIST_BUDGETS.resources
        || display_list.commands.len() > DEEP_2D_DISPLAY_LIST_BUDGETS.commands
    {
        return validator.finish();
    }

    let resources = validator.resources(&display_list.resources);
    validator.commands(&display_list.commands, &resources);
    validator.finish()
}

#[derive(Default)]
pub(super) struct Validator {
    issues: Vec<Deep2dIssue>,
}

impl Validator {
    pub(super) fn add(
        &mut self,
        code: Deep2dIssueCode,
        path: impl Into<String>,
        message: impl Into<String>,
    ) {
        if self.issues.len() < MAX_ISSUES {
            self.issues.push(Deep2dIssue {
                code,
                path: path.into(),
                message: message.into(),
            });
        }
    }

    fn finish(self) -> Deep2dValidationResult {
        Deep2dValidationResult {
            valid: self.issues.is_empty(),
            issues: self.issues,
        }
    }

    pub(super) fn id(&mut self, value: &str, path: &str) -> bool {
        let valid = (1..=256).contains(&value.len())
            && value.is_ascii()
            && value.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_alphanumeric() || (index > 0 && b"._:/-".contains(&byte))
            })
            && !matches!(value, "__proto__" | "prototype" | "constructor");
        if !valid {
            self.add(
                Deep2dIssueCode::InvalidId,
                path,
                "Expected a stable 1..256 character ASCII identifier.",
            );
        }
        valid
    }

    pub(super) fn revision(&mut self, value: u64, path: &str) {
        if value > MAX_SAFE_INTEGER {
            self.add(
                Deep2dIssueCode::InvalidRevision,
                path,
                "Expected a non-negative JSON-safe integer revision.",
            );
        }
    }

    pub(super) fn draw_number(&mut self, value: f64, path: &str) {
        if !value.is_finite() || value.abs() > MAX_DRAW_VALUE {
            self.add(
                Deep2dIssueCode::InvalidNumber,
                path,
                format!(
                    "Expected a finite value with absolute magnitude at most {MAX_DRAW_VALUE}."
                ),
            );
        }
    }

    pub(super) fn positive(&mut self, value: f64, path: &str, limit: f64) {
        if !value.is_finite() || value <= 0.0 || value > limit {
            self.add(
                Deep2dIssueCode::InvalidNumber,
                path,
                format!("Expected a finite value in (0, {limit}]."),
            );
        }
    }

    pub(super) fn color(&mut self, value: &[f64; 4], path: &str) {
        if value
            .iter()
            .any(|channel| !channel.is_finite() || !(0.0..=1.0).contains(channel))
        {
            self.add(
                Deep2dIssueCode::InvalidColor,
                path,
                "Expected four finite RGBA channels in [0, 1].",
            );
        }
    }

    pub(super) fn matrix(&mut self, value: &Deep2dMatrix, path: &str) {
        if value
            .iter()
            .any(|item| !item.is_finite() || item.abs() > MAX_DRAW_VALUE)
        {
            self.add(
                Deep2dIssueCode::InvalidTransform,
                path,
                "Expected six bounded finite affine-matrix values.",
            );
        }
    }
}
