#[path = "../src/output_pass.rs"]
#[allow(dead_code)]
mod output_pass;

#[test]
fn every_native_output_variant_consumes_shared_display_math_once() {
    let display = include_str!("../../deep-engine/wgsl/displayColor.wgsl");
    let author = include_str!("../assets/shaders/native_output_color.wgsl");
    for bloom in [false, true] {
        for fog in [false, true] {
            let source = output_pass::output_shader(bloom, fog);
            assert!(source.starts_with(display));
            assert!(source.contains(author));
            for function in ["deepAcesFit", "deepLinearToSrgb", "author_grading_apply"] {
                assert_eq!(source.matches(&format!("fn {function}(")).count(), 1);
            }
            assert_eq!(source.matches("struct AuthorGrading").count(), 1);
            assert_eq!(
                source
                    .matches("@binding(6) var<uniform> author_grading")
                    .count(),
                1
            );
            assert!(source.contains("return deepAcesFit(color, 1.0)"));
            assert!(source.contains("return deepLinearToSrgb(linear)"));
            assert_eq!(source.contains("forward_depth:"), fog);
            assert_eq!(source.contains("bloom_color:"), bloom);
            assert!(
                source.contains("vec4f(aces(author_grading_apply(hdr.rgb, vignette_uv)), hdr.a)")
            );
            assert!(
                source.contains("linear_to_srgb(aces(author_grading_apply(hdr.rgb, vignette_uv)))")
            );
        }
    }
}

#[test]
fn author_grading_keeps_zero_neutral_and_original_hue_brightness_contract() {
    let author = include_str!("../assets/shaders/native_output_color.wgsl");
    assert!(author.contains("grading.w + 1.0"));
    assert!(author.contains("grading.x / 180.0 * 3.14159265"));
    assert!(author.contains("color += grading.z"));
    assert!(author.contains("abs(dot(color"));
    assert!(!author.contains("deepApplyColorGrading"));
    assert!(!author.contains("DeepOutputSettings("));
}
