use super::*;
pub(super) fn key(layer: &str, id: &str) -> String {
    format!(
        "dashboard.{}",
        crate::runtime_package::runtime_content_sha256(&serde_json::json!([layer, id]))
    )
}

pub(super) fn namespace(content: &mut Deep2dRuntimeContent, layer: &str) -> Result<(), String> {
    let (list, atlases, quads) = match content {
        Deep2dRuntimeContent::DisplayList(list) => (list, None, None),
        Deep2dRuntimeContent::Package(package) => (
            &mut package.display_list,
            Some(&mut package.atlases),
            Some(&mut package.quads),
        ),
        Deep2dRuntimeContent::Composite(_) => {
            return Err("nested Deep2d composite is unsupported".into());
        }
    };
    for resource in &mut list.resources {
        match resource {
            Deep2dResource::Path(value) => value.id = key(layer, &value.id),
            Deep2dResource::Font(value) => value.id = key(layer, &value.id),
            Deep2dResource::Image(value) => value.id = key(layer, &value.id),
        }
    }
    for atlas in list.atlases.iter_mut().chain(atlases.into_iter().flatten()) {
        atlas.id = key(layer, &atlas.id);
    }
    for command in &mut list.commands {
        macro_rules! common {
            ($value:expr) => {{
                $value.id = key(layer, &$value.id);
                if let Some(ids) = &mut $value.clip_path_ids {
                    for id in ids {
                        *id = key(layer, id);
                    }
                }
            }};
        }
        match command {
            Deep2dCommand::Path(value) => {
                common!(value);
                value.path_id = key(layer, &value.path_id);
            }
            Deep2dCommand::Text(value) => {
                common!(value);
                value.font_id = key(layer, &value.font_id);
                if let Some(id) = &mut value.atlas_id {
                    *id = key(layer, id);
                }
            }
            Deep2dCommand::Image(value) => {
                common!(value);
                value.image_id = key(layer, &value.image_id);
                if let Some(id) = &mut value.atlas_id {
                    *id = key(layer, id);
                }
            }
        }
    }
    for quad in quads.into_iter().flatten() {
        quad.id = key(layer, &quad.id);
        quad.atlas_id = key(layer, &quad.atlas_id);
    }
    Ok(())
}
