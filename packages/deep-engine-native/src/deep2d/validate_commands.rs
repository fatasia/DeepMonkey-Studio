use std::collections::{HashMap, HashSet};

use super::runtime_types::Deep2dAtlas;
use super::types::Deep2dRect;
use super::validate::{MAX_DRAW_VALUE, ResourceKind, Validator};
use super::{DEEP_2D_DISPLAY_LIST_BUDGETS, Deep2dCommand, Deep2dIssueCode, Deep2dMatrix};

impl Validator {
    pub(super) fn commands(
        &mut self,
        commands: &[Deep2dCommand],
        resources: &HashMap<&str, ResourceKind>,
        atlases: &[Deep2dAtlas],
    ) {
        let mut command_ids = HashSet::new();
        let mut total_text_code_units = 0usize;
        let mut total_baked_glyphs = 0usize;
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
                Deep2dCommand::Text(value) => self.text_command(
                    value,
                    &path,
                    resources,
                    atlases,
                    &mut total_text_code_units,
                    &mut total_baked_glyphs,
                ),
                Deep2dCommand::Image(value) => self.image_command(value, &path, resources, atlases),
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
        if total_baked_glyphs > DEEP_2D_DISPLAY_LIST_BUDGETS.commands {
            self.add(
                Deep2dIssueCode::BudgetExceeded,
                "commands",
                format!(
                    "Display list exceeds {} baked glyphs.",
                    DEEP_2D_DISPLAY_LIST_BUDGETS.commands
                ),
            );
        }
    }

    #[allow(clippy::too_many_arguments)] // Mirrors the flat display-list command shape.
    pub(super) fn base_command(
        &mut self,
        transform: &Deep2dMatrix,
        opacity: Option<f64>,
        clips: Option<&[String]>,
        clip_rect: Option<&Deep2dRect>,
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
        if let Some(rect) = clip_rect {
            if clips.is_some_and(|values| !values.is_empty()) {
                self.add(
                    Deep2dIssueCode::InvalidStructure,
                    path,
                    "clipRect and clipPathIds are mutually exclusive clip definitions.",
                );
            }
            for (field, value) in [
                ("x", rect.x),
                ("y", rect.y),
                ("width", rect.width),
                ("height", rect.height),
            ] {
                if !value.is_finite() || value.abs() > MAX_DRAW_VALUE {
                    self.add(
                        Deep2dIssueCode::InvalidNumber,
                        format!("{path}.clipRect.{field}"),
                        format!("Clip rect {field} must be a finite bounded number."),
                    );
                }
            }
            if rect.width <= 0.0 || rect.height <= 0.0 {
                self.add(
                    Deep2dIssueCode::InvalidNumber,
                    format!("{path}.clipRect"),
                    "Clip rect width and height must be positive.",
                );
            }
        }
    }

    pub(super) fn require_resource(
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
        ResourceKind::Atlas => "atlas",
    }
}
