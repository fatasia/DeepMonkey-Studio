use deep_engine_native::deep2d::{Deep2dRuntimeContent, prepare_runtime_content};
use deep_engine_native::platform_text::RasterizedText;

fn pixels() -> RasterizedText {
    RasterizedText {
        width: 2,
        height: 1,
        rgba: vec![0, 128, 255, 255, 255, 0, 128, 64],
        glyph_count: 2,
        line_count: 1,
    }
}
#[test]
fn text_pixels_become_valid_image_atlas_with_stable_identity_and_revision() {
    let first = pixels()
        .into_display_list("提示", 7, [320.0, 80.0], [12.0, 8.0], 40)
        .unwrap();
    let next = pixels()
        .into_display_list("提示", 8, [320.0, 80.0], [14.0, 8.0], 40)
        .unwrap();
    assert_eq!(first.id, next.id);
    assert_eq!(first.atlases[0].id, next.atlases[0].id);
    assert_eq!(first.atlases[0].revision, 7);
    assert_eq!(next.atlases[0].revision, 8);
    let prepared = prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(first)).unwrap();
    assert!(!prepared.atlases.is_empty());
}
#[test]
fn invalid_pixels_and_placement_fail_before_publication() {
    let mut invalid = pixels();
    invalid.rgba.pop();
    assert!(
        invalid
            .into_display_list("x", 1, [320.0, 80.0], [0.0, 0.0], 0)
            .is_err()
    );
    assert!(
        pixels()
            .into_display_list("x", 1, [320.0, 80.0], [f64::NAN, 0.0], 0)
            .is_err()
    );
    assert!(
        pixels()
            .into_display_list("x", 1, [0.0, 80.0], [0.0, 0.0], 0)
            .is_err()
    );
    assert!(
        pixels()
            .into_display_list("", 1, [320.0, 80.0], [0.0, 0.0], 0)
            .is_err()
    );
}
