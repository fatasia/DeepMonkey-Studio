//! Converts actual text pixels into the existing image/atlas display contract.
use super::RasterizedText;
use crate::deep2d::*;

impl RasterizedText {
    pub fn into_display_list(
        self,
        id: &str,
        revision: u64,
        canvas: [f64; 2],
        origin: [f64; 2],
        z_order: i32,
    ) -> Result<Deep2dDisplayList, String> {
        if id.is_empty()
            || id.len() > 256
            || self.width == 0
            || self.height == 0
            || self.width > 2048
            || self.height > 2048
            || self.rgba.len() != self.width as usize * self.height as usize * 4
        {
            return Err("invalid text image identity, dimensions or RGBA length".into());
        }
        let key =
            crate::runtime_package::runtime_content_sha256(&serde_json::json!(["text-image", id]));
        let image_id = format!("image-{key}");
        let atlas_id = format!("atlas-{key}");
        let display_list = Deep2dDisplayList {
            schema_version: DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION,
            id: format!("text-{key}"),
            revision,
            logical_width: canvas[0],
            logical_height: canvas[1],
            scale_factor: 1.0,
            resources: vec![Deep2dResource::Image(ImageResource {
                id: image_id.clone(),
                revision,
                asset_id: format!("generated-{key}"),
                width: self.width,
                height: self.height,
                color_space: ImageColorSpace::Srgb,
            })],
            atlases: vec![Deep2dAtlas {
                id: atlas_id.clone(),
                revision,
                kind: Deep2dAtlasKind::Image,
                format: Deep2dAtlasFormat::Rgba8UnormSrgb,
                width: self.width,
                height: self.height,
                sampling: ImageSampling::Linear,
                data_base64: encode_base64(&self.rgba),
            }],
            commands: vec![Deep2dCommand::Image(ImageCommand {
                id: format!("draw-{key}"),
                z_order,
                transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                opacity: None,
                clip_path_ids: None,
                clip_rect: None,
                hit_id: None,
                image_id,
                x: origin[0],
                y: origin[1],
                width: f64::from(self.width),
                height: f64::from(self.height),
                atlas_id: Some(atlas_id),
                source: Some([0, 0, self.width, self.height]),
                sampling: Some(ImageSampling::Linear),
            })],
        };
        let validation = validate_display_list(&display_list);
        if !validation.valid {
            return Err(format!("text image display list: {:?}", validation.issues));
        }
        Ok(display_list)
    }
}
