use super::{SIZE, furnace_frame, render_material_frame, wall_packet};
use deep_engine_native::contract::{RenderPacket, validate_packet};
#[path = "../shader_package/hash.rs"]
mod evidence_hash;
type Vector = [f64; 3];
fn dot(a: Vector, b: Vector) -> f64 { a.iter().zip(b).map(|(x, y)| x * y).sum() }
fn unit(a: Vector) -> Vector { let length = dot(a, a).sqrt(); a.map(|x| x / length) }
fn cross(a: Vector, b: Vector) -> Vector { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn packet(strength: f32, coverage: f32) -> RenderPacket {
    let mut packet = wall_packet();
    packet.materials[0].double_sided = Some(true);
    packet.materials[0].layered = Some(serde_json::from_value(serde_json::json!({"layers":[{
      "responseModel":"microfacet-metal-reflection", "coverage":coverage,
      "params":{"anisotropy":{"strength":strength,"rotation":0.4}},
      "surface":{"baseColor":[0.8,0.4,0.1],"metallic":1,"roughness":0.6}
    }]})).unwrap());
    validate_packet(&packet).unwrap(); packet
}
fn transformed(mut packet: RenderPacket, m: [f32; 4]) -> RenderPacket {
    let [a, b, c, d] = m; let det = a * d - b * c;
    for vertex in packet.geometries[0].vertices.chunks_exact_mut(6) {
        let x = vertex[0]; let y = vertex[1];
        vertex[0] = (d * x - c * y) / det; vertex[1] = (-b * x + a * y) / det;
        let nx = vertex[3]; let ny = vertex[4];
        let normal = unit([f64::from(a * nx + b * ny), f64::from(c * nx + d * ny), f64::from(vertex[5])]);
        for i in 0..3 { vertex[3 + i] = (normal[i] * f64::from(det.signum())) as f32; }
    }
    packet.instances[0].transform = [a,b,0.0,0.0,c,d,0.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0,0.0,1.0];
    validate_packet(&packet).unwrap(); packet
}
/// Local-coordinate normalized NDF/Lambda equation, independent of WGSL stable visibility.
fn expected(x: u32, y: u32, view: deep_engine_native::player_view::PlayerView, matrix: [f32; 4], strength: f32) -> Vector {
    let [right, up, forward] = view.basis().map(|v| v.map(f64::from));
    let px = (2.0 * (f64::from(x) + 0.5) / f64::from(SIZE) - 1.0) / f64::from(view.focal);
    let py = (1.0 - 2.0 * (f64::from(y) + 0.5) / f64::from(SIZE)) / f64::from(view.focal);
    let n = forward.map(|v| -v);
    let v = unit(std::array::from_fn(|i| -forward[i] - px * right[i] - py * up[i]));
    let l = n; let h = unit(std::array::from_fn(|i| v[i] + l[i]));
    let raw = [f64::from(matrix[0]), f64::from(matrix[1]), 0.0];
    let projected = std::array::from_fn(|i| raw[i] - n[i] * dot(raw, n));
    let t = if dot(projected, projected) > 1e-8 { unit(projected) } else { unit(cross([1.0, 0.0, 0.0], n)) };
    let b = unit(cross(n, t)); let (s, c) = f64::from(0.4f32).sin_cos();
    let tr = std::array::from_fn(|i| t[i] * c + b[i] * s);
    let br = std::array::from_fn(|i| b[i] * c - t[i] * s);
    let nv = dot(n, v); let nh = dot(n, h); let vh = dot(v, h);
    let alpha = f64::from(0.6f32).powi(2); let ax = alpha * (1.0 + f64::from(strength)); let ay = alpha;
    let q = (dot(tr, h) / ax).powi(2) + (dot(br, h) / ay).powi(2) + nh * nh;
    let d = 1.0 / (std::f64::consts::PI * ax * ay * q * q);
    let lambda = (1.0 + ((ax * dot(tr, v)).powi(2) + (ay * dot(br, v)).powi(2)) / (nv * nv)).sqrt() * 0.5 - 0.5;
    [0.8f32, 0.4, 0.1].map(|f0| { let f0 = f64::from(f0); (f0 + (1.0 - f0) * (1.0 - vh).powi(5)) * d / (4.0 * nv * (1.0 + lambda)) })
}
pub(super) fn hash(pixels: &[[f32; 3]]) -> String {
    let bytes: Vec<u8> = pixels.iter().flat_map(|p| p.iter().flat_map(|v| v.to_le_bytes())).collect();
    evidence_hash::sha256(&bytes)
}
#[test]
#[ignore = "requires >=19 sampled textures and a real GPU; run explicitly"]
fn layered_metal_reflection_main_light_matches_independent_response_and_transforms() {
    let Some((device, queue)) = super::layered_gpu_tests::request_layered_furnace_device() else {
        panic!("layered_metal_reflection_executed=false reason=adapter_or_texture_limit");
    };
    let (mut frame, view) = furnace_frame(); let normal = view.basis()[2].map(|v| -v);
    frame[9][3] = 0.0; frame[11] = [normal[0],normal[1],normal[2],0.0]; frame[13] = [1.0,1.0,1.0,2.0];
    let matrices = [[1.0,0.0,0.0,1.0], [0.8 * 0.5f32.cos(),0.8 * 0.5f32.sin(),-1.3 * 0.5f32.sin(),1.3 * 0.5f32.cos()],
      [-1.0,0.0,0.0,1.0], [1e-5,0.0,0.0,1.0]];
    let mut max_error = 0.0f64;
    for (case, matrix) in matrices.into_iter().enumerate() { for strength in [0.0,1e-7,0.01,1.0] {
        let packet = transformed(packet(strength,1.0),matrix);
        let pixels = render_material_frame(&device,&queue,&packet,"metal profile",true,frame,view);
        for (index, actual) in pixels.iter().enumerate() {
            let expected = expected(index as u32 % SIZE,index as u32 / SIZE,view,matrix,strength);
            for i in 0..3 { assert!(actual[i].is_finite()); max_error = max_error.max((f64::from(actual[i]) - expected[i]).abs()); }
        }
        println!("metal_transform_case={case} strength={strength} pixels={} hdr_sha256={}",pixels.len(),hash(&pixels));
    }}
    assert!(max_error <= 0.002,"independent metal response error {max_error}");
    let mut plain = packet(0.0,0.0); plain.materials[0].layered = None;
    let stock = render_material_frame(&device,&queue,&plain,"metal stock",false,frame,view);
    let zero = render_material_frame(&device,&queue,&packet(1.0,0.0),"metal pruned",true,frame,view);
    assert_eq!(stock,zero);
    let mut legacy = plain.clone(); legacy.materials[0].layered = Some(serde_json::from_value(serde_json::json!({"layers":[{"coverage":1}]})).unwrap());
    let legacy_pixels = render_material_frame(&device,&queue,&legacy,"metal legacy",true,frame,view);
    assert_eq!(stock,legacy_pixels);
    let mut auxiliary = plain.clone(); auxiliary.materials[0].base_color = [0.8,0.4,0.1]; auxiliary.materials[0].metallic = 1.0;
    auxiliary.materials[0].roughness = 0.6; auxiliary.materials[0].emissive_factor = Some([0.13,0.07,0.02]);
    let mut active = auxiliary.clone(); active.materials[0].layered = packet(0.8,1.0).materials[0].layered.clone();
    let mut aux_frame = frame; aux_frame[9][3] = 1.0; aux_frame[13] = [0.0,0.0,0.0,2.0];
    let aux_stock = render_material_frame(&device,&queue,&auxiliary,"metal auxiliary stock",false,aux_frame,view);
    let aux_active = render_material_frame(&device,&queue,&active,"metal auxiliary active",true,aux_frame,view);
    assert_eq!(aux_stock,aux_active);
    let color_packet = |alpha: u8| {
        let mut packet = packet(0.8,1.0);
        packet.textures.push(serde_json::from_value(serde_json::json!({"id":"metal-color", "revision":alpha,
          "semantic":"baseColor","width":1,"height":1,"data":[128,192,64,alpha]})).unwrap());
        packet.materials[0].layered.as_mut().unwrap().layers[0].surface.as_mut().unwrap().base_color_texture = Some(
          serde_json::from_value(serde_json::json!({"texture":"metal-color","texCoord":0,"offset":[0.13,0.04],"scale":[0.75,0.8]})).unwrap());
        validate_packet(&packet).unwrap(); packet
    };
    let parent = render_material_frame(&device,&queue,&color_packet(255),"metal color parent",true,frame,view);
    let half = render_material_frame(&device,&queue,&color_packet(128),"metal alpha half",true,frame,view);
    let alpha0 = render_material_frame(&device,&queue,&color_packet(0),"metal alpha zero",true,frame,view);
    assert_eq!(stock,alpha0);
    let mut blend_error = 0.0f64;
    for i in 0..parent.len() { for c in 0..3 {
        let weight = 128.0 / 255.0;
        let expected = f64::from(stock[i][c]) * (1.0-weight) + f64::from(parent[i][c]) * weight;
        blend_error = blend_error.max((f64::from(half[i][c])-expected).abs());
    }}
    assert!(blend_error <= 0.002,"color alpha mixture error {blend_error}");
    println!("layered_metal_reflection_executed=true cases=16 max_closed_error={max_error} coverage0_identity=true legacy_identity=true auxiliary_identity=true stock_hdr_sha256={}",hash(&stock));
}
