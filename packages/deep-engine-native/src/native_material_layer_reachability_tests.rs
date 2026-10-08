use wgpu::naga;

fn verify(label: &str, source: &str) {
    let module = naga::front::wgsl::parse_str(source)
        .unwrap_or_else(|error| panic!("{label}: {}", error.emit_to_string(source)));
    let info = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .unwrap_or_else(|error| panic!("{label}: {error:?}"));
    assert!(source.contains("native_layer_lit_response(input"));
    assert_eq!(source.matches("fn deepDielectricF0(").count(), 1);
    assert_eq!(
        source.matches("fn deepEvaluateExtendedMaterial(").count(),
        1
    );
    let mut ordinary = 0;
    let mut layered = 0;
    for (index, entry) in module.entry_points.iter().enumerate() {
        let uses: Vec<u32> = module
            .global_variables
            .iter()
            .filter_map(|(handle, global)| {
                let binding = global.binding.as_ref()?;
                (binding.group == 1
                    && (11..=19).contains(&binding.binding)
                    && !info.get_entry_point(index)[handle].is_empty())
                .then_some(binding.binding)
            })
            .collect();
        if entry.name.ends_with("_layered") {
            assert!(!uses.is_empty(), "{} must reach layer bindings", entry.name);
            layered += 1;
        } else {
            assert!(
                uses.is_empty(),
                "{} unexpectedly reaches {uses:?}",
                entry.name
            );
            ordinary += 1;
        }
        println!(
            "module={label} entry={} layer_bindings={uses:?}",
            entry.name
        );
    }
    assert!(ordinary > 0 && layered >= 2);
    println!("module={label} validated=true ordinary={ordinary} layered={layered}");
}

#[test]
fn material_layer_core_preserves_ordinary_raster_and_rt_resource_reachability() {
    verify("raster", &super::native_mesh_shader_source());
    verify("rt", &super::native_mesh_rt_shader_source());
}
