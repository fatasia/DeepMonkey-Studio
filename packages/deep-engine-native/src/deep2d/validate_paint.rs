//! Paint-model validation (fail-closed): solid colors, gradient geometry and
//! stops, corner radii and box shadows. Shared by path fills and future paint
//! consumers; negative blur/radius/stops must be rejected with issue codes.

use super::types::Deep2dIssueCode;
use super::validate::{MAX_DRAW_VALUE, Validator};
use super::{
    BoxShadow, DEEP_2D_DISPLAY_LIST_BUDGETS, Deep2dPaint, GradientStop, LinearGradientPaint,
    RadialGradientPaint,
};

impl Validator {
    pub(super) fn paint(&mut self, paint: &Deep2dPaint, path: &str) {
        match paint {
            Deep2dPaint::Solid(color) => self.color(color, path),
            Deep2dPaint::LinearGradient(gradient) => {
                self.linear_gradient(gradient, path);
            }
            Deep2dPaint::RadialGradient(gradient) => {
                self.radial_gradient(gradient, path);
            }
        }
    }

    fn linear_gradient(&mut self, gradient: &LinearGradientPaint, path: &str) {
        for (axis, value) in gradient.start.iter().enumerate() {
            self.draw_number(*value, &format!("{path}.start[{axis}]"));
        }
        for (axis, value) in gradient.end.iter().enumerate() {
            self.draw_number(*value, &format!("{path}.end[{axis}]"));
        }
        self.stops(&gradient.stops, path);
    }

    fn radial_gradient(&mut self, gradient: &RadialGradientPaint, path: &str) {
        for (axis, value) in gradient.center.iter().enumerate() {
            self.draw_number(*value, &format!("{path}.center[{axis}]"));
        }
        self.positive(gradient.radius, &format!("{path}.radius"), MAX_DRAW_VALUE);
        self.stops(&gradient.stops, path);
    }

    fn stops(&mut self, stops: &[GradientStop], path: &str) {
        if stops.is_empty() || stops.len() > DEEP_2D_DISPLAY_LIST_BUDGETS.gradient_stops_per_paint
        {
            self.add(
                Deep2dIssueCode::InvalidStructure,
                format!("{path}.stops"),
                format!(
                    "Gradients require 1..= {} stops.",
                    DEEP_2D_DISPLAY_LIST_BUDGETS.gradient_stops_per_paint
                ),
            );
            return;
        }
        for (index, stop) in stops.iter().enumerate() {
            if !stop.offset.is_finite() || !(0.0..=1.0).contains(&stop.offset) {
                self.add(
                    Deep2dIssueCode::InvalidNumber,
                    format!("{path}.stops[{index}].offset"),
                    "Gradient stop offsets must be finite and inside [0, 1].",
                );
            }
            self.color(&stop.color, &format!("{path}.stops[{index}].color"));
        }
    }

    pub(super) fn corner_radius(&mut self, value: f64, path: &str) {
        if !value.is_finite() || !(0.0..=MAX_DRAW_VALUE).contains(&value) {
            self.add(
                Deep2dIssueCode::InvalidNumber,
                path,
                "Corner radius must be a finite non-negative bounded number.",
            );
        }
    }

