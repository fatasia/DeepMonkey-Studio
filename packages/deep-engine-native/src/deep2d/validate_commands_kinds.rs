//! Per-command-kind validation for Deep2d display lists (path, text, image).
//! Shared envelope checks live in `validate_commands`.

use std::collections::HashMap;

use super::runtime_types::{Deep2dAtlas, Deep2dAtlasKind};
use super::validate::{MAX_DRAW_VALUE, ResourceKind, Validator};
use super::{
    DEEP_2D_DISPLAY_LIST_BUDGETS, Deep2dIssueCode, ImageCommand, PathCommand, TextCommand,
};

impl Validator {
    pub(super) fn path_command(
        &mut self,
        command: &PathCommand,
        path: &str,
        resources: &HashMap<&str, ResourceKind>,
    ) {
        self.base_command(
            &command.transform,
            command.opacity,
            command.clip_path_ids.as_deref(),
            command.clip_rect.as_ref(),
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

    pub(super) fn text_command(
        &mut self,
        command: &TextCommand,
        path: &str,
        resources: &HashMap<&str, ResourceKind>,
        atlases: &[Deep2dAtlas],
        total_text_code_units: &mut usize,
        total_baked_glyphs: &mut usize,
    ) {
        self.base_command(
            &command.transform,
            command.opacity,
            command.clip_path_ids.as_deref(),
            command.clip_rect.as_ref(),
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
        self.text_atlas(
            command,
            path,
            resources,
            atlases,
            code_units,
            total_baked_glyphs,
        );
    }

    pub(super) fn image_command(
        &mut self,
        command: &ImageCommand,
        path: &str,
        resources: &HashMap<&str, ResourceKind>,
        atlases: &[Deep2dAtlas],
    ) {
        self.base_command(
            &command.transform,
            command.opacity,
            command.clip_path_ids.as_deref(),
            command.clip_rect.as_ref(),
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
        self.image_atlas(command, path, resources, atlases);
    }

    fn image_atlas(
        &mut self,
        command: &ImageCommand,
        path: &str,
        resources: &HashMap<&str, ResourceKind>,
        atlases: &[Deep2dAtlas],
    ) {
        let Some(atlas_id) = &command.atlas_id else {
            if command.source.is_some() {
                self.add(
                    Deep2dIssueCode::InvalidStructure,
                    format!("{path}.source"),
                    "Image source requires atlasId.",
                );
            }
            return;
        };
        self.require_resource(
            atlas_id,
            ResourceKind::Atlas,
            &format!("{path}.atlasId"),
            resources,
        );
        let Some([sx, sy, sw, sh]) = command.source else {
            self.add(
                Deep2dIssueCode::InvalidStructure,
                format!("{path}.source"),
                "Image atlasId requires a pixel-space source rect.",
            );
            return;
        };
        if sw == 0 || sh == 0 {
            self.add(
                Deep2dIssueCode::InvalidNumber,
                format!("{path}.source"),
                "Source rect must have positive area.",
            );
        }
        if let Some(atlas) = atlases.iter().find(|atlas| &atlas.id == atlas_id) {
            if atlas.kind != Deep2dAtlasKind::Image {
                self.add(
                    Deep2dIssueCode::ResourceKindMismatch,
                    format!("{path}.atlasId"),
                    "Image command requires an image atlas.",
                );
            }
            if command
                .sampling
                .is_some_and(|value| value != atlas.sampling)
            {
                self.add(
                    Deep2dIssueCode::InvalidStructure,
                    format!("{path}.sampling"),
                    "Per-command sampling must match the referenced atlas.",
                );
            }
            if (u64::from(sx) + u64::from(sw)) > u64::from(atlas.width)
                || (u64::from(sy) + u64::from(sh)) > u64::from(atlas.height)
            {
                self.add(
                    Deep2dIssueCode::InvalidNumber,
                    format!("{path}.source"),
                    "Source rect escapes the atlas bounds.",
                );
            }
        }
    }
}
