//! 按命令保存已验证的细分结果；排序、命中ID和scissor仍使用当前帧元数据。
use super::{Deep2dPainterIssue, Deep2dPathVerb, PathCommand, PathResource, PreparedDeep2d};
use std::collections::{BTreeSet, HashMap, HashSet};

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

    /// 本帧生效的相机见证:显式声明优先,否则退回显示列表自带的 scale_factor。
    /// 同时回收「见证」与「实际用于细分的缩放值」——二者必须同源,否则会出现
    /// 「见证记 2.0 而几何按 1.0 细分」的自相矛盾条目,后续帧将永久命中错误几何。
    fn camera_witness(&self, display_scale: f64) -> CameraWitness {
        let effective = self
            .camera_scale
            .or(display_scale.is_finite().then_some(display_scale));
        CameraWitness {
            scale_bits: effective.map(f64::to_bits),
            scale: effective.unwrap_or(display_scale),
        }
    }

    /// 成功准备显示列表后清理不再使用的路径。失败准备不执行删除清理，
    /// 但沿用既有规则：已准备命令仍可能更新纯缓存条目和命中统计。
    pub(super) fn prune_to_ids<'a, I>(&mut self, ids: I)
    where
        I: IntoIterator<Item = &'a str>,
    {
        let live = ids.into_iter().collect::<HashSet<_>>();
        let stale = self
            .entries
            .keys()
            .filter(|id| !live.contains(id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        for id in stale {
            if let Some(entry) = self.entries.remove(&id) {
                self.stats.payload_bytes -= entry.bytes;
                self.order.remove(&(entry.touched, id.clone()));
                self.stats.deletions += 1;
            }
        }
        self.recently_evicted
            .retain(|id| live.contains(id.as_str()));
        self.stats.entries = self.entries.len();
    }

    /// 指定 LRU 容量与字节预算的构造入口(字段私有;供测试与基准压缩容量观察逐出)。
    pub fn with_limits(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            max_entries,
            max_bytes,
            ..Default::default()
        }
    }

    pub(super) fn prepare(
        &mut self,
        command: &PathCommand,
        resource: &PathResource,
        resource_path: &str,
        path: &str,
        display_scale: f64,
        paths: &HashMap<&str, (usize, &PathResource)>,
        output: &mut PreparedDeep2d,
    ) -> Result<(), Deep2dPainterIssue> {
        self.tick = self.tick.saturating_add(1);
        let mut style = command.clone();
        style.id = String::new();
        style.z_order = 0;
        style.hit_id = None;
        style.clip_rect = None;
        // 依赖文档必须在本帧任何条目比较之前定格:三个维度各自独立取样,
        // 不随后续 `self.entries` 的借用而变。
        // display_scale 是宿主已定格的整帧物理缩放(见 effective_scale),此处不再二次取样。
        let camera = self.camera_witness(display_scale);
        let document = EntryWitness {
            camera_scale_bits: camera.scale_bits,
            resource_epoch: self.resource_epoch,
        };
        let entry = self.entries.get(&command.id);
        // 命中口径:见证(相机+epoch)一致、风格一致、资源内容一致,且条目侧 clip 对当前帧 paths
        // 内容一致。命令侧 clip 集合变化由 style(保留 clip_path_ids)兜底。
        let clips_intact = entry.is_some_and(|entry| {
            entry.clips.iter().all(|clip| {
                paths
                    .get(clip.id.as_str())
                    .is_some_and(|(_, resource)| same_resource(clip, resource))
            })
        });
        let same = entry.is_some_and(|entry| {
            entry.style == style
                && entry.witness == document
                && same_resource(&entry.resource, resource)
        }) && clips_intact;
        if same {
            let entry = self.entries.get_mut(&command.id).unwrap();
            self.order.remove(&(entry.touched, command.id.clone()));
            entry.touched = self.tick;
            self.stats.hits += 1;
            self.order.insert((entry.touched, command.id.clone()));
            output.vertices.extend_from_slice(&entry.vertices);
            output.summary.path_segments += entry.segments;
            output.summary.fill_triangles += entry.fill_triangles;
            output.summary.stroke_triangles += entry.stroke_triangles;
            return Ok(());
        }
        // 失效原因只记首要原因,判定顺序固定并在此注释化:相机 → epoch → 结构 → clip → resource → 风格。
        // 先说清各维度的作用域:相机/epoch 是帧级依赖(整帧同值),结构/clip/resource/风格是条目级。
        // 帧级维度先判定,因为它们解释「为什么整批条目一起失效」,比条目级差异更接近根因;
        // LRU 逐出优先于一切——id 不在表中时只能靠逐出记忆区分「刚被淘汰」与「首次出现」。
        let reason = match entry {
            None => {
                if self.recently_evicted.remove(command.id.as_str()) {
                    Deep2dPathCacheMissReason::Evicted
                } else {
                    Deep2dPathCacheMissReason::StructureChanged
                }
            }
            Some(entry) => {
                if entry.witness.camera_scale_bits != document.camera_scale_bits {
                    Deep2dPathCacheMissReason::CameraChanged
                } else if entry.witness.resource_epoch != document.resource_epoch {
                    Deep2dPathCacheMissReason::EpochChanged
                } else if !clips_intact || !same_clip_ids(entry, command) {
                    Deep2dPathCacheMissReason::ClipChanged
                } else if !same_resource(&entry.resource, resource) {
                    Deep2dPathCacheMissReason::ResourceChanged
                } else {
                    Deep2dPathCacheMissReason::StyleChanged
                }
            }
        };
        self.stats.misses += 1;
        self.stats.miss_reasons.record(reason);
        let first = output.vertices.len();
        let before = output.summary;
        super::painter_prepare::prepare_path(
            command,
            resource,
            resource_path,
            path,
            // 用见证同源的相机缩放,而非直接把 display_list.scale_factor 传下去:
            // 宿主显式声明的相机必须真正决定细分容差。
            camera.scale,
            paths,
            output,
        )?;
        // 直接收集为拥有所有权的 Vec:临时 Vec<&PathResource> 会在条目构建时再克隆一次。
        let clips = command
            .clip_path_ids
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|id| paths[id.as_str()].1.clone())
            .collect::<Vec<_>>();
        let bytes = (output.vertices.len() - first) * std::mem::size_of::<[f32; 6]>()
            + resource_bytes(resource)
            + clips
                .iter()
                .map(|resource| resource_bytes(resource))
                .sum::<usize>()
            + style.path_id.len()
            + style.dash.as_ref().map_or(0, |values| values.len() * 8)
            + style.clip_path_ids.as_ref().map_or(0, |ids| {
                ids.iter()
                    .map(|id| id.len() + std::mem::size_of::<String>())
                    .sum::<usize>()
            })
            + command.id.len() * 2
            + std::mem::size_of::<Entry>();
        if bytes > self.max_bytes || self.max_entries == 0 {
            return Ok(());
        }
        let entry = Entry {
            style,
            resource: resource.clone(),
            clips,
            witness: document,
            vertices: output.vertices[first..].to_vec(),
            segments: output.summary.path_segments - before.path_segments,
            fill_triangles: output.summary.fill_triangles - before.fill_triangles,
            stroke_triangles: output.summary.stroke_triangles - before.stroke_triangles,
            bytes,
            touched: self.tick,
        };
        self.store(command.id.clone(), entry);
        Ok(())
    }

    fn store(&mut self, id: String, entry: Entry) {
        if let Some(old) = self.entries.remove(&id) {
            self.stats.payload_bytes -= old.bytes;
            self.order.remove(&(old.touched, id.clone()));
        }
        while self.entries.len() >= self.max_entries
            || self.stats.payload_bytes + entry.bytes > self.max_bytes
        {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            let old = self.entries.remove(&oldest).unwrap();
            self.stats.payload_bytes -= old.bytes;
            self.stats.evictions += 1;
            self.remember_evicted(oldest);
        }
        self.stats.payload_bytes += entry.bytes;
        self.order.insert((entry.touched, id.clone()));
        self.recently_evicted.remove(&id);
        self.entries.insert(id, entry);
        self.stats.entries = self.entries.len();
    }

    // 同 id 重存(覆盖)不算逐出,只有上面的 LRU 循环才记入逐出记忆。
    fn remember_evicted(&mut self, id: String) {
        if self.recently_evicted.len() >= self.max_entries.max(MIN_EVICTED_MEMORY) {
            self.recently_evicted.clear();
        }
        self.recently_evicted.insert(id);
    }
}

