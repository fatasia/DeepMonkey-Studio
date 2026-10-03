//! Original I23 per-layer surface/texture profile; no new response model.
use deep_engine_native::contract::{RenderPacket, validate_packet};
use serde_json::{Value, json};

pub(super) const WEIGHTS: [f64; 2] = [0.65 * 128.0 / 255.0, 0.4 * 192.0 / 255.0];

pub(super) fn fixture(vertices: Vec<f32>) -> Value {
    let color = |id: &str, alpha: u8, values: [[u8; 3]; 4]| {
        json!({
            "id":id, "revision":1, "semantic":"baseColor", "width":2, "height":2,
            "sampler":{"magFilter":"nearest","minFilter":"nearest"},
            "data": values.into_iter().flat_map(|rgb| [rgb[0],rgb[1],rgb[2],alpha]).collect::<Vec<_>>()
        })
    };
    let mr = |id: &str, values: [[u8; 3]; 4]| {
        json!({
            "id":id, "revision":1, "semantic":"metallicRoughness", "width":2, "height":2,
            "sampler":{"magFilter":"nearest","minFilter":"nearest"},
            "data": values.into_iter().flat_map(|rgb| [rgb[0],rgb[1],rgb[2],255]).collect::<Vec<_>>()
        })
    };
    json!({
        "schema":"deep-engine.render-packet", "version":1,
        "geometries":[{"id":"layer-texture-wall","revision":1,"vertices":vertices,
          "uv0":[-1,-1,2,-1,2,2,-1,2], "uv1":[2,-1,-1,-1,-1,2,2,2],
          "indices":[0,1,2,0,2,3]}],
        "materials":[{"id":"layer-texture-material", "baseColor":[0.35,0.45,0.6],
          "metallic":0.1,"roughness":0.8,"alphaMode":"OPAQUE","doubleSided":true,
          "layered":{"layers":[
            {"coverage":0.65,"mode":"replace","surface":{"baseColor":[0.95,0.8,0.55],
              "metallic":0.8,"roughness":0.65,
              "baseColorTexture":{"texture":"layer-color0","texCoord":1,"offset":[0.13,0.04],"scale":[0.75,0.8],"rotation":0.17},
              "metallicRoughnessTexture":{"texture":"layer-mr0","texCoord":0,"offset":[0.04,0.13],"scale":[0.8,0.75],"rotation":-0.12}}},
            {"coverage":0.4,"mode":"overlay","surface":{"baseColor":[0.14,0.65,0.8],
              "metallic":0.45,"roughness":0.9,
              "baseColorTexture":{"texture":"layer-color1","texCoord":0,"offset":[0.11,0.08],"scale":[0.85,0.7],"rotation":-0.09},
              "metallicRoughnessTexture":{"texture":"layer-mr1","texCoord":1,"offset":[0.08,0.11],"scale":[0.7,0.85],"rotation":0.13}}}
          ]}}],
        "instances":[{"id":"layer-texture-wall","geometry":"layer-texture-wall","material":"layer-texture-material",
          "transform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}],
        "textures":[
          color("layer-color0",128,[[255,70,15],[40,220,100],[60,80,255],[230,190,35]]),
          mr("layer-mr0",[[255,80,230],[255,230,10],[255,180,120],[255,40,200]]),
          color("layer-color1",192,[[80,230,160],[220,40,200],[230,190,40],[30,60,255]]),
          mr("layer-mr1",[[255,230,30],[255,70,240],[255,190,100],[255,120,180]])
        ]
    })
}

pub(super) fn packet(value: &Value) -> RenderPacket {
    let packet: RenderPacket = serde_json::from_value(value.clone()).expect("layer texture JSON");
    validate_packet(&packet).expect("layer texture contract");
    packet
}

/// Actual ordinary-material parents: same decoded textures and transforms,
/// but no layered uniform, deep_layer_stack, or response-blend code.
pub(super) fn parent(value: &Value, layer: Option<usize>) -> RenderPacket {
    let mut copy = value.clone();
    let material = &mut copy["materials"][0];
    let surface = layer.map(|index| material["layered"]["layers"][index]["surface"].clone());
    material.as_object_mut().unwrap().remove("layered");
    if let Some(surface) = surface {
        for (key, value) in surface.as_object().unwrap() {
            material[key] = value.clone();
        }
    }
    packet(&copy)
}

pub(super) fn expected(base: &[[f32; 3]], parents: &[Vec<[f32; 3]>; 2]) -> Vec<[f64; 3]> {
    assert_eq!(base.len(), parents[0].len());
    assert_eq!(base.len(), parents[1].len());
    base.iter()
        .enumerate()
        .map(|(pixel, base)| {
            std::array::from_fn(|channel| {
                let p0 = f64::from(parents[0][pixel][channel]);
                let p1 = f64::from(parents[1][pixel][channel]);
                let first = f64::from(base[channel]) * (1.0 - WEIGHTS[0]) + p0 * WEIGHTS[0];
                let overlay = WEIGHTS[1] * p1.clamp(0.0, 1.0);
                first * (1.0 - overlay) + p1 * overlay
            })
        })
        .collect()
}
