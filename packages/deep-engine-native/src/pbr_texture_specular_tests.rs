use crate::{contract::{RenderPacket,validate_packet},pbr_texture::{prepare_pbr_resources,TextureEncoding}};
use serde_json::{json,Value};
fn source() -> Value {
    json!({"schema":"deep-engine.render-packet","version":1,"geometries":[{"id":"g","revision":1,
        "vertices":[-1,-1,0,0,0,1,1,-1,0,0,0,1,0,1,0,0,0,1],"indices":[0,1,2],
        "uv0":[0,0,1,0,0,1],"uv1":[1,0,0,0,1,1]}],
        "materials":[{"id":"m","baseColor":[1,1,1],"metallic":0,"roughness":0.3,
        "specularFactor":0.5,"specularColorFactor":[2,0.5,1],
        "specularTexture":{"texture":"strength","texCoord":0},
        "specularColorTexture":{"texture":"color","texCoord":1,"offset":[0.25,0.5]}}],
        "instances":[{"id":"i","geometry":"g","material":"m","transform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}],
        "textures":[{"id":"strength","revision":1,"width":1,"height":1,"semantic":"specular","data":[255,255,255,64]},
        {"id":"color","revision":1,"width":1,"height":1,"semantic":"specularColor","data":[128,64,255,255]}]})
}
fn packet(value:&Value)->RenderPacket { serde_json::from_value(value.clone()).unwrap() }
#[test]
fn specular_seven_slots_keep_source_rgba_and_independent_uv() {
    let packet = packet(&source());
    let prepared=prepare_pbr_resources(&packet).unwrap();
    assert_eq!(prepared.textures[0].encoding,TextureEncoding::Linear);
    assert_eq!(prepared.textures[1].encoding,TextureEncoding::Srgb);
    assert_eq!(prepared.textures[0].levels[0].data.as_ref(), &[255,255,255,64]);
    assert_eq!(prepared.materials[0].texture_indices,[None,None,None,None,None,Some(0),Some(1)]);
    let row=&prepared.materials[0].uniform;
    assert_eq!(row.len(),80); assert_eq!(row[63],1.0); assert_eq!(row[71],2.0);
    assert_eq!(row[70],0.25); assert_eq!(row[74],0.5); assert_eq!(row[76..80],[2.0,0.5,1.0,0.5]);
}
#[test]
fn specular_requires_matching_semantics_and_declared_uv_set() {
    let mut input=source(); input["textures"][1]["semantic"]=json!("baseColor");
    assert!(validate_packet(&packet(&input)).unwrap_err().contains("mismatched texture color"));
    let mut input=source(); input["geometries"][0].as_object_mut().unwrap().remove("uv1");
    assert!(validate_packet(&packet(&input)).unwrap_err().contains("UV1"));
}
#[test]
fn specular_factor_domain_is_shared_with_browser_and_color_may_exceed_one() {
    assert!(validate_packet(&packet(&source())).is_ok());
    for field in ["specularFactor","specularColorFactor"] {
        let mut input=source(); input["materials"][0][field]=if field=="specularFactor" { json!(1.1) } else { json!([-0.1,1,1]) };
        assert!(validate_packet(&packet(&input)).unwrap_err().contains("specular"));
        input["materials"][0][field]=Value::Null;
        assert!(serde_json::from_value::<RenderPacket>(input).is_err());
    }
}

#[test]
fn physical_transmission_keeps_source_alpha_and_mask_cutoff() {
    use crate::contract::AlphaMode;
    use crate::scene::prepare_scene;
    for source_mode in ["OPAQUE","BLEND","MASK"] {
        let mut input=source();
        input["materials"][0]["alphaMode"]=json!(source_mode);
        input["materials"][0]["baseColorAlpha"]=json!(1.0);
        input["materials"][0]["extendedParameters"]=json!({"transmission":{"factor":1.0}});
        let packet=packet(&input); let material=&packet.materials[0];
        assert_eq!(material.draw_alpha_mode(),AlphaMode::Blend);
        let prepared=prepare_scene(&packet).unwrap();
        assert_eq!(prepared.batches[0].alpha_mode,AlphaMode::Blend);
        assert_eq!(prepared.instances[0][35],1.0);
        if source_mode=="MASK" {
            assert_eq!(prepared.instances[0][29],0.5);
            assert_eq!(prepared.instances[0][31] as u32 & 2,2);
        }
        assert_eq!(prepare_pbr_resources(&packet).unwrap().materials[0].uniform[45],1.0);
    }
    let mut input=source();
    input["materials"][0]["extendedParameters"]=json!({"transmission":{"factor":1.01}});
    assert!(validate_packet(&packet(&input)).is_err());
}
