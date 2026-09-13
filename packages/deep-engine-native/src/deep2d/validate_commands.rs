use std::collections::{HashMap, HashSet};

use super::validate::{MAX_DRAW_VALUE, ResourceKind, Validator};
use super::{
    DEEP_2D_DISPLAY_LIST_BUDGETS, Deep2dCommand, Deep2dIssueCode, Deep2dMatrix, ImageCommand,
    PathCommand, TextCommand,
};

impl Validator {
    pub(super) fn commands(
        &mut self,
        commands: &[Deep2dCommand],
        resources: &HashMap<&str, ResourceKind>,
    ) {
        let mut command_ids = HashSet::new();
        let mut total_text_code_units = 0usize;
        for (index, command) in commands.iter().enumerate() {
            let path = format!("commands[{index}]");
            let id = match command {
                Deep2dCommand::Path(value) => &value.id,
                Deep2dCommand::Text(value) => &value.id,
                Deep2dCommand::Image(value) => &value.id,
            };
            if self.id(id, &format!("{path}.id")) && !command_ids.insert(id) {
                self.add(
                    Deep2dIssueCode::DuplicateId,
                    format!("{path}.id"),
                    format!("Duplicate command id: {id}."),
                );
            }
            match command {
                Deep2dCommand::Path(value) => self.path_command(value, &path, resources),
                Deep2dCommand::Text(value) => {
                    self.text_command(value, &path, resources, &mut total_text_code_units)
                }
                Deep2dCommand::Image(value) => self.image_command(value, &path, resources),
            }
        }
        if total_text_code_units > DEEP_2D_DISPLAY_LIST_BUDGETS.text_code_units_total {
            self.add(
                Deep2dIssueCode::BudgetExceeded,
                "commands",
                format!(
                    "Display list exceeds {} total text code units.",
                    DEEP_2D_DISPLAY_LIST_BUDGETS.text_code_units_total
                ),
            );
        }
    }

    fn base_command(
        &mut self,
        transform: &Deep2dMatrix,
        opacity: Option<f64>,
        clips: Option<&[String]>,
        hit_id: Option<&str>,
        path: &str,
        resources: &HashMap<&str, ResourceKind>,
    ) {
        self.matrix(transform, &format!("{path}.transform"));
        if let Some(value) = opacity
            && (!value.is_finite() || !(0.0..=1.0).contains(&value))
        {
            self.add(
                Deep2dIssueCode::InvalidNumber,
                format!("{path}.opacity"),
                "Opacity must be in [0, 1].",
            );
        }
        if let Some(value) = hit_id {
            self.id(value, &format!("{path}.hitId"));
        }
        if let Some(values) = clips {
            if values.len() > DEEP_2D_DISPLAY_LIST_BUDGETS.clips_per_command {
                self.add(
                    Deep2dIssueCode::BudgetExceeded,
                    format!("{path}.clipPathIds"),
                    format!(
                        "At most {} clips are allowed per command.",
                        DEEP_2D_DISPLAY_LIST_BUDGETS.clips_per_command
                    ),
                );
            } else {
                for (index, id) in values.iter().enumerate() {
                    self.require_resource(
                        id,
                        ResourceKind::Path,
                        &format!("{path}.clipPathIds[{index}]"),
                        resources,
                    );
                }
            }
        }
    }

