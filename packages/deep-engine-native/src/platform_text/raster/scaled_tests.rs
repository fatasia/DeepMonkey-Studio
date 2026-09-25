use super::*;
use crate::deep2d::Deep2dCommand;

fn request(text: &str) -> TextRasterRequest<'_> {
    TextRasterRequest {
        text,
        family: "",
        font_size: 14.0,
        line_height: 21.0,
        width: 117,
        height: 83,
        color: [220, 230, 240, 255],
    }
}

#[test]
fn physical_raster_preserves_logical_bidi_wrapping_and_one_x_pixels() {
    let mut text = TextRasterizer::new();
    let content = "Hello English\nlong mixed line 12345";
    let reference = text.rasterize(request(content)).unwrap();
    let one = text.rasterize_scaled(request(content), 1.0).unwrap();
    assert_eq!(reference.rgba, one.rgba);
    for scale in [0.75, 1.25, 1.5, 2.0, 3.0] {
        let pixels = text.rasterize_scaled(request(content), scale).unwrap();
        assert_eq!(pixels.glyph_count, reference.glyph_count);
        assert_eq!(pixels.line_count, reference.line_count);
        assert_eq!(pixels.width, (117.0 * scale).ceil() as u32);
        assert_eq!(pixels.height, (83.0 * scale).ceil() as u32);
        assert!(pixels.rgba.chunks_exact(4).any(|p| p[3] != 0));
        // Native cache keys include physical size: revisiting 1x cannot hit
        // a scaled glyph's bitmap even when the family/text are unchanged.
        assert_eq!(
            text.rasterize(request(content)).unwrap().rgba,
            reference.rgba
        );
    }
}

#[test]
fn scaled_images_keep_logical_rect_and_linear_alpha_contract() {
    let mut rasterizer = TextRasterizer::new();
    for scale in [1.0, 1.25, 1.5, 2.0] {
        let list = rasterizer
            .with_display_scale(scale, |text| {
                text.rasterize_for_display(request("Hello English"))?
                    .into_display_list("density-test", 7, [320.0, 200.0], [13.0, 19.0], 8)
            })
            .unwrap();
        let Deep2dCommand::Image(image) = &list.commands[0] else {
            panic!("text image")
        };
        assert_eq!([image.x, image.y], [13.0, 19.0]);
        assert_eq!(image.width * scale, f64::from(list.atlases[0].width));
        assert_eq!(image.height * scale, f64::from(list.atlases[0].height));
        assert_eq!(image.transform, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        if let Some(clip) = &image.clip_rect {
            assert_eq!(
                [clip.x, clip.y, clip.width, clip.height],
                [13.0, 19.0, 117.0, 83.0]
            );
        } else {
            assert_eq!([image.width, image.height], [117.0, 83.0]);
        }
        assert_eq!(list.atlases[0].width, (117.0 * scale).ceil() as u32);
        assert_eq!(list.atlases[0].height, (83.0 * scale).ceil() as u32);
        assert_eq!(rasterizer.display_scale, 1.0);
    }
}

#[test]
fn bad_density_and_over_budget_raster_leave_scale_and_prior_pixels_intact() {
    let mut text = TextRasterizer::new();
    let before = text.rasterize(request("safe")).unwrap();
    for scale in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::MAX] {
        assert!(text.with_display_scale(scale, |_| Ok(())).is_err());
        assert_eq!(text.display_scale, 1.0);
    }
    let failed = text.with_display_scale(100.0, |text| text.rasterize_for_display(request("safe")));
    assert!(failed.is_err());
    assert_eq!(text.display_scale, 1.0);
    let mut zero = request("safe");
    zero.width = 0;
    assert!(text.rasterize_for_display(zero).is_err());
    assert_eq!(text.rasterize(request("safe")).unwrap().rgba, before.rgba);
}
