//! 按当前依赖准备几何并在成功细分后更新缓存;刀 3 起按滑窗变更计数把
//! 动态路径自动分路到 stencil-then-cover(见 `painter_dynamic`)。
use super::super::painter::{PathPrepareFrame, PathPrepareRoute};
use super::super::{Deep2dPainterIssue, PreparedDeep2d};
use super::super::paint_data::Deep2dPaintData;
use super::super::paint_registry::PaintRegistry;
use super::super::painter_dynamic::{
    MAX_DYNAMIC_FILL_EDGES_TOTAL, VERTICES_PER_EDGE, cover_vertices, dynamic_fence,
    dynamic_fill_rule, resource_content_hash, stencil_eligible,
};
use super::super::painter_path::LinearPath;
use super::super::painter_prepare::{emit_stroke, prepare_path, register_fill_paint};
use super::keys::{resource_bytes, same_clip_ids, same_resource};
use super::{
    Deep2dPathCache, Deep2dPathCacheMissReason, Entry, EntryWitness, PathCommand, PathResource,
};

/// 失效原因只记首要原因,判定顺序固定并在此注释化:相机 → epoch → 结构 → clip → resource → 风格。
/// 先说清各维度的作用域:相机/epoch 是帧级依赖(整帧同值),结构/clip/resource/风格是条目级。
/// 帧级维度先判定,因为它们解释「为什么整批条目一起失效」,比条目级差异更接近根因;
/// LRU 逐出优先于一切——id 不在表中时只能靠逐出记忆区分「刚被淘汰」与「首次出现」。
fn miss_reason(
    entry: Option<&Entry>,
    document: EntryWitness,
    clips_intact: bool,
    command: &PathCommand,
    resource: &PathResource,
    recently_evicted: bool,
) -> Deep2dPathCacheMissReason {
    match entry {
        None => {
            if recently_evicted {
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
    }
}

impl Deep2dPathCache {
    #[allow(clippy::too_many_arguments)]
    pub(in super::super) fn prepare(
        &mut self,
        command: &PathCommand,
        resource: &PathResource,
        resource_path: &str,
        path: &str,
        frame: &PathPrepareFrame<'_>,
        registry: &mut PaintRegistry,
        output: &mut PreparedDeep2d,
    ) -> Result<PathPrepareRoute, Deep2dPainterIssue> {
        let display_scale = frame.scale_factor;
        let paths = frame.paths;
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
        // 刀 3:动态性观察——每帧每命令推进滑窗(内容指纹),达到阈值自动分路。
        let dynamic = self.dynamic.observe(&command.id, resource_content_hash(resource));
        if dynamic && stencil_eligible(command) {
            // 动态帧记账:条目几何不再消费;内容/见证未变记 hit,内容变化记
            // 首要原因(与静态同一套词表,条目原地保留以便退静态时正确归因)。
            let recently_evicted = if entry.is_none() {
                self.recently_evicted.remove(command.id.as_str())
            } else {
                false
            };
            if same {
                self.stats.hits += 1;
            } else {
                self.stats.misses += 1;
                self.stats
                    .miss_reasons
                    .record(miss_reason(entry, document, clips_intact, command, resource, recently_evicted));
            }
            return self.emit_dynamic(
                command,
                resource,
                resource_path,
                path,
                frame,
                registry,
                output,
                camera.scale,
                paths,
            );
        }
        if dynamic {
            // 判为动态但不满足 stencil 资格(多边形剪刀/解析 quad/无 fill):
            // 该帧回落静态 CPU 细分,计数上报,不静默。
            output.summary.dynamic_fallbacks += 1;
        }
        if same {
            let entry = self.entries.get_mut(&command.id).unwrap();
            self.order.remove(&(entry.touched, command.id.clone()));
            entry.touched = self.tick;
            self.stats.hits += 1;
            self.order.insert((entry.touched, command.id.clone()));
            let first = output.vertices.len();
            output.vertices.extend_from_slice(&entry.vertices);
            // 渐变/圆角顶点引用存储槽:按本帧注册表重登记并回填槽号,
            // 保证缓存命中在任何 paint 组合下都与现算逐字节一致。
            if !entry.paints.is_empty() {
                let slots = registry
                    .register_all(&entry.paints)
                    .map_err(|issue| Deep2dPainterIssue {
                        code: issue.code,
                        path: format!("{path}.paints"),
                        message: issue.message,
                    })?;
                for vertex in &mut output.vertices[first..] {
                    let old = vertex[8] as usize;
                    if old > 0 {
                        vertex[8] = slots[old - 1] as f32;
                    }
                }
            }
            output.summary.path_segments += entry.segments;
            output.summary.fill_triangles += entry.fill_triangles;
            output.summary.stroke_triangles += entry.stroke_triangles;
            return Ok(PathPrepareRoute::Static);
        }
        self.stats.misses += 1;
        let recently_evicted = entry.is_none() && self.recently_evicted.remove(command.id.as_str());
        self.stats
            .miss_reasons
            .record(miss_reason(entry, document, clips_intact, command, resource, recently_evicted));
        self.prepare_static(
            command,
            resource,
            resource_path,
            path,
            registry,
            output,
            camera.scale,
            paths,
            &style,
            document,
        )?;
        Ok(PathPrepareRoute::Static)
    }

    /// 静态路由:CPU 细分 + 条目存储(命中返回后不会走到这里)。
    /// 动态候选的预算回落也走这条,保证回落帧与从未判动态的帧逐字节一致。
    #[allow(clippy::too_many_arguments)]
    fn prepare_static(
        &mut self,
        command: &PathCommand,
        resource: &PathResource,
        resource_path: &str,
        path: &str,
        registry: &mut PaintRegistry,
        output: &mut PreparedDeep2d,
        scale: f64,
        paths: &std::collections::HashMap<&str, (usize, &PathResource)>,
        style: &PathCommand,
        document: EntryWitness,
    ) -> Result<(), Deep2dPainterIssue> {
        let first = output.vertices.len();
        let before = output.summary;
        prepare_path(
            command,
            resource,
            resource_path,
            path,
            // 用见证同源的相机缩放,而非直接把 display_list.scale_factor 传下去:
            // 宿主显式声明的相机必须真正决定细分容差。
            scale,
            paths,
            registry,
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
        // 条目自包含:扫描本条目新顶点引用的全局槽,拷贝内容并重编号为
        // 条目局部槽(1..n)。跨命令去重可能让顶点引用早于 paints_before 的
        // 槽,直接快照窗口会漏掉它们——必须以顶点引用为准。
        // quad 条目的 fill_index 是嵌套引用(顶点不直接引用渐变槽),
        // 捕获必须跟随,否则暖帧回填后 fill_index 指到错误条目。
        let mut remap: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
        let mut entry_paints: Vec<Deep2dPaintData> = Vec::new();
        // 条目顶点存条目局部槽(副本上重映射);输出顶点保持帧槽不变,
        // 否则本帧渲染就会读到错误的存储条目。
        let entry_vertices = output.vertices[first..]
            .iter()
            .map(|vertex| {
                let mut copied = *vertex;
                let slot = copied[8] as u32;
                if slot != 0 {
                    copied[8] = capture_paint(registry, slot, &mut remap, &mut entry_paints) as f32;
                }
                copied
            })
            .collect::<Vec<_>>();
        let bytes = (output.vertices.len() - first) * std::mem::size_of::<[f32; 9]>()
            + entry_paints.len() * std::mem::size_of::<Deep2dPaintData>()
            + resource_bytes(resource)
            + clips.iter().map(resource_bytes).sum::<usize>()
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
            style: style.clone(),
            resource: resource.clone(),
            clips,
            witness: document,
            vertices: entry_vertices,
            paints: entry_paints,
            segments: output.summary.path_segments - before.path_segments,
            fill_triangles: output.summary.fill_triangles - before.fill_triangles,
            stroke_triangles: output.summary.stroke_triangles - before.stroke_triangles,
            bytes,
            touched: self.tick,
        };
        self.store(command.id.clone(), entry);
        Ok(())
    }

    /// 刀 3 动态路由:展平(仅线性化)+ fence 发射 + cover 顶点;描边部分
    /// 如实保留 CPU 展开。预算超限整条回落静态(fail-safe,计数上报)。
    #[allow(clippy::too_many_arguments)]
    fn emit_dynamic(
        &mut self,
        command: &PathCommand,
        resource: &PathResource,
        resource_path: &str,
        path: &str,
        frame: &PathPrepareFrame<'_>,
        registry: &mut PaintRegistry,
        output: &mut PreparedDeep2d,
        scale: f64,
        paths: &std::collections::HashMap<&str, (usize, &PathResource)>,
    ) -> Result<PathPrepareRoute, Deep2dPainterIssue> {
        let linear = LinearPath::from_resource(resource, resource_path, path, command.transform, scale)?;
        // 预算判定先于任何登记:回落帧必须与从未判动态的帧逐字节一致
        // (segments/paints 记账都留给静态路完成)。
        let fence = dynamic_fence(&linear, &command.transform).filter(|fence| {
            output.dynamic_edges.len() / VERTICES_PER_EDGE + fence.edge_count
                <= MAX_DYNAMIC_FILL_EDGES_TOTAL
        });
        let Some(fence) = fence else {
            output.summary.dynamic_fallbacks += 1;
            return self.static_after_dynamic(
                command, resource, resource_path, path, frame, registry, output, scale, paths,
            );
        };
        output.summary.path_segments += linear.segment_count();
        output.summary.dynamic_edges += fence.edge_count;
        let opacity = command.opacity.unwrap_or(1.0) as f32;
        let fill = command.fill.as_ref().expect("stencil eligibility checked");
        let (slot, vertex_color) = register_fill_paint(command, fill, scale, registry, path)?;
        let edge_first = output.dynamic_edges.len() as u32;
        output.dynamic_edges.extend_from_slice(&fence.edges);
        let cover_first = output.vertices.len() as u32;
        let rgba = [
            vertex_color[0] as f32,
            vertex_color[1] as f32,
            vertex_color[2] as f32,
            vertex_color[3] as f32 * opacity,
        ];
        output
            .vertices
            .extend(cover_vertices(fence.bbox, &command.transform, rgba, slot));
        let cover_count = output.vertices.len() as u32 - cover_first;
        // 描边不在本刀范围:动态命令的 stroke 继续 CPU 展开,并追加静态
        // chunk 保证被绘制(与静态帧同一管线/同一顶点流)。
        let stroke_first = output.vertices.len() as u32;
        let stroke = if command.stroke.is_some() {
            let clip_sets = super::super::painter_clip::prepare_clip_sets(
                command.clip_path_ids.as_deref(),
                paths,
                command.transform,
                scale,
                path,
            )?;
            emit_stroke(command, &linear, &clip_sets, scale, output, path)?;
            Some((stroke_first, output.vertices.len() as u32 - stroke_first))
        } else {
            None
        };
        Ok(PathPrepareRoute::Dynamic(super::super::painter::DynamicEmission {
            cover_first,
            cover_count,
            edge_first,
            edge_count: fence.edges.len() as u32,
            fill_rule: dynamic_fill_rule(command),
            stroke,
        }))
    }

    /// 动态候选的静态回落:与从未判动态的帧走完全相同的静态路
    /// (细分 + 条目存储),仅多计一次 dynamic_fallbacks。
    #[allow(clippy::too_many_arguments)]
    fn static_after_dynamic(
        &mut self,
        command: &PathCommand,
        resource: &PathResource,
        resource_path: &str,
        path: &str,
        frame: &PathPrepareFrame<'_>,
        registry: &mut PaintRegistry,
        output: &mut PreparedDeep2d,
        scale: f64,
        paths: &std::collections::HashMap<&str, (usize, &PathResource)>,
    ) -> Result<PathPrepareRoute, Deep2dPainterIssue> {
        let mut style = command.clone();
        style.id = String::new();
        style.z_order = 0;
        style.hit_id = None;
        style.clip_rect = None;
        let camera = self.camera_witness(frame.scale_factor);
        let document = EntryWitness {
            camera_scale_bits: camera.scale_bits,
            resource_epoch: self.resource_epoch,
        };
        self.prepare_static(
            command,
            resource,
            resource_path,
            path,
            registry,
            output,
            scale,
            paths,
            &style,
            document,
        )?;
        Ok(PathPrepareRoute::Static)
    }
}

/// Recursively captures a paint slot into the entry-local list, following the
/// quad `fill_index` chain (quads reference their gradient fill indirectly).
/// The placeholder insert doubles as a cycle guard; quads never reference
/// quads, so the chain is at most one level deep.
fn capture_paint(
    registry: &super::super::paint_registry::PaintRegistry,
    slot: u32,
    remap: &mut std::collections::HashMap<u32, u32>,
    entry_paints: &mut Vec<Deep2dPaintData>,
) -> u32 {
    if slot == 0 {
        return 0;
    }
    if let Some(local) = remap.get(&slot) {
        return *local;
    }
    let paint = *registry
        .paint_at(slot)
        .expect("referenced slot is registered");
    let local = entry_paints.len() as u32 + 1;
    remap.insert(slot, local);
    entry_paints.push(paint);
    if paint.kind == super::super::paint_data::DEEP2D_PAINT_KIND_QUAD && paint.fill_index != 0 {
        let fill_local = capture_paint(registry, paint.fill_index, remap, entry_paints);
        entry_paints[(local - 1) as usize].fill_index = fill_local;
    }
    local
}
