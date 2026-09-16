use super::{HEIGHT, WIDTH, draw_to_pixels, gpu_context};
use deep_engine_native::deep2d::Deep2dRuntimeContent;
use deep_engine_native::platform_text::{TextRasterRequest, TextRasterizer};

#[test]
#[ignore = "requires real GPU; run explicitly with --ignored"]
fn enlarged_single_texel_crop_does_not_sample_adjacent_cells() {
    pollster::block_on(async {
        let (device, queue, _) = gpu_context().await;
        let raster = deep_engine_native::platform_text::RasterizedText {
            width: 3,
            height: 1,
            rgba: vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255],
            glyph_count: 0,
            line_count: 0,
        };
        let mut list = raster
            .into_display_list("crop", 1, [WIDTH.into(), HEIGHT.into()], [0.0, 0.0], 0)
            .unwrap();
        let deep_engine_native::deep2d::Deep2dCommand::Image(command) = &mut list.commands[0]
        else {
            panic!("image")
        };
        command.source = Some([1, 0, 1, 1]);
        command.width = WIDTH.into();
        command.height = HEIGHT.into();
        let pixels =
            draw_to_pixels(&device, &queue, &Deep2dRuntimeContent::DisplayList(list)).unwrap();
        assert!(pixels.iter().all(|pixel| *pixel == [0, 255, 0, 255]));
    });
}

#[test]
#[ignore = "requires real GPU and installed fonts; run explicitly with --ignored"]
fn actual_chinese_text_pixels_survive_deep2d_upload() {
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let mut rasterizer = TextRasterizer::new();
        let raster = rasterizer
            .rasterize(TextRasterRequest {
                text: "泵站 25.6°C",
                family: "Microsoft YaHei",
                font_size: 16.0,
                line_height: 24.0,
                width: WIDTH,
                height: HEIGHT,
                color: [80, 160, 240, 255],
            })
            .unwrap();
        assert!(raster.glyph_count > 0);
        let expected_alpha = raster
            .rgba
            .chunks_exact(4)
            .map(|pixel| pixel[3])
            .collect::<Vec<_>>();
        let list = raster
            .into_display_list(
                "text-upload",
                1,
                [WIDTH.into(), HEIGHT.into()],
                [0.0, 0.0],
                0,
            )
            .unwrap();
        let pixels =
            draw_to_pixels(&device, &queue, &Deep2dRuntimeContent::DisplayList(list)).unwrap();
        assert!(pixels.iter().filter(|pixel| pixel[3] > 0).count() > 100);
        for (index, (pixel, expected)) in pixels.iter().zip(expected_alpha).enumerate() {
            assert!(
                pixel[3].abs_diff(expected) <= 1,
                "alpha differs at pixel {index}: {} vs {expected}",
                pixel[3]
            );
        }
    });
}
