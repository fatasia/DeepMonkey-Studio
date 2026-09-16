//! 顶点传输计数与退化原因判定。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VertexTransferStats {
    pub uploaded_bytes: usize,
    pub copied_bytes: usize,
    pub reused_bytes: usize,
    pub copy_regions: usize,
    pub upload_regions: usize,
    pub shadow_bytes: usize,
    /// 本次候选的 GPU 缓冲分配次数:0=整内容命中复用,1=新分配。
    /// 缓冲发布后不可变(旧帧只读的前提),因此每 stage 至多一次分配。
    pub buffer_allocations: usize,
    /// 未走增量复制的首要原因。计数是累积口径,与路径缓存的 miss 账分属两层:
    /// 缓存账回答「细分为什么重算」,本账回答「顶点为什么重传」。
    /// 二者交叉才能区分「几何没变但传输退化了」与「几何确实变了」。
    pub reasons: super::VertexTransferReasons,
}

/// 顶点传输的路径归因。判定顺序固定,与 buffer_allocations 的 0/1 事实一致。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct VertexTransferReasons {
    /// 内容寻址命中:整个缓冲逐字节复用,零传输零分配。
    pub content_reused: u64,
    /// 增量复制:命中前帧区域,只上传新增片段。
    pub incremental_copies: u64,
    /// 冷启动:没有前帧缓冲可对照。
    pub no_previous_frame: u64,
    /// 前帧缓冲不可作复制源(缺 COPY_SRC),只能整块上传。
    pub previous_not_copyable: u64,
    /// 有前帧但无法建立区域对照:超区域/字节上限或顶点不连续。
    pub plan_rejected: u64,
    /// 可复制但未达阈值(碎片多或小缓冲),整块上传更划算。
    pub below_copy_threshold: u64,
}

impl VertexTransferReasons {
    pub(super) fn record(&mut self, reason: VertexTransferReason) {
        match reason {
            VertexTransferReason::ContentReused => self.content_reused += 1,
            VertexTransferReason::IncrementalCopies => self.incremental_copies += 1,
            VertexTransferReason::NoPreviousFrame => self.no_previous_frame += 1,
            VertexTransferReason::PreviousNotCopyable => self.previous_not_copyable += 1,
            VertexTransferReason::PlanRejected => self.plan_rejected += 1,
            VertexTransferReason::BelowCopyThreshold => self.below_copy_threshold += 1,
        }
    }
    /// 每次 upload 恰好记一条原因,因此恒等于 stage 次数。
    pub fn total(&self) -> u64 {
        self.content_reused
            + self.incremental_copies
            + self.no_previous_frame
            + self.previous_not_copyable
            + self.plan_rejected
            + self.below_copy_threshold
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum VertexTransferReason {
    ContentReused,
    IncrementalCopies,
    NoPreviousFrame,
    PreviousNotCopyable,
    PlanRejected,
    BelowCopyThreshold,
}

/// 整块上传路径的归因判定(纯函数,便于锁定判定顺序而不依赖真实 GPU)。
/// 入参语义:`has_previous` 前帧是否存在;`copyable` 前帧是否可作复制源;
/// `planned` 区域对照是否成功。
pub(super) fn upload_reason(
    has_previous: bool,
    copyable: bool,
    planned: bool,
) -> VertexTransferReason {
    match (has_previous, copyable, planned) {
        (false, _, _) => VertexTransferReason::NoPreviousFrame,
        (true, false, _) => VertexTransferReason::PreviousNotCopyable,
        // 有前帧且可复制,但区域对照被拒(超区域/字节上限/顶点不连续)。
        (true, true, false) => VertexTransferReason::PlanRejected,
        // 区域对照成功但碎片过多或缓冲太小,整块上传更划算。
        (true, true, true) => VertexTransferReason::BelowCopyThreshold,
    }
}
