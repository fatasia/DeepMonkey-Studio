use deep_engine_native::deep2d::{
    BakedGlyphPlacement, Deep2dAtlas, Deep2dAtlasFormat, Deep2dAtlasKind, Deep2dCommand,
    Deep2dDisplayList, Deep2dPathVerb, Deep2dRect, Deep2dResource, Deep2dRuntimeContent,
    FontResource, FontStyle, ImageColorSpace, ImageCommand, ImageResource, ImageSampling,
    PathCommand, PathResource, TextCommand,
};

/// Mixed-content carrier: white nonuniform-scaled scissor-clipped path (z0),
/// red|blue image-atlas quad (z1), green glyph-atlas quad (z2).
pub(crate) const ORIGINAL_TILES: &str = "/wAA/wAA//8="; // pixel0 red, pixel1 blue
pub(crate) const SWAPPED_TILES: &str = "AAD///8AAP8="; // pixel0 blue, pixel1 red

pub(crate) fn rect_verbs(x: f64, y: f64, w: f64, h: f64) -> Vec<Deep2dPathVerb> {
    vec![
        Deep2dPathVerb::Move { x, y },
        Deep2dPathVerb::Line { x: x + w, y },
        Deep2dPathVerb::Line { x: x + w, y: y + h },
        Deep2dPathVerb::Line { x, y: y + h },
        Deep2dPathVerb::Close,
    ]
}

fn tiles_atlas(data: &str, revision: u64) -> Deep2dAtlas {
    Deep2dAtlas {
        id: "tiles".into(),
        revision,
        kind: Deep2dAtlasKind::Image,
        format: Deep2dAtlasFormat::Rgba8UnormSrgb,
        width: 2,
        height: 1,
        sampling: ImageSampling::Nearest,
        data_base64: data.into(),
    }
}

fn glyph_atlas() -> Deep2dAtlas {
    Deep2dAtlas {
        id: "glyphs".into(),
        revision: 1,
        kind: Deep2dAtlasKind::Glyph,
        format: Deep2dAtlasFormat::R8Unorm,
        width: 1,
        height: 1,
        sampling: ImageSampling::Nearest,
        data_base64: "/w==".into(),
    }
}

pub(crate) fn base_list() -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "p1-11-matrix".into(),
        revision: 1,
        logical_width: 10.0,
        logical_height: 10.0,
        scale_factor: 1.0,
        resources: vec![
            Deep2dResource::Path(PathResource {
                id: "frame".into(),
                revision: 1,
                verbs: rect_verbs(0.0, 0.0, 5.0, 8.0),
            }),
            Deep2dResource::Font(FontResource {
                id: "font:probe".into(),
                revision: 1,
                asset_id: "embedded:probe".into(),
                family: "Probe".into(),
                weight: 400,
                style: FontStyle::Normal,
            }),
            Deep2dResource::Image(ImageResource {
                id: "img".into(),
                revision: 1,
                asset_id: "asset:img".into(),
                width: 2,
                height: 1,
                color_space: ImageColorSpace::Srgb,
            }),
        ],
        commands: vec![
            Deep2dCommand::Path(PathCommand {
                id: "draw:frame".into(),
                z_order: 0,
                transform: [2.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                opacity: None,
                clip_path_ids: None,
                clip_rect: Some(Deep2dRect {
                    x: 0.0,
                    y: 0.0,
                    width: 8.0,
                    height: 10.0,
                }),
                hit_id: None,
                path_id: "frame".into(),
                fill: Some([1.0, 1.0, 1.0, 1.0]),
                fill_rule: None,
                stroke: None,
                stroke_width: None,
                line_cap: None,
                line_join: None,
                miter_limit: None,
                dash: None,
                dash_offset: None,
            }),
            Deep2dCommand::Image(ImageCommand {
                id: "draw:tile".into(),
                z_order: 1,
                transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                opacity: None,
                clip_path_ids: None,
                clip_rect: None,
                hit_id: None,
                image_id: "img".into(),
                x: 2.0,
                y: 0.0,
                width: 2.0,
                height: 8.0,
                atlas_id: Some("tiles".into()),
                source: Some([0, 0, 2, 1]),
                sampling: None,
            }),
            Deep2dCommand::Text(TextCommand {
                id: "draw:glyph".into(),
                z_order: 2,
                transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                opacity: None,
                clip_path_ids: None,
                clip_rect: None,
                hit_id: None,
                text: "A".into(),
                x: 8.0,
                y: 0.0,
                font_id: "font:probe".into(),
                font_size: 1.0,
                color: [0.0, 1.0, 0.0, 1.0],
                max_width: None,
                align: None,
                baseline: None,
                direction: None,
                atlas_id: Some("glyphs".into()),
                baked_glyphs: Some(vec![BakedGlyphPlacement {
                    cluster: 0,
                    source: [0, 0, 1, 1],
                    destination: [0.0, 0.0, 1.0, 8.0],
                }]),
            }),
        ],
        atlases: vec![glyph_atlas(), tiles_atlas(ORIGINAL_TILES, 1)],
    }
}

pub(crate) fn content(list: &Deep2dDisplayList) -> Deep2dRuntimeContent {
    Deep2dRuntimeContent::DisplayList(list.clone())
}
