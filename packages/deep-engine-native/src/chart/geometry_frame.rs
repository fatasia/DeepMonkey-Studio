//! 同一不可变系列快照拥有绘制、命中几何和原始线数据点。
use super::geometry_series::{SeriesDependencies, SeriesGeometry};
use super::{ChartIR, InteractionState, render_chart_with_windows, validate_chart_ir};
use crate::deep2d::{
    DEEP_2D_DISPLAY_LIST_BUDGETS, Deep2dCommand, Deep2dDisplayList, Deep2dResource,
    validate_display_list,
};
use std::{sync::Arc, sync::OnceLock};
#[cfg(test)]
#[path = "frame_chunks_tests.rs"]
mod chunk_tests;
#[cfg(test)]
#[path = "geometry_incremental_tests.rs"]
mod incremental_tests;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartHitTarget {
    pub series_id: String,
    pub data_index: Option<usize>,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChartGeometryWork {
    pub series_rebuilt: usize,
    pub series_reused: usize,
    pub hit_indexes_rebuilt: usize,
    pub line_indexes_rebuilt: usize,
}
/// 一个可见系列的帧切片:命中几何与命令/资源存储都以 Arc 持有,
/// 增量更新复用系列时只克隆句柄,不复制命令内存。
#[derive(Clone)]
struct Chunk {
    geometry: Arc<SeriesGeometry>,
    commands: Arc<Vec<Deep2dCommand>>,
    resources: Arc<Vec<Deep2dResource>>,
    rebuilt: bool,
}
/// 命中/绘制帧。扁平 Deep2dDisplayList 是惰性物化的视图:构建与增量更新按
/// 系列 chunk 进行(O(块));首次 `display_list()` 时一次性拼出扁平列表并缓存。
/// chunk 集合在帧进入运行时后冻结,视图只需构建一次、永不失效重建。
#[derive(Clone)]
pub struct ChartGeometryFrame {
    header: Deep2dDisplayList,
    revision: u64,
    chunks: Vec<Chunk>,
    work: ChartGeometryWork,
    flat: OnceLock<Deep2dDisplayList>,
}
#[path = "geometry_frame_pick.rs"]
mod pick;

impl ChartGeometryFrame {
    /// 提交前写入帧版本。只能在帧尚无任何共享引用时调用(运行时在
    /// `Arc::new` 之前调用),因此此刻惰性视图必然未物化,版本随首次
    /// `display_list()` 一次性生效。
    pub(super) fn set_revision(&mut self, revision: u64) {
        self.revision = revision;
    }
    pub fn prepare(
        ir: &ChartIR,
        state: &InteractionState,
        width: f64,
        height: f64,
    ) -> Result<Self, String> {
        Self::prepare_incremental(ir, state, width, height, None, &[])
    }
    /// dirty数据集由运行时事务给出；全源替换必须调用prepare，不能继承旧依赖。
    pub(super) fn prepare_incremental(
        ir: &ChartIR,
        state: &InteractionState,
        width: f64,
        height: f64,
        previous: Option<&Self>,
        dirty_datasets: &[String],
    ) -> Result<Self, String> {
        let validation = validate_chart_ir(ir);
        if !validation.valid {
            return Err(format!("invalid chart: {validation:?}"));
        }
        if state
            .hidden_series
            .iter()
            .any(|id| !ir.series.iter().any(|series| &series.id == id))
        {
            return Err("chart hidden series does not exist".into());
        }
        let plot = super::layout::layout_chart(ir, width, height)?.plot;
        let all_hidden = ir
            .series
            .iter()
            .map(|series| series.id.clone())
            .collect::<Vec<_>>();
        // 复用全图入口对窗口和画布的检查,只取帧头;命令与资源由各系列 chunk 提供。
        let header =
            render_chart_with_windows(ir, width, height, &all_hidden, &state.zoom_windows)?;
        let mut chunks = Vec::new();
        let mut work = ChartGeometryWork::default();
        for series in &ir.series {
            if state.hidden_series.contains(&series.id) {
                continue;
            }
            let dependencies = SeriesDependencies::new(ir, series, state, [width, height], plot);
            let old = previous.and_then(|frame| {
                frame
                    .chunks
                    .iter()
                    .find(|chunk| chunk.geometry.id == series.id)
            });
            let reusable = !dirty_datasets.contains(&series.dataset_id)
                && old.is_some_and(|chunk| chunk.geometry.dependencies == dependencies);
            let (geometry, commands, resources, rebuilt) = if reusable {
                work.series_reused += 1;
                let old = old.unwrap();
                // 复用系列零复制:三个 Arc 句柄克隆 O(块),命令内存与旧帧共享。
                (
                    old.geometry.clone(),
                    old.commands.clone(),
                    old.resources.clone(),
                    false,
                )
            } else {
                let (geometry, local) =
                    SeriesGeometry::prepare(ir, series, state, [width, height], dependencies)?;
                work.series_rebuilt += 1;
                work.hit_indexes_rebuilt += 1;
                work.line_indexes_rebuilt += usize::from(geometry.points.is_some());
                if local
                    .commands
                    .iter()
                    .any(|command| !matches!(command, Deep2dCommand::Path(_)))
                {
                    return Err("chart expected path command".into());
                }
                (
                    Arc::new(geometry),
                    Arc::new(local.commands),
                    Arc::new(local.resources),
                    true,
                )
            };
            chunks.push(Chunk {
                geometry,
                commands,
                resources,
                rebuilt,
            });
        }
        let commands_total = chunks
            .iter()
            .map(|chunk| chunk.commands.len())
            .sum::<usize>();
        let resources_total = chunks
            .iter()
            .map(|chunk| chunk.resources.len())
            .sum::<usize>();
        // 组装预算与旧的全列表校验同源:同一时机以纯计数失败,不做全量拼接。
        if resources_total > DEEP_2D_DISPLAY_LIST_BUDGETS.resources
            || commands_total > DEEP_2D_DISPLAY_LIST_BUDGETS.commands
        {
            return Err("chart frame assembly: deep2d budgets exceeded".into());
        }
        Ok(Self {
            header,
            revision: 0,
            chunks,
            work,
            flat: OnceLock::new(),
        })
    }
    pub fn work(&self) -> ChartGeometryWork {
        self.work
    }
    /// 扁平显示列表:首次访问时把各系列 chunk 拼接为一份并缓存,之后共享同一份。
    /// z 序与重建系列的资源版本在此定版,与旧实现的拼接期重编号逐值一致。
    pub fn display_list(&self) -> &Deep2dDisplayList {
        self.flat.get_or_init(|| self.build_flat())
    }
    fn build_flat(&self) -> Deep2dDisplayList {
        let commands_total = self.chunks.iter().map(|chunk| chunk.commands.len()).sum();
        let resources_total = self.chunks.iter().map(|chunk| chunk.resources.len()).sum();
        let mut resources = Vec::with_capacity(resources_total);
        let mut commands = Vec::with_capacity(commands_total);
        for chunk in &self.chunks {
            let resource_start = resources.len();
            resources.extend(chunk.resources.iter().cloned());
            if chunk.rebuilt {
                for resource in &mut resources[resource_start..] {
                    if let Deep2dResource::Path(path) = resource {
                        path.revision = self.revision;
                    }
                }
            }
            for command in chunk.commands.iter() {
                let mut command = command.clone();
                if let Deep2dCommand::Path(mut path) = command {
                    path.z_order = commands.len() as i32;
                    command = Deep2dCommand::Path(path);
                }
                commands.push(command);
            }
        }
        let list = Deep2dDisplayList {
            schema_version: self.header.schema_version,
            id: self.header.id.clone(),
            revision: self.revision,
            logical_width: self.header.logical_width,
            logical_height: self.header.logical_height,
            scale_factor: self.header.scale_factor,
            resources,
            commands,
            atlases: self.header.atlases.clone(),
        };
        // 自检:每个 chunk 都来自已通过 deep2d 校验的单系列渲染输出,预算已
        // 在 prepare 计数,装配失败是实现 bug 而非数据失败。
        let validation = validate_display_list(&list);
        assert!(
            validation.valid,
            "chart frame assembly: {:?}",
            validation.issues
        );
        list
    }
    pub fn command_target(&self, index: usize) -> Option<&ChartHitTarget> {
        // 尾部累加前缀:与旧实现的 command_offset 查找同语义(含空 chunk 与
        // index==总数 时返回 None)。
        let mut end = self
            .chunks
            .iter()
            .map(|chunk| chunk.commands.len())
            .sum::<usize>();
        for chunk in self.chunks.iter().rev() {
            let start = end - chunk.commands.len();
            if start <= index {
                return chunk.geometry.targets.get(index - start);
            }
            end = start;
        }
        None
    }
}
