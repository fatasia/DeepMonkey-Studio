//! Native RenderGraph 真多线程 command 编码 executor。
//!
//! 交接合同(2026-09-20 handoff):「Native RenderGraph 真多线程 command
//! encoding;必须证明是 executor 线程并行和确定性提交,不能用 Promise 冒充」。
//! 本模块是纯 CPU 的调度核心,不依赖 wgpu;wgpu 侧按「每节点独立
//! CommandEncoder → CommandBuffer → 固定节点序单次 submit」接线
//! (见 `shadow_pass::encode_shadow_cascades_parallel`)。
//!
//! 执行语义(与 Web 侧 R6-3 `executeParallelGroups` 的合同对齐,但这里是
//! 真 CPU 线程并行,不是 async 协程交错):
//! - 层间有序、层内并行:同一依赖层内的节点互相独立,派发到 executor
//!   线程;层 k 的全部产物落位后才开始层 k+1(`execute_graph_levels`)。
//! - 提交/收集次序确定:结果一律写回固定节点序的槽位,与完成次序无关;
//!   上层按该序拼接 command buffer,wgpu 队列对单次 submit 内的
//!   command buffer 保证 FIFO 执行序,因此 GPU 观察序与串行一致。
//! - 错误传播取消整批:任一节点失败即置位批级取消标志;尚未开跑的节点
//!   直接记 Cancelled,已在跑的节点跑完但产物丢弃;返回错误取「节点序」
//!   下第一个失败,可复现、可定位。
//! - 无数据竞争:节点闭包只持共享输入(`&T`,全部 `Sync`),可变产物只经
//!   返回值交回;内部互斥锁只护「槽位存取」,从不护节点编码过程。
//!
//! 并行度证据:`render_graph_tests` 用纯 CPU 编码单元实测 1 线程 vs
//! 4 线程 wall-clock 加速比(断言 ≥2x);GPU 侧串行/并行产物逐位一致由
//! `renderer::shadow_parallel_gpu_tests` 用真机深度回读证明。

use std::{
    any::Any,
    error, fmt,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
};

/// 批内共享的取消标志:任一节点失败后,尚未开跑的节点据此跳过。
/// 节点闭包以 `&BatchCancel` 接收,可在长任务里自行检查提前退出。
pub struct BatchCancel(AtomicBool);

impl BatchCancel {
    fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
}

/// 单节点编码体:只读共享输入,产物经返回值交回。
// wasm:作业退化为非 Send(单线程顺序执行);桌面保留 Send 供 scoped 并行。
#[cfg(not(target_arch = "wasm32"))]
/// Send 约束的 wasm 兼容开关:native 上等价 A: Send(全量 blanket);
/// wasm32 上作业单线程顺序执行,约束置空(wgpu web 后端类型非 Send)。
#[cfg(not(target_arch = "wasm32"))]
pub trait GraphSend: Send {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send> GraphSend for T {}
#[cfg(target_arch = "wasm32")]
pub trait GraphSend {}
#[cfg(target_arch = "wasm32")]
impl<T> GraphSend for T {}

#[cfg(not(target_arch = "wasm32"))]
type JobRun<'scope, A> = Box<dyn FnOnce(&BatchCancel) -> Result<A, String> + Send + 'scope>;
#[cfg(target_arch = "wasm32")]
type JobRun<'scope, A> = Box<dyn FnOnce(&BatchCancel) -> Result<A, String> + 'scope>;

/// 单个编码节点。`name` 只用于错误定位;`run` 只允许读共享输入,产物经
/// 返回值交回 —— 这是对「无数据竞争」的静态约束:闭包要跨线程发送,
/// 捕获的可变状态会被编译器拒绝。
pub struct GraphJob<'scope, A> {
    name: String,
    run: JobRun<'scope, A>,
}

impl<'scope, A> GraphJob<'scope, A> {
    pub fn new(
        name: impl Into<String>,
        run: impl FnOnce(&BatchCancel) -> Result<A, String> + GraphSend + 'scope,
    ) -> Self {
        Self {
            name: name.into(),
            run: Box::new(run),
        }
    }
}

