//! Dashboard 视频槽位提取(deep2d_gpu 的 `#[cfg(windows)]` `#[path]` 子模块,
//! 体量门)。从合成层清单提取 `:video` 后缀层为槽位;几何非法 fail-closed。

use deep_engine_native::deep2d::Deep2dRuntimeContent;

#[derive(Debug, Clone, PartialEq)]
pub struct DashboardVideoSlot {
    pub node_id: String,
    pub layer_index: usize,
    pub frame: [f32; 4],
    pub clip: deep_engine_native::deep2d::Deep2dRect,
}

pub(super) fn dashboard_video_slots(
    content: &Deep2dRuntimeContent,
) -> Result<Vec<DashboardVideoSlot>, String> {
    let Deep2dRuntimeContent::Composite(composite) = content else {
        return Ok(Vec::new());
    };
    composite
        .layers()
        .iter()
        .enumerate()
        .filter_map(|(layer_index, layer)| {
            layer.id.strip_suffix(":video").map(|node_id| {
                let list = layer.content.display_list();
                let values = [
                    layer.translation[0],
                    layer.translation[1],
                    list.logical_width,
                    list.logical_height,
                ];
                if values.iter().any(|value| !value.is_finite())
                    || values[2] <= 0.0
                    || values[3] <= 0.0
                {
                    return Err("invalid dashboard video slot geometry".into());
                }
                Ok(DashboardVideoSlot {
                    node_id: node_id.to_owned(),
                    layer_index,
                    frame: values.map(|value| value as f32),
                    clip: layer.clip,
                })
            })
        })
        .collect()
}
