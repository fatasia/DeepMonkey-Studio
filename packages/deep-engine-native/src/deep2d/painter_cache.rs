//! 按命令保存已验证的细分结果；排序、命中 ID 和 scissor 使用当前帧元数据。
use super::{PathCommand, PathResource};
use std::collections::{BTreeSet, HashMap, HashSet};

#[path = "painter_cache_capacity.rs"]
mod capacity;
#[path = "painter_cache_keys.rs"]
mod keys;
#[path = "painter_cache_packages.rs"]
mod packages;
#[path = "painter_cache_prepare.rs"]
mod prepare;
#[path = "painter_cache_stats.rs"]
mod stats;
pub use stats::{Deep2dPathCacheMissReason, Deep2dPathCacheStats};

/// 按原因分解的 miss 计数;total() 恒等于 stats.misses。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct Deep2dPathCacheMissReasons {
    pub camera_changed: u64,
    pub epoch_changed: u64,
    pub structure_changed: u64,
    pub clip_changed: u64,
    pub resource_changed: u64,
    pub style_changed: u64,
    pub evicted: u64,
}
impl Deep2dPathCacheMissReasons {
    fn record(&mut self, reason: Deep2dPathCacheMissReason) {
        match reason {
            Deep2dPathCacheMissReason::CameraChanged => self.camera_changed += 1,
            Deep2dPathCacheMissReason::EpochChanged => self.epoch_changed += 1,
            Deep2dPathCacheMissReason::StructureChanged => self.structure_changed += 1,
            Deep2dPathCacheMissReason::ClipChanged => self.clip_changed += 1,
            Deep2dPathCacheMissReason::ResourceChanged => self.resource_changed += 1,
            Deep2dPathCacheMissReason::StyleChanged => self.style_changed += 1,
            Deep2dPathCacheMissReason::Evicted => self.evicted += 1,
        }
    }
    pub fn total(&self) -> u64 {
        self.camera_changed
            + self.epoch_changed
            + self.structure_changed
            + self.clip_changed
            + self.resource_changed
            + self.style_changed
            + self.evicted
    }
}

/// 每条缓存条目携带的依赖见证(epoch/相机维度)。字段只影响失效判定与归因,
/// 不参与几何产物:见证一致时细分结果逐字节可复用。
/// 相机见证存 f64 位模式而非 f64:见证只做同一性比较,不需要数值序,
/// 位比较还消除 -0.0/0.0 与 NaN 载荷造成的「数值相等而见证不等」歧义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EntryWitness {
    camera_scale_bits: Option<u64>,
    resource_epoch: Option<u64>,
}

/// 一帧的相机取样结果:见证位模式(用于条目比较)与实际细分缩放(用于几何)。
/// 两者必须同源产出,禁止各算一次。
#[derive(Debug, Clone, Copy, PartialEq)]
struct CameraWitness {
    scale_bits: Option<u64>,
    scale: f64,
}

struct Entry {
    style: PathCommand,
    resource: PathResource,
    clips: Vec<PathResource>,
    witness: EntryWitness,
    vertices: Vec<[f32; 6]>,
    segments: usize,
    fill_triangles: usize,
    stroke_triangles: usize,
    bytes: usize,
    touched: u64,
}

/// 逐出记忆的保底容量:max_entries 极小时仍能辨认「刚被逐出又回归」的 id。
const MIN_EVICTED_MEMORY: usize = 64;

pub struct Deep2dPathCache {
    packages: Option<packages::PackageCache>,
    entries: HashMap<String, Entry>,
    order: BTreeSet<(u64, String)>,
    stats: Deep2dPathCacheStats,
    tick: u64,
    max_entries: usize,
    max_bytes: usize,
    // 内容来源 epoch:换包/换源/resource_set 换代即变。None 表示宿主未声明 epoch,
    // 此时该维度不参与失效判定(行为与第一批逐字节一致),也不写入条目见证。
    resource_epoch: Option<u64>,
    // 相机(物理缩放)维度:DPI 或窗口缩放变化即变。None 时退回逐帧读 display_list.scale_factor,
    // 使既有调用方无需接线即保持原语义。
    camera_scale: Option<f64>,
    // 最近被 LRU 逐出的 id:回归时把 miss 归因为 evicted 而非 structure_changed。
    // 容量随 max_entries 有界,溢出清空属有损记忆(被遗忘的回归 id 回退记 structure_changed),
    // 只影响归因标签,不影响命中/失效判定。
    recently_evicted: HashSet<String>,
}
impl Default for Deep2dPathCache {
    fn default() -> Self {
        Self {
            packages: None,
            entries: HashMap::new(),
            order: BTreeSet::new(),
            stats: Default::default(),
            tick: 0,
            max_entries: 4096,
            max_bytes: 8 * 1024 * 1024,
            resource_epoch: None,
            camera_scale: None,
            recently_evicted: HashSet::new(),
        }
    }
}
impl Deep2dPathCache {
    pub fn stats(&self) -> Deep2dPathCacheStats {
        self.stats
    }

    /// 声明当前内容来源 epoch(换包/换源的 ChartEpoch.resource_set)。
    /// 换代不立即清缓存,而是让所有旧条目在下一次 prepare 时按依赖图失效并归因 epoch_changed;
    /// 同代重复设置是空操作,避免把幂等刷新算成失效。
    pub fn set_resource_epoch(&mut self, epoch: u64) {
        self.resource_epoch = Some(epoch);
    }

    /// 声明当前相机物理缩放。与 display_list.scale_factor 之一作为本帧的相机见证,
    /// 两者都未声明时见证为空,条目不做相机判定(与原实现等价)。
    pub fn set_camera_scale(&mut self, scale: f64) {
        self.camera_scale = scale.is_finite().then_some(scale);
    }

    /// 本帧生效的物理缩放:宿主显式声明的相机优先,否则退回显示列表自带值。
    /// 细分、文字/图片 quad、clip 与缓存见证都必须取这一个值——整帧同源,
    /// 否则会出现「见证记物理缩放而几何按逻辑单位细分」的内部矛盾(见 CameraWitness)。
    pub(crate) fn effective_scale(&self, display_scale: f64) -> f64 {
        self.camera_witness(display_scale).scale
    }

    /// 指定 LRU 容量与字节预算的构造入口(字段私有;供测试与基准压缩容量观察逐出)。
    pub fn with_limits(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            max_entries,
            max_bytes,
            ..Default::default()
        }
    }
}

#[cfg(test)]
#[path = "painter_cache_capacity_tests.rs"]
mod capacity_tests;
#[cfg(test)]
#[path = "painter_cache_dependency_tests.rs"]
mod dependency_tests;