/// 单节点结果。`Cancelled` 表示因批内其它节点失败而未执行。
pub enum JobOutcome<A> {
    Completed(A),
    Failed(String),
    Cancelled,
}

/// 一批节点的执行报告:`outcomes` 与派发时完全同序(固定节点序),
/// 与完成次序无关;`started` 是实际开跑(含失败)的节点数。
pub struct BatchReport<A> {
    /// 与派发时完全同序的节点结果(固定节点序,与完成次序无关)。
    pub outcomes: Vec<JobOutcome<A>>,
    names: Vec<String>,
    /// 实际开跑(含失败)的节点数 —— 取消传播的观测面。
    #[allow(dead_code)] // 并行度/取消证据字段,由 render_graph_tests 消费。
    pub started: usize,
    #[allow(dead_code)] // 线程钳制证据字段,由 render_graph_tests 消费。
    pub requested_threads: usize,
    #[allow(dead_code)] // 线程钳制证据字段,由 render_graph_tests 消费。
    pub used_threads: usize,
}

/// 整批失败的确定性错误:取节点序下第一个失败节点。
#[derive(Clone, PartialEq, Eq)]
pub struct GraphBatchError {
    pub node_index: usize,
    pub node_name: String,
    pub error: String,
    /// 因取消而没有产出的后续节点数(不含失败节点本身)。
    pub cancelled_after: usize,
}

impl fmt::Debug for GraphBatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GraphBatchError")
            .field("node_index", &self.node_index)
            .field("node_name", &self.node_name)
            .field("error", &self.error)
            .field("cancelled_after", &self.cancelled_after)
            .finish()
    }
}

impl fmt::Display for GraphBatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "render graph node {index} `{name}` failed: {error} (cancelled_after={cancelled_after})",
            index = self.node_index,
            name = self.node_name,
            error = self.error,
            cancelled_after = self.cancelled_after
        )
    }
}

impl error::Error for GraphBatchError {}

impl<A> BatchReport<A> {
    /// 整批语义:全部成功 → 按固定节点序的产物;任一失败 → 节点序下
    /// 第一个失败的确定性错误,全部产物丢弃(整批取消)。
    pub fn into_artifacts(self) -> Result<Vec<A>, GraphBatchError> {
        self.finish()
    }

    fn finish(self) -> Result<Vec<A>, GraphBatchError> {
        let first_failure = self
            .outcomes
            .iter()
            .position(|outcome| matches!(outcome, JobOutcome::Failed(_)));
        let Some(fail_at) = first_failure else {
            let cancelled = self
                .outcomes
                .iter()
                .filter(|outcome| matches!(outcome, JobOutcome::Cancelled))
                .count();
            if cancelled == 0 {
                let mut artifacts = Vec::with_capacity(self.outcomes.len());
                for outcome in self.outcomes {
                    match outcome {
                        JobOutcome::Completed(artifact) => artifacts.push(artifact),
                        JobOutcome::Failed(_) | JobOutcome::Cancelled => {
                            unreachable!("first_failure 为空时此分支不可达")
                        }
                    }
                }
                return Ok(artifacts);
            }
            // 防御:取消标志只由失败触发;无失败却有取消属于内部状态错误。
            return Err(GraphBatchError {
                node_index: usize::MAX,
                node_name: "<batch>".to_owned(),
                error: format!("batch cancelled without recorded failure ({cancelled} nodes)"),
                cancelled_after: cancelled,
            });
        };
        let error = match &self.outcomes[fail_at] {
            JobOutcome::Failed(error) => error.clone(),
            JobOutcome::Completed(_) | JobOutcome::Cancelled => {
                unreachable!("fail_at 指向 Failed 节点")
            }
        };
        let cancelled_after = self.outcomes[fail_at + 1..]
            .iter()
            .filter(|outcome| matches!(outcome, JobOutcome::Cancelled))
            .count();
        Err(GraphBatchError {
            node_index: fail_at,
            node_name: self
                .names
                .get(fail_at)
                .cloned()
                .unwrap_or_else(|| format!("node-{fail_at}")),
            error,
            cancelled_after,
        })
    }
}

