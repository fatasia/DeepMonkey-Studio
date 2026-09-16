use std::collections::HashMap;

use super::{
    DEEP_2D_DISPLAY_LIST_BUDGETS, Deep2dAtlas, Deep2dAtlasKind, Deep2dIssueCode, TextCommand,
    validate::{MAX_DRAW_VALUE, ResourceKind, Validator},
};

impl Validator {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn text_atlas(
        &mut self,
        command: &TextCommand,
        path: &str,
        resources: &HashMap<&str, ResourceKind>,
        atlases: &[Deep2dAtlas],
        code_units: usize,
        total_baked_glyphs: &mut usize,
    ) {
        let (Some(atlas_id), Some(glyphs)) = (&command.atlas_id, &command.baked_glyphs) else {
            if command.atlas_id.is_some() || command.baked_glyphs.is_some() {
                self.add(
                    Deep2dIssueCode::InvalidStructure,
                    path,
                    "Baked text requires both atlasId and bakedGlyphs.",
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
        if glyphs.len() > DEEP_2D_DISPLAY_LIST_BUDGETS.commands {
            self.add(
                Deep2dIssueCode::BudgetExceeded,
                format!("{path}.bakedGlyphs"),
                "Text command exceeds the baked glyph budget.",
            );
            return;
        }
        *total_baked_glyphs = total_baked_glyphs.saturating_add(glyphs.len());
        if !command.text.is_empty() && glyphs.is_empty() {
            self.add(
                Deep2dIssueCode::InvalidStructure,
                format!("{path}.bakedGlyphs"),
                "Non-empty text requires at least one baked glyph.",
            );
        }
        let atlas = atlases.iter().find(|atlas| &atlas.id == atlas_id);
        if let Some(atlas) = atlas
            && atlas.kind != Deep2dAtlasKind::Glyph
        {
            self.add(
                Deep2dIssueCode::ResourceKindMismatch,
                format!("{path}.atlasId"),
                "Text command requires a glyph atlas.",
            );
        }
        let mut previous_cluster = 0;
        for (index, glyph) in glyphs.iter().enumerate() {
            let glyph_path = format!("{path}.bakedGlyphs[{index}]");
            if usize::try_from(glyph.cluster).map_or(true, |value| value >= code_units)
                || (index > 0 && glyph.cluster < previous_cluster)
            {
                self.add(
                    Deep2dIssueCode::InvalidStructure,
                    format!("{glyph_path}.cluster"),
                    "Glyph clusters must be ordered UTF-16 offsets within the text.",
                );
            }
            previous_cluster = glyph.cluster;
            self.glyph_rect(glyph.source, glyph.destination, atlas, &glyph_path);
        }
    }

    fn glyph_rect(
        &mut self,
        source: [u32; 4],
        destination: [f64; 4],
        atlas: Option<&Deep2dAtlas>,
        path: &str,
    ) {
        let [sx, sy, sw, sh] = source;
        if sw == 0
            || sh == 0
            || atlas.is_some_and(|atlas| {
                u64::from(sx) + u64::from(sw) > u64::from(atlas.width)
                    || u64::from(sy) + u64::from(sh) > u64::from(atlas.height)
            })
        {
            self.add(
                Deep2dIssueCode::InvalidNumber,
                format!("{path}.source"),
                "Glyph source must have positive area inside its atlas.",
            );
        }
        self.draw_number(destination[0], &format!("{path}.destination[0]"));
        self.draw_number(destination[1], &format!("{path}.destination[1]"));
        self.positive(
            destination[2],
            &format!("{path}.destination[2]"),
            MAX_DRAW_VALUE,
        );
        self.positive(
            destination[3],
            &format!("{path}.destination[3]"),
            MAX_DRAW_VALUE,
        );
    }
}
