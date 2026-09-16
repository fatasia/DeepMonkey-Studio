use super::{TextRasterizer, styled_types::*};
use cosmic_text::{FontSystem, SwashCache, fontdb};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub struct FrozenTextRasterizer {
    pub(super) inner: TextRasterizer,
    pub(super) identities: BTreeMap<fontdb::ID, UsedFontFace>,
}
impl TextRasterizer {
    /// An isolated font database: no system discovery, paths, downloads, or license inference.
    pub fn from_frozen_fonts(
        locale: &str,
        fonts: Vec<FrozenFontInput>,
    ) -> Result<FrozenTextRasterizer, String> {
        if locale.is_empty()
            || locale.len() > 64
            || locale.chars().any(char::is_control)
            || fonts.is_empty()
            || fonts.len() > 32
        {
            return Err("frozen font locale or face count exceeds limits".into());
        }
        let mut bytes = 0usize;
        let mut seen = BTreeSet::new();
        let mut db = fontdb::Database::new();
        let mut identities = BTreeMap::new();
        for font in fonts {
            bytes = bytes
                .checked_add(font.bytes.len())
                .ok_or("font bytes overflow")?;
            if font.bytes.is_empty()
                || bytes > 64 * 1024 * 1024
                || font.sha256.len() != 64
                || !font
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || crate::shader_package::hash::sha256(&font.bytes) != font.sha256
            {
                return Err("frozen font bytes or SHA-256 mismatch".into());
            }
            if !seen.insert((font.sha256.clone(), font.face_index)) {
                return Err("duplicate frozen font face".into());
            }
            let ids = db.load_font_source(fontdb::Source::Binary(Arc::new(font.bytes)));
            let mut chosen = None;
            for id in ids {
                if db
                    .face(id)
                    .is_some_and(|info| info.index == font.face_index)
                {
                    chosen = Some(id);
                } else {
                    db.remove_face(id);
                }
            }
            let id = chosen.ok_or("frozen font face index is absent or font data invalid")?;
            let info = db.face(id).ok_or("loaded font face missing")?;
            let family = info
                .families
                .first()
                .map(|(name, _)| name.clone())
                .ok_or("frozen font has no family")?;
            identities.insert(
                id,
                UsedFontFace {
                    sha256: font.sha256,
                    face_index: font.face_index,
                    family,
                    post_script_name: info.post_script_name.clone(),
                    weight: info.weight.0,
                    style: style(info.style),
                },
            );
        }
        let mut system = FontSystem::new_with_locale_and_db(locale.into(), db);
        let mut selectors = BTreeSet::new();
        for (id, face) in &identities {
            if !selectors.insert((
                face.family.clone(),
                face.weight,
                format!("{:?}", face.style),
            )) {
                return Err("ambiguous frozen family/weight/style selector".into());
            }
            let font = system
                .get_font(*id, cosmic_text::Weight(face.weight))
                .ok_or("frozen font cannot be shaped")?;
            if font.as_swash().variations().next().is_some() {
                return Err("variable font axes are not supported by the frozen producer".into());
            }
        }
        Ok(FrozenTextRasterizer {
            inner: TextRasterizer {
                fonts: system,
                cache: SwashCache::new(),
            },
            identities,
        })
    }
}
pub(super) fn style(value: cosmic_text::Style) -> TextFontStyle {
    match value {
        cosmic_text::Style::Normal => TextFontStyle::Normal,
        cosmic_text::Style::Italic => TextFontStyle::Italic,
        cosmic_text::Style::Oblique => TextFontStyle::Oblique,
    }
}
impl FrozenTextRasterizer {
    pub(super) fn primary(&self, request: &StyledTextRequest) -> Result<&UsedFontFace, String> {
        let (id, face) = self
            .identities
            .iter()
            .find(|(_, face)| {
                face.sha256 == request.font.sha256 && face.face_index == request.font.face_index
            })
            .ok_or("requested frozen font face is absent")?;
        if face.weight != request.weight || face.style != request.style {
            return Err("requested weight/style differs from frozen font face".into());
        }
        let font_style = match request.style {
            TextFontStyle::Normal => cosmic_text::Style::Normal,
            TextFontStyle::Italic => cosmic_text::Style::Italic,
            TextFontStyle::Oblique => cosmic_text::Style::Oblique,
        };
        let selected = self.inner.fonts.db().query(&fontdb::Query {
            families: &[fontdb::Family::Name(&face.family)],
            weight: cosmic_text::Weight(request.weight),
            style: font_style,
            stretch: cosmic_text::Attrs::new().stretch,
        });
        // A primary selector must resolve to the requested bytes/face, not another
        // face's family alias. Subsequent missing-glyph fallback remains allowed.
        if selected != Some(*id) {
            return Err("primary family selector resolves to another frozen font face".into());
        }
        Ok(face)
    }
}
