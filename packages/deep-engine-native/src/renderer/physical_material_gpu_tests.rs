//! Actual stock Native/WASM mesh pipelines on a device requested at the WebGPU default 16 slots.
use super::megalights_material_fixture as fixture;
use deep_engine_native::contract::RenderPacket;
use fixture::{Fixture, hdr_pixel};
use serde_json::{Value, json};

fn packet(material: Value, behind: Option<[f32; 3]>) -> RenderPacket {
    let identity = [
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
    ];
    let mut front = identity;
    front[14] = 0.5;
    let mut materials = vec![material];
    let mut instances =
        vec![json!({"id":"front","geometry":"plane","material":"m","transform":front})];
    if let Some(color) = behind {
        materials.push(json!({"id":"background","baseColor":[0,0,0],"metallic":0,"roughness":0.5,"emissiveFactor":color}));
        instances.push(
            json!({"id":"behind","geometry":"plane","material":"background","transform":identity}),
        );
    }
    serde_json::from_value(json!({"schema":"deep-engine.render-packet","version":1,
        "geometries":[{"id":"plane","revision":1,
            "vertices":[-2.,-2.,0.,0.,0.,1.,2.,-2.,0.,0.,0.,1.,2.,2.,0.,0.,0.,1.,-2.,2.,0.,0.,0.,1.],
            "indices":[0,1,2,0,2,3],"uv0":[0.,0.,1.,0.,1.,1.,0.,1.],"uv1":[1.,0.,0.,0.,0.,1.,1.,1.]}],
        "materials":materials,"instances":instances,"textures":[]})).unwrap()
}

fn render(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    packet: &RenderPacket,
) -> ([f32; 4], [f32; 4]) {
    let mut fixture = Fixture::with_packet(device, queue, 32, 32, packet);
    fixture.frame[11] = [0., 0., 1., 0.];
    fixture.frame[13] = [1., 1., 1., 3.];
    queue.write_buffer(
        &fixture.frame_buffer,
        0,
        bytemuck::cast_slice(&fixture.frame),
    );
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut encoder = device.create_command_encoder(&Default::default());
    fixture.culling.encode(queue, &mut encoder);
    crate::mesh_pass::encode_mesh_passes(
        &mut encoder,
        &fixture.targets,
        &fixture.frame_group,
        &fixture.scene,
        &fixture.culling,
        None,
        &fixture.pipelines,
        0.,
    );
    queue.submit([encoder.finish()]);
    fixture.culling.commit_submission();
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert!(
        pollster::block_on(scope.pop()).is_none(),
        "actual material GPU bindings"
    );
    (
        hdr_pixel(device, queue, &fixture.targets, 10, 16),
        hdr_pixel(device, queue, &fixture.targets, 22, 16),
    )
}

async fn device() -> (wgpu::Device, wgpu::Queue) {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12;
    let adapter = wgpu::Instance::new(descriptor)
        .request_adapter(&Default::default())
        .await
        .unwrap();
    eprintln!("Physical material GPU {:?}", adapter.get_info());
    let result = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .unwrap();
    assert_eq!(result.0.limits().max_sampled_textures_per_shader_stage, 16);
    result
}

#[test]
#[ignore = "requires an exclusive actual GPU validation window"]
fn physical_material_native_gpu_specular_and_opaque_transmission() {
    pollster::block_on(async {
        let (device, queue) = device().await;
        let black = json!({"id":"m","baseColor":[0,0,0],"metallic":0,"roughness":0.4});
        let stock = render(&device, &queue, &packet(black.clone(), None)).0;
        let mut zero = black.clone();
        zero["specularFactor"] = json!(0);
        let zero = render(&device, &queue, &packet(zero, None)).0;
        assert!(
            stock[0] > 0.001 && zero[..3].iter().all(|v| v.abs() < 0.00001),
            "factor stock={stock:?} zero={zero:?}"
        );
        let mut color = black.clone();
        color["specularColorFactor"] = json!([1, 0, 0]);
        let color = render(&device, &queue, &packet(color, None)).0;
        assert!(color[0] > color[1] * 10., "color factor {color:?}");
        let mut textured = packet(black.clone(), None);
        textured.materials[0].specular_color_texture =
            serde_json::from_value(json!({"texture":"color","texCoord":0})).unwrap();
        textured.textures =
            serde_json::from_value(json!([{"id":"color","revision":1,"width":2,"height":1,
            "semantic":"specularColor","data":[255,0,0,255,0,255,0,255]}]))
            .unwrap();
        let (left, right) = render(&device, &queue, &textured);
        assert!(
            left[0] > left[1] * 2. && right[1] > right[0] * 2.,
            "sRGB color left={left:?} right={right:?}"
        );
        textured.materials[0]
            .specular_color_texture
            .as_mut()
            .unwrap()
            .tex_coord = Some(1);
        let (flipped_left, flipped_right) = render(&device, &queue, &textured);
        assert!(
            flipped_left[1] > flipped_left[0] * 2. && flipped_right[0] > flipped_right[1] * 2.,
            "UV1 left={flipped_left:?} right={flipped_right:?}"
        );
        textured.materials[0].specular_color_texture = None;
        textured.materials[0].specular_texture =
            serde_json::from_value(json!({"texture":"strength"})).unwrap();
        textured.textures =
            serde_json::from_value(json!([{"id":"strength","revision":1,"width":2,"height":1,
            "semantic":"specular","data":[0,0,0,255,255,255,255,0]}]))
            .unwrap();
        let (strength_left, strength_right) = render(&device, &queue, &textured);
        assert!(
            strength_left[0] > strength_right[0] * 2.,
            "linear alpha left={strength_left:?} right={strength_right:?}"
        );
        let glass = json!({"id":"m","baseColor":[1,1,1],"baseColorAlpha":1,"alphaMode":"OPAQUE",
            "metallic":0,"roughness":0.2,"extendedParameters":{"transmission":{"factor":1}}});
        let red = render(&device, &queue, &packet(glass.clone(), Some([2., 0., 0.]))).0;
        let blue = render(&device, &queue, &packet(glass, Some([0., 0., 2.]))).0;
        assert!(
            red[0] > red[2] * 5. && blue[2] > blue[0] * 5.,
            "opaque alpha1 actual interior red={red:?} blue={blue:?}"
        );
        eprintln!(
            "Native/WASM shared physical material GPU PASS: factor/color/sRGB/alpha/UV1/source-alpha1/interior-red/interior-blue, limit16; stock={stock:?} glassRed={red:?} glassBlue={blue:?}"
        );
    });
}