/// 在 executor 线程上并行执行一批相互独立的编码节点。
///
/// - `threads` 是期望的并发 executor 数(含调用线程;调用线程自己就是
///   其中一个 executor,所以单节点批次零额外线程开销)。入参会被钳制到
///   `[1, jobs.len()]`。
/// - 返回报告里 `outcomes.len() == jobs.len()`,固定节点序。
/// - 线程生命周期由 `std::thread::scope` 约束:批次结束前必然全部 join,
///   不留后台线程(清理由类型系统保证,`render_graph_tests` 另有观测)。
pub fn execute_graph_batch<'scope, A: GraphSend>(
    jobs: Vec<GraphJob<'scope, A>>,
    threads: usize,
) -> BatchReport<A> {
    let total = jobs.len();
    if total == 0 {
        return BatchReport {
            outcomes: Vec::new(),
            names: Vec::new(),
            started: 0,
            requested_threads: threads,
            used_threads: 0,
        };
    }
    let requested_threads = threads;
    let used_threads = threads.max(1).min(total);
    let names: Vec<String> = jobs.iter().map(|job| job.name.clone()).collect();
    let cancel = BatchCancel::new();
    let next = AtomicUsize::new(0);
    let started = AtomicUsize::new(0);
    // 互斥锁只护「槽位存取」与「结果落位」,从不护节点编码过程。
    let slots = Mutex::new(jobs.into_iter().map(Some).collect::<Vec<_>>());
    let outcomes: Mutex<Vec<Option<JobOutcome<A>>>> =
        Mutex::new((0..total).map(|_| None).collect());

    let worker = || loop {
        let index = next.fetch_add(1, Ordering::AcqRel);
        if index >= total {
            return;
        }
        if cancel.is_cancelled() {
            let mut guard = slots
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard[index] = None;
            drop(guard);
            let mut sink = outcomes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            sink[index] = Some(JobOutcome::Cancelled);
            continue;
        }
        let job = {
            let mut guard = slots
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard[index].take()
        };
        let Some(job) = job else { continue };
        started.fetch_add(1, Ordering::Relaxed);
        // 节点 panic 视为该节点失败:整批取消,但不让 unwind 穿过 executor。
        let outcome = match catch_unwind(AssertUnwindSafe(|| (job.run)(&cancel))) {
            Ok(Ok(artifact)) => JobOutcome::Completed(artifact),
            Ok(Err(error)) => {
                cancel.cancel();
                JobOutcome::Failed(error)
            }
            Err(panic) => {
                cancel.cancel();
                JobOutcome::Failed(panic_message(panic))
            }
        };
        let mut sink = outcomes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sink[index] = Some(outcome);
    };

    // wasm:wgpu web 后端类型非 Send,作业不能跨线程——退化为单线程顺序
    // 执行(同一作业队列,总量不变);桌面保持并行 scoped 线程。
    #[cfg(target_arch = "wasm32")]
    {
        set_executor_thread_name();
        for _ in 1..used_threads {
            worker();
        }
        worker();
    }
    #[cfg(not(target_arch = "wasm32"))]
    thread::scope(|scope| {
        // worker 是只捕获共享引用的闭包(Copy):每个 executor 线程领一份。
        // spawn 的线程命名 deep-executor:水位测试按名计数,对并行测试中
        // 其它子系统(wgpu/MF/音频)创建的线程免疫。
        for _ in 1..used_threads {
            scope.spawn(|| {
                set_executor_thread_name();
                worker();
            });
        }
        // 调用线程自身也是一个 executor:单节点批次不付线程创建成本。
        worker();
    });

    let outcomes = outcomes
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .into_iter()
        .map(|slot| slot.unwrap_or(JobOutcome::Cancelled))
        .collect();
    BatchReport {
        outcomes,
        names,
        started: started.load(Ordering::Relaxed),
        requested_threads,
        used_threads,
    }
}