    fn path_command(
        &mut self,
        command: &PathCommand,
        path: &str,
        resources: &HashMap<&str, ResourceKind>,
    ) {
        self.base_command(
            &command.transform,
            command.opacity,
            command.clip_path_ids.as_deref(),
            command.hit_id.as_deref(),
            path,
            resources,
        );
        self.require_resource(
            &command.path_id,
            ResourceKind::Path,
            &format!("{path}.pathId"),
            resources,
        );
        if command.fill.is_none() && command.stroke.is_none() {
            self.add(
                Deep2dIssueCode::EmptyPaint,
                path,
                "Path command requires fill or stroke.",
            );
        }
        if let Some(color) = &command.fill {
            self.color(color, &format!("{path}.fill"));
        } else if command.fill_rule.is_some() {
            self.add(
                Deep2dIssueCode::InvalidStructure,
                format!("{path}.fillRule"),
                "Fill rule requires fill paint.",
            );
        }
        if let Some(color) = &command.stroke {
            self.color(color, &format!("{path}.stroke"));
            self.positive(
                command.stroke_width.unwrap_or(f64::NAN),
                &format!("{path}.strokeWidth"),
                65_536.0,
            );
        } else if command.line_cap.is_some()
            || command.line_join.is_some()
            || command.miter_limit.is_some()
            || command.dash.is_some()
            || command.dash_offset.is_some()
        {
            self.add(
                Deep2dIssueCode::InvalidStructure,
                path,
                "Stroke style fields require stroke paint.",
            );
        }
        if let Some(value) = command.miter_limit {
            self.positive(value, &format!("{path}.miterLimit"), 65_536.0);
        }
        if let Some(values) = &command.dash
            && (values.is_empty()
                || values.len() > DEEP_2D_DISPLAY_LIST_BUDGETS.dash_entries
                || values
                    .iter()
                    .any(|value| !value.is_finite() || *value < 0.0 || *value > MAX_DRAW_VALUE)
                || !values.iter().any(|value| value.is_finite() && *value > 0.0))
        {
            self.add(
                Deep2dIssueCode::InvalidNumber,
                format!("{path}.dash"),
                "Dash must be a bounded non-empty array of non-negative finite lengths with at least one positive entry.",
            );
        }
        if let Some(value) = command.dash_offset {
            self.draw_number(value, &format!("{path}.dashOffset"));
        }
    }

    fn text_command(
        &mut self,
        command: &TextCommand,
        path: &str,
        resources: &HashMap<&str, ResourceKind>,
        total_text_code_units: &mut usize,
    ) {
        self.base_command(
            &command.transform,
            command.opacity,
            command.clip_path_ids.as_deref(),
            command.hit_id.as_deref(),
            path,
            resources,
        );
        self.require_resource(
            &command.font_id,
            ResourceKind::Font,
            &format!("{path}.fontId"),
            resources,
        );
        self.color(&command.color, &format!("{path}.color"));
        let code_units = command.text.encode_utf16().count();
        if code_units > DEEP_2D_DISPLAY_LIST_BUDGETS.text_code_units_per_command {
            self.add(
                Deep2dIssueCode::InvalidStructure,
                format!("{path}.text"),
                "Expected bounded well-formed Unicode text.",
            );
        } else {
            *total_text_code_units = total_text_code_units.saturating_add(code_units);
        }
        self.draw_number(command.x, &format!("{path}.x"));
        self.draw_number(command.y, &format!("{path}.y"));
        self.positive(command.font_size, &format!("{path}.fontSize"), 65_536.0);
        if let Some(value) = command.max_width {
            self.positive(value, &format!("{path}.maxWidth"), MAX_DRAW_VALUE);
        }
    }

    fn image_command(
        &mut self,
        command: &ImageCommand,
        path: &str,
        resources: &HashMap<&str, ResourceKind>,
    ) {
        self.base_command(
            &command.transform,
            command.opacity,
            command.clip_path_ids.as_deref(),
            command.hit_id.as_deref(),
            path,
            resources,
        );
        self.require_resource(
            &command.image_id,
            ResourceKind::Image,
            &format!("{path}.imageId"),
            resources,
        );
        self.draw_number(command.x, &format!("{path}.x"));
        self.draw_number(command.y, &format!("{path}.y"));
        self.positive(command.width, &format!("{path}.width"), MAX_DRAW_VALUE);
        self.positive(command.height, &format!("{path}.height"), MAX_DRAW_VALUE);
    }

    fn require_resource(
        &mut self,
        id: &str,
        expected: ResourceKind,
        path: &str,
        resources: &HashMap<&str, ResourceKind>,
    ) {
        match resources.get(id) {
            None => self.add(
                Deep2dIssueCode::MissingResource,
                path,
                format!("Missing {} resource: {id}.", resource_name(expected)),
            ),
            Some(actual) if *actual != expected => self.add(
                Deep2dIssueCode::ResourceKindMismatch,
                path,
                format!("Expected {} resource: {id}.", resource_name(expected)),
            ),
            Some(_) => {}
        }
    }
}

fn resource_name(kind: ResourceKind) -> &'static str {
    match kind {
        ResourceKind::Path => "path",
        ResourceKind::Font => "font",
        ResourceKind::Image => "image",
    }
}