// 命令侧 clip 集合是否与条目存储时一致;条目 clips 由 store 时的 clip_path_ids 顺序解析而来。
fn same_clip_ids(entry: &Entry, command: &PathCommand) -> bool {
    let current = command.clip_path_ids.as_deref().unwrap_or(&[]);
    entry.clips.len() == current.len()
        && entry
            .clips
            .iter()
            .zip(current)
            .all(|(clip, id)| clip.id == *id)
}

fn same_resource(a: &PathResource, b: &PathResource) -> bool {
    a.id == b.id && a.verbs == b.verbs
}
fn resource_bytes(resource: &PathResource) -> usize {
    std::mem::size_of::<PathResource>()
        + resource.id.len()
        + resource.verbs.len() * std::mem::size_of::<Deep2dPathVerb>()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entry_and_payload_limits_evict_without_changing_geometry() {
        let list = crate::deep2d::decode_display_list(include_bytes!(
            "../../fixtures/deep2d_tessellated_v1.json"
        ))
        .unwrap();
        let expected = crate::deep2d::prepare_display_list(&list).unwrap();
        let mut cache = Deep2dPathCache {
            max_entries: 1,
            ..Default::default()
        };
        assert_eq!(
            crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap(),
            expected
        );
        assert_eq!(cache.stats().entries, 1);
        assert_eq!(cache.stats().evictions, 2);
        assert!(cache.stats().payload_bytes <= cache.max_bytes);
        let mut tiny = Deep2dPathCache {
            max_bytes: 1,
            ..Default::default()
        };
        assert_eq!(
            crate::deep2d::prepare_display_list_cached(&list, &mut tiny).unwrap(),
            expected
        );
        assert_eq!(tiny.stats().entries, 0);
        assert_eq!(tiny.stats().payload_bytes, 0);
    }

    #[test]
    fn touching_entries_updates_lru_without_unbounded_bookkeeping() {
        let all = crate::deep2d::decode_display_list(include_bytes!(
            "../../fixtures/deep2d_tessellated_v1.json"
        ))
        .unwrap();
        let mut list = all.clone();
        list.commands.truncate(2);
        let mut cache = Deep2dPathCache {
            max_entries: 2,
            ..Default::default()
        };
        crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap();
        list.commands.truncate(1);
        for _ in 0..100 {
            crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap();
        }
        assert_eq!(cache.entries.len(), cache.order.len());
        list.commands = vec![all.commands[2].clone()];
        crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap();
        assert!(!cache.entries.contains_key("draw:panel"));
        assert!(cache.entries.contains_key("draw:curve"));
        assert!(!cache.entries.contains_key("draw:status"));
        // status 在前一帧已清理，插入 curve 不触发容量逐出。
        assert_eq!(cache.stats().evictions, 0);
    }

    #[test]
    fn clipped_entry_stores_with_owned_clips_and_hits_with_current_metadata() {
        let mut list = crate::deep2d::decode_display_list(include_bytes!(
            "../../fixtures/deep2d_tessellated_v1.json"
        ))
        .unwrap();
        let crate::deep2d::Deep2dCommand::Path(command) = &mut list.commands[0] else {
            unreachable!()
        };
        command.clip_path_ids = Some(vec!["overlay:status".into()]);
        let mut cache = Deep2dPathCache {
            max_entries: 8,
            ..Default::default()
        };
        crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap();
        assert_eq!(cache.stats().misses, 3);
        list.revision += 1;
        let crate::deep2d::Deep2dCommand::Path(command) = &mut list.commands[0] else {
            unreachable!()
        };
        command.z_order = 7;
        command.hit_id = Some("hit".into());
        let expected = crate::deep2d::prepare_display_list(&list).unwrap();
        assert_eq!(
            crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap(),
            expected
        );
        assert_eq!(cache.stats().hits, 3);
    }

    // ---- P1-02 第二批:epoch / 相机依赖维度 ----

    fn fixture() -> crate::deep2d::Deep2dDisplayList {
        crate::deep2d::decode_display_list(include_bytes!(
            "../../fixtures/deep2d_tessellated_v1.json"
        ))
        .unwrap()
    }
    fn cached(
        list: &crate::deep2d::Deep2dDisplayList,
        cache: &mut Deep2dPathCache,
    ) -> crate::deep2d::PreparedDeep2d {
        crate::deep2d::prepare_display_list_cached(list, cache).expect("prepare")
    }

    /// 宿主显式相机声明必须同时决定「见证」与「细分缩放」:两者同源是硬约束。
    /// 若见证用显式值而细分仍用 display_list.scaleFactor,就会产生
    /// 「见证记 2.0 而几何按 1.0 细分」的条目,后续帧将永久命中错误几何。
    #[test]
    fn explicit_camera_declaration_drives_both_witness_and_tessellation() {
        let list = fixture();
        let mut explicit = Deep2dPathCache::default();
        explicit.set_camera_scale(2.0);
        let by_explicit = cached(&list, &mut explicit);

        let mut plain = list.clone();
        plain.scale_factor = 2.0;
        let by_static = crate::deep2d::prepare_display_list(&plain).unwrap();
        assert_eq!(
            by_explicit, by_static,
            "显式相机缩放与等价 scaleFactor 的单帧产物必须逐值一致"
        );

        // 静态字段仍为 1.0 的这一帧,几何不得退化成 1.0 的结果。
        let mut at_one = Deep2dPathCache::default();
        let one = cached(&list, &mut at_one);
        assert_ne!(
            by_explicit, one,
            "2.0 相机下的几何必须与 1.0 不同(否则本条断言不成立)"
        );
    }

    #[test]
    fn camera_scale_dependency_invalidates_once_and_rebuilds_exact_geometry() {
        let list = fixture();
        let mut cache = Deep2dPathCache::default();
        let at_one = cached(&list, &mut cache);
        assert_eq!(cache.stats().misses, 3, "冷启动 3 条路径首次细分");

        cache.set_camera_scale(2.0);
        let at_two = cached(&list, &mut cache);
        let reasons = cache.stats().miss_reasons;
        assert_eq!(reasons.camera_changed, 3, "整批条目按相机维度失效");
        assert_eq!(cache.stats().misses, 6);
        assert_eq!(reasons.total(), 6, "total() 恒等于 misses");
        // 相机见证优先于显示列表自带 scaleFactor:这就是「宿主声明取代静态字段」的语义。
        let mut plain = list.clone();
        plain.scale_factor = 2.0;
        assert_eq!(
            at_two,
            crate::deep2d::prepare_display_list(&plain).unwrap(),
            "显式相机见证与等价 scaleFactor 的静态帧必须产出同一几何"
        );
        assert_ne!(
            at_one, at_two,
            "不同物理缩放的细分产物必须不同(否则本条断言无意义)"
        );

        // 同一相机见证重复准备:全部命中,不得重复计失效。
        let again = cached(&list, &mut cache);
        assert_eq!(again, at_two);
        assert_eq!(cache.stats().hits, 3);
        assert_eq!(
            cache.stats().miss_reasons.camera_changed,
            3,
            "幂等帧不新增相机失效"
        );

        // 相机往返:回到 1.0 再次失效一次,且产物与首次逐值一致——依赖换代不累积漂移。
        cache.set_camera_scale(1.0);
        let back = cached(&list, &mut cache);
        assert_eq!(back, at_one, "相机往返后几何与首次一致");
        assert_eq!(cache.stats().miss_reasons.camera_changed, 6);
    }

    /// epoch 维度:换包换代按 epoch_changed 记账,同代重复声明是空操作。
    #[test]
    fn resource_epoch_dependency_is_recorded_and_idempotent() {
        let list = fixture();
        let mut cache = Deep2dPathCache::default();
        cache.set_resource_epoch(1);
        cached(&list, &mut cache);
        assert_eq!(cache.stats().misses, 3);
        assert_eq!(
            cache.stats().miss_reasons.epoch_changed,
            0,
            "首次出现属结构维度,不是换代"
        );

        cached(&list, &mut cache);
        assert_eq!(cache.stats().miss_reasons.epoch_changed, 0, "同代不失效");
        assert_eq!(cache.stats().hits, 3, "同代重复准备全命中");

        cache.set_resource_epoch(2);
        cached(&list, &mut cache);
        assert_eq!(
            cache.stats().miss_reasons.epoch_changed,
            3,
            "整批条目按 epoch 维度失效"
        );
        assert_eq!(
            cache.stats().miss_reasons.camera_changed,
            0,
            "相机未变不抢占归因"
        );
        assert_eq!(cache.stats().misses, 6);

        cached(&list, &mut cache);
        assert_eq!(cache.stats().hits, 6, "换代后恢复命中");
        assert_eq!(cache.stats().misses, 6, "换代只收一次失效账");
        assert_eq!(cache.stats().miss_reasons.total(), cache.stats().misses);
    }

    /// 依赖图的边界:数据 revision 与 z 序/命中 id 刻意不进图——它们不改细分几何,
    /// 进图只会制造假失效。这与 P1-01「data_revision 不参与几何缓存」的口径一致。
    #[test]
    fn data_revision_and_presentation_metadata_stay_out_of_the_dependency_graph() {
        let mut list = fixture();
        let mut cache = Deep2dPathCache::default();
        cached(&list, &mut cache);
        let before = cache.stats();

        list.revision += 7;
        list.commands.reverse();
        for command in &mut list.commands {
            if let crate::deep2d::Deep2dCommand::Path(path) = command {
                path.z_order += 5;
                path.hit_id = Some("late:rename".into());
            }
        }
        let after = cached(&list, &mut cache);
        assert_eq!(
            cache.stats().misses,
            before.misses,
            "改数据/呈现元数据不得触发重细分"
        );
        assert_eq!(cache.stats().hits, before.hits + 3);
        assert_eq!(
            after,
            crate::deep2d::prepare_display_list(&list).unwrap(),
            "命中路径仍产出正确字节"
        );
    }

    /// 归因优先级:相机与 epoch 同时变化时只记相机(第一个命中的维度),不双计。
    #[test]
    fn frame_level_dimensions_attribute_only_the_first_change() {
        let list = fixture();
        let mut cache = Deep2dPathCache::default();
        cache.set_resource_epoch(1);
        cached(&list, &mut cache);

        cache.set_resource_epoch(2);
        cache.set_camera_scale(3.0);
        cached(&list, &mut cache);
        let reasons = cache.stats().miss_reasons;
        assert_eq!(reasons.camera_changed, 3, "相机先判定");
        assert_eq!(reasons.epoch_changed, 0, "一次 miss 只归入首个维度");
        assert_eq!(reasons.total(), cache.stats().misses);
    }

    /// 布线边界:未声明相机时退回显示列表 scale_factor,行为与第一批逐字节一致。
    #[test]
    fn unset_camera_witness_falls_back_to_display_list_scale() {
        let mut list = fixture();
        let mut cache = Deep2dPathCache::default();
        cached(&list, &mut cache);
        list.scale_factor = 1.5;
        cached(&list, &mut cache);
        assert_eq!(
            cache.stats().miss_reasons.camera_changed,
            3,
            "回退见证仍能辨识缩放变化"
        );

        // 非有限缩放不得写入见证,退化为「无相机判定」而非伪造失效。
        list.scale_factor = 1.0;
        let mut cache = Deep2dPathCache::default();
        cache.set_camera_scale(f64::NAN);
        cached(&list, &mut cache);
        cached(&list, &mut cache);
        assert_eq!(cache.stats().hits, 3, "NaN 相机见证不制造失效");
        assert_eq!(cache.stats().miss_reasons.camera_changed, 0);
    }

    /// 换代与结构变化叠加时:joins 结构判定优先于 epoch(条目已不存在,只能按结构/逐出归因)。
    #[test]
    fn structural_change_outranks_epoch_for_absent_entries() {
        let mut list = fixture();
        list.commands.truncate(2);
        let mut cache = Deep2dPathCache::default();
        cache.set_resource_epoch(1);
        cached(&list, &mut cache);
        assert_eq!(cache.stats().misses, 2, "两条路径首次出现");

        let fresh = fixture();
        cache.set_resource_epoch(2);
        cached(&fresh, &mut cache);
        let reasons = cache.stats().miss_reasons;
        // 计数是累积的:第 1 帧的两次「首次出现」也计入 structure_changed,
        // 第 2 帧只新增一条(draw:curve 在本帧首次出现)。
        assert_eq!(
            reasons.structure_changed, 3,
            "首帧 2 次首次出现 + 本帧新增 1 条"
        );
        assert_eq!(reasons.epoch_changed, 2, "既有两条按 epoch 换代");
        assert_eq!(cache.stats().misses, 5);
        assert_eq!(cache.stats().hits, 0, "本帧无一条命中");
        assert_eq!(cache.stats().miss_reasons.total(), cache.stats().misses);

        // 第 3 帧:同代同结构,必须全命中——证明换代的失效是一次性的。
        cached(&fresh, &mut cache);
        assert_eq!(cache.stats().hits, 3, "换代后再无失效");
        assert_eq!(cache.stats().misses, 5);
    }
}