    pub(super) fn box_shadow(&mut self, shadow: &BoxShadow, path: &str) {
        self.draw_number(shadow.offset_x, &format!("{path}.offsetX"));
        self.draw_number(shadow.offset_y, &format!("{path}.offsetY"));
        if !shadow.blur_radius.is_finite() || !(0.0..=MAX_DRAW_VALUE).contains(&shadow.blur_radius)
        {
            self.add(
                Deep2dIssueCode::InvalidNumber,
                format!("{path}.blurRadius"),
                "Shadow blur radius must be a finite non-negative bounded number.",
            );
        }
        self.draw_number(shadow.spread, &format!("{path}.spread"));
        self.color(&shadow.color, &format!("{path}.color"));
        if let Some(radius) = shadow.corner_radius {
            self.corner_radius(radius, &format!("{path}.cornerRadius"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::validate_display_list;
    use super::*;
    use crate::deep2d::{Deep2dDisplayList, Deep2dIssueCode, PathCommand, PathResource};

    fn base_command(fill: Option<Deep2dPaint>) -> PathCommand {
        PathCommand {
            id: "paint".into(),
            z_order: 0,
            transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            opacity: None,
            clip_path_ids: None,
            clip_rect: None,
            hit_id: None,
            path_id: "rect".into(),
            fill,
            fill_rule: None,
            stroke: None,
            stroke_width: None,
            line_cap: None,
            line_join: None,
            miter_limit: None,
            dash: None,
            dash_offset: None,
            corner_radius: None,
            shadow: None,
        }
    }

    fn rect_resource() -> PathResource {
        PathResource {
            id: "rect".into(),
            revision: 1,
            verbs: vec![
                crate::deep2d::Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
                crate::deep2d::Deep2dPathVerb::Line { x: 10.0, y: 0.0 },
                crate::deep2d::Deep2dPathVerb::Line { x: 10.0, y: 10.0 },
                crate::deep2d::Deep2dPathVerb::Line { x: 0.0, y: 10.0 },
                crate::deep2d::Deep2dPathVerb::Close,
            ],
        }
    }

    fn list_with(mut command: PathCommand) -> Deep2dDisplayList {
        command.id = "paint".into();
        Deep2dDisplayList {
            schema_version: 1,
            id: "paint-validate".into(),
            revision: 1,
            logical_width: 10.0,
            logical_height: 10.0,
            scale_factor: 1.0,
            resources: vec![crate::deep2d::Deep2dResource::Path(rect_resource())],
            atlases: Vec::new(),
            commands: vec![crate::deep2d::Deep2dCommand::Path(command)],
        }
    }

    fn linear(stops: Vec<GradientStop>) -> Deep2dPaint {
        Deep2dPaint::LinearGradient(LinearGradientPaint {
            start: [0.0, 0.0],
            end: [10.0, 0.0],
            stops,
        })
    }

    fn stop(offset: f64, color: [f64; 4]) -> GradientStop {
        GradientStop { offset, color }
    }

    #[test]
    fn valid_gradients_pass() {
        let result = validate_display_list(&list_with(base_command(Some(linear(vec![
            stop(0.0, [0.0, 0.0, 0.0, 1.0]),
            stop(1.0, [1.0, 1.0, 1.0, 1.0]),
        ])))));
        assert!(result.valid, "{:?}", result.issues);
    }

    #[test]
    fn empty_and_oversized_stops_fail_closed() {
        let result = validate_display_list(&list_with(base_command(Some(linear(Vec::new())))));
        assert_eq!(result.issues[0].code, Deep2dIssueCode::InvalidStructure);
        let oversized: Vec<GradientStop> = (0..=super::super::DEEP_2D_DISPLAY_LIST_BUDGETS.gradient_stops_per_paint)
            .map(|index| stop(f64::from(index as u32), [0.0; 4]))
            .collect();
        let result = validate_display_list(&list_with(base_command(Some(linear(oversized)))));
        assert_eq!(result.issues[0].code, Deep2dIssueCode::InvalidStructure);
    }

    #[test]
    fn out_of_range_offsets_and_colors_fail_closed() {
        let result = validate_display_list(&list_with(base_command(Some(linear(vec![
            stop(0.0, [0.0, 0.0, 0.0, 1.0]),
            stop(1.5, [2.0, 0.0, 0.0, 1.0]),
        ])))));
        let codes: Vec<_> = result.issues.iter().map(|issue| issue.code).collect();
        assert!(codes.contains(&Deep2dIssueCode::InvalidNumber), "{codes:?}");
        assert!(codes.contains(&Deep2dIssueCode::InvalidColor), "{codes:?}");
    }

    #[test]
    fn negative_radial_radius_fails_closed() {
        let paint = Deep2dPaint::RadialGradient(RadialGradientPaint {
            center: [5.0, 5.0],
            radius: -1.0,
            stops: vec![stop(0.0, [0.0, 0.0, 0.0, 1.0])],
        });
        let result = validate_display_list(&list_with(base_command(Some(paint))));
        assert_eq!(result.issues[0].code, Deep2dIssueCode::InvalidNumber);
    }

    #[test]
    fn negative_blur_and_corner_radius_fail_closed() {
        let mut command = base_command(Some(Deep2dPaint::Solid([1.0, 0.0, 0.0, 1.0])));
        command.corner_radius = Some(-2.0);
        let result = validate_display_list(&list_with(command));
        assert_eq!(result.issues[0].code, Deep2dIssueCode::InvalidNumber);

        let mut command = base_command(Some(Deep2dPaint::Solid([1.0, 0.0, 0.0, 1.0])));
        command.corner_radius = Some(2.0);
        command.shadow = Some(BoxShadow {
            offset_x: 0.0,
            offset_y: 0.0,
            blur_radius: -1.0,
            spread: 0.0,
            color: [0.0, 0.0, 0.0, 0.5],
            corner_radius: None,
        });
        let result = validate_display_list(&list_with(command));
        assert_eq!(result.issues[0].code, Deep2dIssueCode::InvalidNumber);
    }

    #[test]
    fn shadow_requires_corner_radius() {
        let mut command = base_command(Some(Deep2dPaint::Solid([1.0, 0.0, 0.0, 1.0])));
        command.shadow = Some(BoxShadow {
            offset_x: 0.0,
            offset_y: 0.0,
            blur_radius: 2.0,
            spread: 0.0,
            color: [0.0, 0.0, 0.0, 0.5],
            corner_radius: None,
        });
        let result = validate_display_list(&list_with(command));
        assert_eq!(result.issues[0].code, Deep2dIssueCode::InvalidStructure);
    }
}
