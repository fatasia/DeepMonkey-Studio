use std::collections::HashMap;

use super::runtime_types::{Deep2dAtlas, Deep2dAtlasFormat, Deep2dAtlasKind};
use super::validate::{MAX_DRAW_VALUE, MAX_IMAGE_DIMENSION, ResourceKind, Validator};
use super::{DEEP_2D_DISPLAY_LIST_BUDGETS, Deep2dIssueCode, Deep2dPathVerb, Deep2dResource};

impl Validator {
    pub(super) fn resources<'a>(
        &mut self,
        candidates: &'a [Deep2dResource],
    ) -> HashMap<&'a str, ResourceKind> {
        let mut resources = HashMap::new();
        let mut total_path_verbs = 0usize;
        for (index, resource) in candidates.iter().enumerate() {
            let path = format!("resources[{index}]");
            let (id, revision, kind) = match resource {
                Deep2dResource::Path(value) => {
                    total_path_verbs = total_path_verbs.saturating_add(value.verbs.len());
                    self.path_verbs(&value.verbs, &format!("{path}.verbs"));
                    (&value.id, value.revision, ResourceKind::Path)
                }
                Deep2dResource::Font(value) => {
                    self.id(&value.asset_id, &format!("{path}.assetId"));
                    if value.family.trim().is_empty() || value.family.encode_utf16().count() > 256 {
                        self.add(
                            Deep2dIssueCode::InvalidStructure,
                            format!("{path}.family"),
                            "Font family must be bounded, non-blank well-formed Unicode.",
                        );
                    }
                    if !(100..=900).contains(&value.weight) || value.weight % 100 != 0 {
                        self.add(
                            Deep2dIssueCode::InvalidNumber,
                            format!("{path}.weight"),
                            "Font weight must be 100..900 in steps of 100.",
                        );
                    }
                    (&value.id, value.revision, ResourceKind::Font)
                }
                Deep2dResource::Image(value) => {
                    self.id(&value.asset_id, &format!("{path}.assetId"));
                    self.image_dimension(value.width, &format!("{path}.width"));
                    self.image_dimension(value.height, &format!("{path}.height"));
                    (&value.id, value.revision, ResourceKind::Image)
                }
            };
            let id_valid = self.id(id, &format!("{path}.id"));
            self.revision(revision, &format!("{path}.revision"));
            if id_valid {
                if resources.contains_key(id.as_str()) {
                    self.add(
                        Deep2dIssueCode::DuplicateId,
                        format!("{path}.id"),
                        format!("Duplicate resource id: {id}."),
                    );
                } else {
                    resources.insert(id.as_str(), kind);
                }
            }
        }
        if total_path_verbs > DEEP_2D_DISPLAY_LIST_BUDGETS.path_verbs_total {
            self.add(
                Deep2dIssueCode::BudgetExceeded,
                "resources",
                format!(
                    "Display list exceeds {} total path verbs.",
                    DEEP_2D_DISPLAY_LIST_BUDGETS.path_verbs_total
                ),
            );
        }
        resources
    }

    /// Registers display-list atlases into the shared id map and checks their
    /// kind/format pairing before a command can reference them.
    pub(super) fn atlas_resources<'a>(
        &mut self,
        atlases: &'a [Deep2dAtlas],
        map: &mut HashMap<&'a str, ResourceKind>,
    ) {
        if atlases.len() > DEEP_2D_DISPLAY_LIST_BUDGETS.resources {
            self.add(
                Deep2dIssueCode::BudgetExceeded,
                "atlases",
                format!(
                    "At most {} atlases are allowed per display list.",
                    DEEP_2D_DISPLAY_LIST_BUDGETS.resources
                ),
            );
        }
        for (index, atlas) in atlases.iter().enumerate() {
            let path = format!("atlases[{index}]");
            let id_valid = self.id(&atlas.id, &format!("{path}.id"));
            self.revision(atlas.revision, &format!("{path}.revision"));
            if !matches!(
                (atlas.kind, atlas.format),
                (Deep2dAtlasKind::Glyph, Deep2dAtlasFormat::R8Unorm)
                    | (Deep2dAtlasKind::Image, Deep2dAtlasFormat::Rgba8UnormSrgb)
            ) {
                self.add(
                    Deep2dIssueCode::InvalidStructure,
                    format!("{path}.format"),
                    "Glyph atlases require r8unorm; image atlases require rgba8unorm-srgb.",
                );
            }
            self.image_dimension(atlas.width, &format!("{path}.width"));
            self.image_dimension(atlas.height, &format!("{path}.height"));
            if atlas.data_base64.is_empty() {
                self.add(
                    Deep2dIssueCode::InvalidStructure,
                    format!("{path}.dataBase64"),
                    "Atlas requires pixel data.",
                );
            }
            if id_valid {
                if map.contains_key(atlas.id.as_str()) {
                    self.add(
                        Deep2dIssueCode::DuplicateId,
                        format!("{path}.id"),
                        format!("Duplicate resource id: {}.", atlas.id),
                    );
                } else {
                    map.insert(atlas.id.as_str(), ResourceKind::Atlas);
                }
            }
        }
    }

    fn image_dimension(&mut self, value: u32, path: &str) {
        if value == 0 || value > MAX_IMAGE_DIMENSION {
            self.add(
                Deep2dIssueCode::InvalidNumber,
                path,
                "Image dimension must be a positive bounded integer pixel count.",
            );
        }
    }

    fn path_verbs(&mut self, verbs: &[Deep2dPathVerb], path: &str) {
        if verbs.is_empty() {
            self.add(
                Deep2dIssueCode::InvalidPath,
                path,
                "Path requires a non-empty verb array.",
            );
            return;
        }
        if verbs.len() > DEEP_2D_DISPLAY_LIST_BUDGETS.path_verbs_per_resource {
            self.add(
                Deep2dIssueCode::BudgetExceeded,
                path,
                format!(
                    "Path exceeds {} verbs.",
                    DEEP_2D_DISPLAY_LIST_BUDGETS.path_verbs_per_resource
                ),
            );
            return;
        }
        let mut subpath_open = false;
        for (index, verb) in verbs.iter().enumerate() {
            let verb_path = format!("{path}[{index}]");
            let coordinates: &[f64] = match verb {
                Deep2dPathVerb::Move { x, y } | Deep2dPathVerb::Line { x, y } => &[*x, *y],
                Deep2dPathVerb::Quadratic { cx, cy, x, y } => &[*cx, *cy, *x, *y],
                Deep2dPathVerb::Cubic {
                    c1x,
                    c1y,
                    c2x,
                    c2y,
                    x,
                    y,
                } => &[*c1x, *c1y, *c2x, *c2y, *x, *y],
                Deep2dPathVerb::Close => &[],
            };
            if coordinates
                .iter()
                .any(|value| !value.is_finite() || value.abs() > MAX_DRAW_VALUE)
            {
                self.add(
                    Deep2dIssueCode::InvalidPath,
                    &verb_path,
                    "Path coordinates must be present, finite and bounded.",
                );
            }
            if matches!(verb, Deep2dPathVerb::Move { .. }) {
                subpath_open = true;
            } else if !subpath_open {
                self.add(
                    Deep2dIssueCode::InvalidPath,
                    &verb_path,
                    "Each subpath must start with move.",
                );
            }
            if matches!(verb, Deep2dPathVerb::Close) {
                subpath_open = false;
            }
        }
    }
}