/// 按层执行 Native RenderGraph:层 k 全部产物落位后才开始层 k+1
/// (层间 happens-before),层内并行、结果按固定节点序。
/// 任一层失败即取消后续所有层(整批取消语义)。
#[allow(dead_code)] // Native RenderGraph 层级执行合同(对应 Web R6-3 组间有序/组内并行),由 render_graph_tests 驱动。
pub fn execute_graph_levels<'scope, A: GraphSend>(
    levels: Vec<Vec<GraphJob<'_, A>>>,
    threads: usize,
) -> Result<Vec<Vec<A>>, GraphBatchError> {
    let mut artifacts = Vec::with_capacity(levels.len());
    for (level_index, jobs) in levels.into_iter().enumerate() {
        match execute_graph_batch(jobs, threads).into_artifacts() {
            Ok(level_artifacts) => artifacts.push(level_artifacts),
            Err(mut error) => {
                error.node_name = format!("[level {level_index}] {}", error.node_name);
                return Err(error);
            }
        }
    }
    Ok(artifacts)
}

fn panic_message(panic: Box<dyn Any + Send>) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        format!("job panicked: {message}")
    } else if let Some(message) = panic.downcast_ref::<String>() {
        format!("job panicked: {message}")
    } else {
        "job panicked".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{BatchReport, GraphBatchError, GraphJob, JobOutcome};

    #[test]
    fn empty_batch_is_ok_with_zero_artifacts() {
        let report: BatchReport<u32> = super::execute_graph_batch(Vec::new(), 4);
        assert_eq!(report.into_artifacts().unwrap(), Vec::<u32>::new());
    }

    #[test]
    fn threads_above_node_count_is_clamped_to_node_count() {
        let jobs: Vec<GraphJob<'_, u8>> = (0..2)
            .map(|i| GraphJob::new(format!("n{i}"), move |_| Ok(i)))
            .collect();
        let report = super::execute_graph_batch(jobs, 64);
        assert_eq!(report.used_threads, 2);
        assert_eq!(report.requested_threads, 64);
    }

    #[test]
    fn zero_threads_still_executes_on_caller_thread() {
        let jobs: Vec<GraphJob<'_, u8>> = (0..3)
            .map(|i| GraphJob::new(format!("n{i}"), move |_| Ok(i)))
            .collect();
        let report = super::execute_graph_batch(jobs, 0);
        assert_eq!(report.used_threads, 1);
        assert_eq!(report.into_artifacts().unwrap(), vec![0, 1, 2]);
    }

    #[test]
    fn single_failed_node_is_reported_with_name_and_index() {
        let jobs: Vec<GraphJob<'_, u8>> = vec![
            GraphJob::new("ok", |_| Ok(1)),
            GraphJob::new("boom", |_| Err("cascade encoder rejected".to_owned())),
        ];
        let report = super::execute_graph_batch(jobs, 2);
        assert!(matches!(report.outcomes[0], JobOutcome::Completed(1)));
        assert!(matches!(
            report.outcomes[1],
            JobOutcome::Failed(ref error) if error.contains("cascade encoder rejected")
        ));
        let error = report.into_artifacts().unwrap_err();
        assert_eq!(error.node_index, 1);
        assert!(error.node_name.contains("boom"), "{}", error.node_name);
    }

    #[test]
    fn error_type_implements_std_error_for_caller_integration() {
        let error = GraphBatchError {
            node_index: 3,
            node_name: "shadow-cascade-3".to_owned(),
            error: "device lost".to_owned(),
            cancelled_after: 2,
        };
        let boxed: Box<dyn std::error::Error> = Box::new(error.clone());
        assert!(boxed.to_string().contains("shadow-cascade-3"));
        assert!(boxed.to_string().contains("device lost"));
    }
}

/// 执行器线程统一命名(windows:SetThreadDescription 伪句程即当前线程)。
/// 供 render_graph_tests 按名计数,替代进程级线程快照(对并行测试敏感)。
#[cfg(windows)]
pub(crate) fn set_executor_thread_name() {
    use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadDescription};
    let wide: Vec<u16> = "deep-executor"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        SetThreadDescription(GetCurrentThread(), wide.as_ptr());
    }
}

#[cfg(not(windows))]
pub(crate) fn set_executor_thread_name() {}

