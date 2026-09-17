use crate::{
    player_content::PlayerContent,
    shader_material_assertions::color_changes,
    shader_material_renderer::{Snapshot, render},
};
use deep_engine_native::{
    contract::{RenderPacket, validate_packet},
    half_decode::half_to_f32,
};
use serde_json::{Value, json};
use std::path::Path;

pub async fn verify_production_transparency_pixels(device: &wgpu::Device, queue: &wgpu::Queue) {
    let clear = draw(device, queue, [0.0; 3], 0.0, true, false, false).await;
    let straight = draw(device, queue, [0.8, 0.4, 0.2], 0.5, false, false, false).await;
    let premultiplied = draw(device, queue, [0.4, 0.2, 0.1], 0.5, true, false, false).await;
    verify_blending(&clear, &straight, &premultiplied);

    let zero = draw(device, queue, [1.0, 0.5, 0.25], 0.0, false, false, false).await;
    assert_eq!(
        zero.hdr, clear.hdr,
        "straight zero alpha changed the framebuffer"
    );

    let front = draw(device, queue, [0.5, 0.7, 0.9], 0.75, false, false, false).await;
    let back = draw(device, queue, [0.5, 0.7, 0.9], 0.75, false, false, true).await;
    let double_front = draw(device, queue, [0.5, 0.7, 0.9], 0.75, false, true, false).await;
    let double_back = draw(device, queue, [0.5, 0.7, 0.9], 0.75, false, true, true).await;
    let single_changes = verify_sidedness(&clear, &front, &back, &double_front, &double_back);

    if let Ok(path) = std::env::var("DEEP_C03_EVIDENCE_PPM") {
        write_ppm(Path::new(&path), &straight.hdr);
    }
    println!(
        "C03 GPU pixels OK: equivalent_blend_pixels={} front_cull={single_changes:?}",
        color_changes(&straight, &clear)
    );
}

async fn draw(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    color: [f32; 3],
    alpha: f32,
    premultiplied: bool,
    double_sided: bool,
    reversed: bool,
) -> Snapshot {
    render(
        device,
        queue,
        &alpha_content(color, alpha, premultiplied, double_sided, reversed),
        false,
    )
    .await
}

fn verify_blending(clear: &Snapshot, straight: &Snapshot, premultiplied: &Snapshot) {
    assert_eq!(
        straight.hdr, premultiplied.hdr,
        "straight and premultiplied equivalents diverged on the production GPU pipeline"
    );
    let covered = color_changes(straight, clear);
    assert!(
        covered > 1_000,
        "transparency probe covered only {covered} pixels"
    );
}

fn verify_sidedness(
    clear: &Snapshot,
    front: &Snapshot,
    back: &Snapshot,
    double_front: &Snapshot,
    double_back: &Snapshot,
) -> [usize; 2] {
    let single = [color_changes(front, clear), color_changes(back, clear)];
    assert!(
        single.contains(&0) && single.iter().any(|count| *count > 1_000),
        "front culling must show exactly one winding: {single:?}"
    );
    assert!(
        color_changes(double_front, clear) > 1_000 && color_changes(double_back, clear) > 1_000,
        "double-sided pipeline must render both windings"
    );
    assert_eq!(
        double_front.hdr, double_back.hdr,
        "double-sided winding changed unlit pixels"
    );
    single
}

fn alpha_content(
    color: [f32; 3],
    alpha: f32,
    premultiplied: bool,
    double_sided: bool,
    reversed: bool,
) -> PlayerContent {
    let mut value: Value =
        serde_json::from_str(include_str!("../../fixtures/render_packet_alpha_v1.json")).unwrap();
    let mut material = json!({
        "id": "probe", "shadingModel": "unlit", "baseColor": color,
        "metallic": 0.0, "roughness": 1.0, "baseColorAlpha": alpha,
        "alphaMode": "BLEND", "doubleSided": double_sided
    });
    if premultiplied {
        material["premultipliedAlpha"] = true.into();
    }
    value["materials"] = json!([material]);
    value["textures"] = json!([]);
    value["instances"] = json!([{
        "id": "probe", "geometry": "textured-quad", "material": "probe",
        "transform": [1.0,0.0,0.0,0.0, 0.0,1.0,0.0,0.0, 0.0,0.0,1.0,0.0, 0.0,0.0,0.0,1.0]
    }]);
    if reversed {
        value["geometries"][0]["indices"] = json!([0, 2, 1, 0, 3, 2]);
    }
    let packet: RenderPacket = serde_json::from_value(value).unwrap();
    validate_packet(&packet).unwrap();
    PlayerContent::from_packet(packet, None)
}

fn write_ppm(path: &Path, hdr: &[u8]) {
    assert_eq!(hdr.len(), 256 * 256 * 8);
    std::fs::create_dir_all(path.parent().expect("evidence path has parent")).unwrap();
    let mut bytes = b"P6\n256 256\n255\n".to_vec();
    for pixel in hdr.chunks_exact(8) {
        for channel in 0..3 {
            let value = half_to_f32(u16::from_le_bytes([
                pixel[channel * 2],
                pixel[channel * 2 + 1],
            ]));
            bytes.push((value.clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0).round() as u8);
        }
    }
    std::fs::write(path, bytes).unwrap();
}
