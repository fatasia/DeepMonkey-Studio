use super::Deep2dPathCacheMissReasons;

/// miss 的首要失效原因。判定顺序固定:相机 → epoch → 结构 → clip → resource → style →
/// 首次;一次 miss 只归入最先命中的原因(见 prepare 的归因注释)。
///
/// 三个依赖维度与 P1-01 的 ChartEpoch 对齐:
/// - `CameraChanged` 对应物理缩放(scale_factor / DPI)变化,属布局维度;
/// - `EpochChanged` 对应呈现资源集(resource_set)整体换代的 epoch 缝隙;
/// - `ResourceChanged` 对应单个 path 资源内容变化。
///
/// 数据 revision 与 z 序/HitId 刻意不进依赖图:它们不改变细分几何,进图只会制造假失效。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deep2dPathCacheMissReason {
    CameraChanged,
    EpochChanged,
    StructureChanged,
    ClipChanged,
    ResourceChanged,
    StyleChanged,
    Evicted,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct Deep2dPathCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub miss_reasons: Deep2dPathCacheMissReasons,
    pub evictions: u64,
    /// Number of cached path entries removed because their command id was
    /// absent from a successfully prepared display frame.
    pub deletions: u64,
    pub entries: usize,
    pub payload_bytes: usize,
}
impl std::fmt::Display for Deep2dPathCacheStats {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reasons = &self.miss_reasons;
        write!(
            f,
            "hits={} misses={} (camera_changed={} epoch_changed={} structure_changed={} clip_changed={} resource_changed={} style_changed={} evicted={}) evictions={} deletions={} entries={} payload_bytes={}",
            self.hits,
            self.misses,
            reasons.camera_changed,
            reasons.epoch_changed,
            reasons.structure_changed,
            reasons.clip_changed,
            reasons.resource_changed,
            reasons.style_changed,
            reasons.evicted,
            self.evictions,
            self.deletions,
            self.entries,
            self.payload_bytes
        )
    }
}
