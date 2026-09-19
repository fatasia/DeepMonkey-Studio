//! Layout stays in logical units; only glyph rasterization uses device pixels.
use super::{RasterizedText, TextRasterRequest, TextRasterizer};
use crate::deep2d::{Deep2dCommand, Deep2dDisplayList, Deep2dRect, validate_display_list};

pub struct DisplayText {
    pixels: RasterizedText,
    logical_size: [f64; 2],
    scale: f64,
}

impl TextRasterizer {
    pub fn with_display_scale<T>(
        &mut self,
        scale: f64,
        action: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<T, String> {
        let scale = scale as f32;
        if !scale.is_finite() || scale <= 0.0 {
            return Err("text display scale must be finite and positive".into());
        }
        let previous = self.display_scale;
        self.display_scale = scale;
        let result = action(self);
        self.display_scale = previous;
        result
    }

    pub fn rasterize_for_display(
        &mut self,
        request: TextRasterRequest<'_>,
    ) -> Result<DisplayText, String> {
        let logical_size = [f64::from(request.width), f64::from(request.height)];
        let pixels = self.rasterize_scaled(request, self.display_scale)?;
        Ok(DisplayText {
            pixels,
            logical_size,
            scale: f64::from(self.display_scale),
        })
    }
}

impl DisplayText {
    pub fn into_display_list(
        self,
        id: &str,
        revision: u64,
        canvas: [f64; 2],
        origin: [f64; 2],
        z_order: i32,
    ) -> Result<Deep2dDisplayList, String> {
        let mut list = self
            .pixels
            .into_display_list(id, revision, canvas, origin, z_order)?;
        for command in &mut list.commands {
            if let Deep2dCommand::Image(image) = command {
                // ceil() adds only transparent allocation padding. Do not
                // squeeze it back into the logical box and resample every
                // glyph; crop the padding while keeping physical pixels 1:1.
                image.width /= self.scale;
                image.height /= self.scale;
                if image.width != self.logical_size[0] || image.height != self.logical_size[1] {
                    image.clip_rect = Some(Deep2dRect {
                        x: origin[0],
                        y: origin[1],
                        width: self.logical_size[0],
                        height: self.logical_size[1],
                    });
                }
            }
        }
        let validation = validate_display_list(&list);
        if !validation.valid {
            return Err(format!("scaled text display list: {:?}", validation.issues));
        }
        Ok(list)
    }
}
