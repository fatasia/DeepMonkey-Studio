//! 缓存依赖见证、内容相等与资源占用口径。
use super::super::Deep2dPathVerb;
use super::{CameraWitness, Deep2dPathCache, Entry, PathCommand, PathResource};

impl Deep2dPathCache {
    /// 本帧生效的相机见证:显式声明优先,否则退回显示列表自带的 scale_factor。
    /// 同时回收「见证」与「实际用于细分的缩放值」——二者必须同源,否则会出现
    /// 「见证记 2.0 而几何按 1.0 细分」的自相矛盾条目,后续帧将永久命中错误几何。
    pub(super) fn camera_witness(&self, display_scale: f64) -> CameraWitness {
        let effective = self
            .camera_scale
            .or(display_scale.is_finite().then_some(display_scale));
        CameraWitness {
            scale_bits: effective.map(f64::to_bits),
            scale: effective.unwrap_or(display_scale),
        }
    }
}

// 命令侧 clip 集合是否与条目存储时一致;条目 clips 由 store 时的 clip_path_ids 顺序解析而来。
pub(super) fn same_clip_ids(entry: &Entry, command: &PathCommand) -> bool {
    let current = command.clip_path_ids.as_deref().unwrap_or(&[]);
    entry.clips.len() == current.len()
        && entry
            .clips
            .iter()
            .zip(current)
            .all(|(clip, id)| clip.id == *id)
}

pub(super) fn same_resource(a: &PathResource, b: &PathResource) -> bool {
    a.id == b.id && a.verbs == b.verbs
}
pub(super) fn resource_bytes(resource: &PathResource) -> usize {
    std::mem::size_of::<PathResource>()
        + resource.id.len()
        + resource.verbs.len() * std::mem::size_of::<Deep2dPathVerb>()
}
