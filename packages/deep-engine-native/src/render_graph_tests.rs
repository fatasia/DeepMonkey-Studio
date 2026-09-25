//! `render_graph` executor 的纯 CPU 证据链。
//!
//! 并行度硬证据:`threads_one_vs_four_wall_clock_speedup_at_least_2x`
//! 以 N 个独立 CPU 编码单元实测 1 线程 vs 4 线程 wall-clock 加速比,
//! 加速比数字原样打印进测试输出;产物逐位一致测试以「完成次序 ≠ 节点序」
//! 的随机负载证明收集次序由固定节点序决定,而非完成次序。
//! GPU 侧真机证据见 `renderer::shadow_parallel_gpu_tests`。

use std::{
    hint::black_box,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use super::render_graph::{GraphJob, execute_graph_batch, execute_graph_levels};

/// 确定性「编码」负载:xorshift64 + 旋转加法混合,输出字节只依赖
/// (seed, iterations);纯 CPU 计算,thread 数只改变 wall-clock,
/// 不改变产物。周期性 black_box 防止整个循环被优化掉。
fn deterministic_encode_work(seed: u64, iterations: u64) -> Vec<u8> {
    let mut state = seed ^ 0x9E37_79B9_7F4A_7C15;
    let mut sink = 0u64;
    for step in 0..iterations {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        sink = sink.wrapping_add(state.rotate_left((step % 64) as u32));
        if step & 0xFFF == 0 {
            black_box((state, sink));
        }
    }
    black_box(sink);
    let mut artifact = Vec::with_capacity(16);
    artifact.extend_from_slice(&seed.to_le_bytes());
    artifact.extend_from_slice(&state.to_le_bytes());
    artifact.extend_from_slice(&sink.to_le_bytes());
    artifact
}

/// 每节点负载时长经 LCG 打散:节点完成次序与节点序不一致,
/// 用于证明「收集次序 = 固定节点序,与完成次序无关」。
fn scattered_iterations(seed: u64, base: u64) -> u64 {
    let mut state = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    state ^= state >> 33;
    base.saturating_sub(state % (base / 2).max(1))
}

fn jobs_for(nodes: u64, base_iterations: u64) -> Vec<GraphJob<'static, Vec<u8>>> {
    (0..nodes)
        .map(|index| {
            GraphJob::new(format!("encode-unit-{index}"), move |_| {
                Ok(deterministic_encode_work(
                    index,
                    scattered_iterations(index, base_iterations),
                ))
            })
        })
        .collect()
}

fn artifacts_for(threads: usize, nodes: u64, base_iterations: u64) -> Vec<Vec<u8>> {
    execute_graph_batch(jobs_for(nodes, base_iterations), threads)
        .into_artifacts()
        .expect("deterministic batch must not fail")
}

fn logical_cores() -> usize {
    thread::available_parallelism()
        .map(|cores| cores.get())
        .unwrap_or(1)
}

#[test]
fn artifacts_are_bit_identical_across_one_two_four_and_seven_threads() {
    let reference = artifacts_for(1, 24, 400_000);
    for threads in [2usize, 4, 7] {
        let parallel = artifacts_for(threads, 24, 400_000);
        assert_eq!(
            reference, parallel,
            "thread count changed encoded artifacts (threads={threads})"
        );
    }
}

#[test]
fn collection_order_is_fixed_node_order_not_completion_order() {
    // 并行批次里节点 0 的负载远重于后续节点:后续节点必然先完成。
    // 若收集按完成次序,产物会乱序;按固定节点序则逐位等于单线程基线。
    let single = execute_graph_batch(
        (0..8)
            .map(|index| {
                GraphJob::new(format!("unit-{index}"), move |_| {
                    deterministic_encode_work(index, 10_000);
                    Ok(index)
                })
            })
            .collect(),
        1,
    )
    .into_artifacts()
    .unwrap();
    assert_eq!(single, (0..8).collect::<Vec<u64>>());
    let parallel = execute_graph_batch(
        (0..8)
            .map(|index| {
                let iterations = if index == 0 { 4_000_000 } else { 40_000 };
                GraphJob::new(format!("unit-{index}"), move |_| {
                    deterministic_encode_work(index, iterations);
                    Ok(index)
                })
            })
            .collect(),
        4,
    )
    .into_artifacts()
    .unwrap();
    assert_eq!(parallel, (0..8).collect::<Vec<u64>>());
}

#[test]
fn batch_error_cancels_remaining_nodes_and_reports_first_failure_in_node_order() {
    let started = Arc::new(AtomicUsize::new(0));
    let jobs: Vec<GraphJob<'static, u8>> = (0..6)
        .map(|index| {
            let started = Arc::clone(&started);
            GraphJob::new(format!("node-{index}"), move |_| {
                started.fetch_add(1, Ordering::SeqCst);
                if index == 1 {
                    return Err("cascade encoder rejected".to_owned());
                }
                if index == 3 {
                    return Err("late failure that must not shadow node 1".to_owned());
                }
                deterministic_encode_work(index, 2_000_000);
                Ok(index as u8)
            })
        })
        .collect();
    let report = execute_graph_batch(jobs, 4);
    assert!(
        report.started <= 5,
        "cancellation must stop queuing new nodes, started={}",
        report.started
    );
    let error = report.into_artifacts().unwrap_err();
    // 错误取节点序下第一个失败,与谁先完成无关。
    assert_eq!(error.node_index, 1);
    assert_eq!(error.node_name, "node-1");
    assert!(error.error.contains("cascade encoder rejected"));
    assert!(
        error.cancelled_after >= 1,
        "至少有节点因取消而未执行,cancelled_after={}",
        error.cancelled_after
    );
}

#[test]
fn panicked_node_becomes_failed_node_and_batch_is_cancelled() {
    let jobs: Vec<GraphJob<'static, u8>> = vec![
        GraphJob::new("fine", |_| Ok(1)),
        GraphJob::new("explodes", |_| panic!("encoder state poisoned")),
        GraphJob::new("never", |_| Ok(3)),
    ];
    let report = execute_graph_batch(jobs, 3);
    let error = report.into_artifacts().unwrap_err();
    assert_eq!(error.node_index, 1);
    assert!(
        error.error.contains("panicked") && error.error.contains("encoder state poisoned"),
        "panic must surface as node failure: {}",
        error.error
    );
}

/// 当前进程内名为 `deep-executor` 的执行器线程数(ToolHelp 枚举 tid →
/// OpenThread → GetThreadDescription 按名匹配)。只统计执行器自己的线程:
/// 对并行测试中其它子系统(wgpu/MF/音频)创建的线程免疫——这是水位用例
/// 并行 flaky 的根因修复(t2 下误报 readings 漂移 10→27)。
#[cfg(windows)]
fn executor_thread_count() -> usize {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::Threading::{
        GetThreadDescription, OpenThread, THREAD_QUERY_LIMITED_INFORMATION,
    };
    const EXECUTOR_NAME: &[u16] = &[
        b'd' as u16,
        b'e' as u16,
        b'e' as u16,
        b'p' as u16,
        b'-' as u16,
        b'e' as u16,
        b'x' as u16,
        b'e' as u16,
        b'c' as u16,
        b'u' as u16,
        b't' as u16,
        b'o' as u16,
        b'r' as u16,
    ];

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        assert_ne!(snapshot, INVALID_HANDLE_VALUE, "thread snapshot failed");
        let current_pid = std::process::id();
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..std::mem::zeroed()
        };
        let mut count = 0usize;
        let mut alive = Thread32First(snapshot, &mut entry) != 0;
        while alive {
            if entry.th32OwnerProcessID == current_pid {
                let handle = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, entry.th32ThreadID);
                if !handle.is_null() {
                    let mut description = std::ptr::null_mut();
                    if GetThreadDescription(handle, &mut description) == 0 && !description.is_null()
                    {
                        let mut matched = true;
                        for (index, expected) in EXECUTOR_NAME.iter().enumerate() {
                            if *description.add(index) != *expected {
                                matched = false;
                                break;
                            }
                        }
                        if matched {
                            count += 1;
                        }
                    }
                    CoTaskMemFree(description.cast());
                    CloseHandle(handle);
                }
            }
            alive = Thread32Next(snapshot, &mut entry) != 0;
        }
        assert_ne!(CloseHandle(snapshot), 0, "thread snapshot close failed");
        count
    }
}

#[test]
#[cfg(windows)]
fn executor_threads_are_fully_joined_after_every_batch() {
    // scoped executor 的清理由 join 语义保证;这里以 OS 线程高水位观测,
    // 防御「后台线程泄漏」回归。泄漏的表现是水位随批次单调抬升(每批 3~4 条
    // 永久残留)。cargo test 并行下,其它测试(wgpu 驱动线程、Media Foundation
    // 解码线程)会在两个采样窗口之间创建**常驻**线程,「批前 vs 批后」单对比
    // 的漂移对称假设不成立(V5 预检 2026-09-23 实测误报)。改为对 6 批各采样
    // 一次、比较序列首尾:泄漏使尾批抬升 ≥12 条,容差 6 仍可检出,而批间
    // 漂移不再被累计进单一差值。
    let mut readings = Vec::new();
    for _ in 0..6 {
        execute_graph_batch(jobs_for(8, 200_000), 4)
            .into_artifacts()
            .unwrap();
        readings.push(executor_thread_count());
    }
    let first = readings[0];
    let last = readings[readings.len() - 1];
    assert!(
        last <= first + 6,
        "batch executor must not leak threads: first={first} last={last} readings={readings:?}"
    );
}

/// 采样窗口内的线程数高水位(5 个样本,间隔 40ms)。
#[cfg(windows)]
fn high_water_thread_count() -> usize {
    (0..5)
        .map(|_| {
            let count = executor_thread_count();
            thread::sleep(Duration::from_millis(40));
            count
        })
        .max()
        .unwrap_or_default()
}

#[test]
fn levels_run_sequentially_with_happens_before_between_levels() {
    // 层 0 写,层 1 读:若层间没有 happens-before,层 1 可能读到旧值。
    let counter = Arc::new(AtomicUsize::new(0));
    let level0: Vec<GraphJob<'_, usize>> = (0..4)
        .map(|_| {
            let counter = Arc::clone(&counter);
            GraphJob::new(
                "writer",
                move |_| Ok(counter.fetch_add(1, Ordering::SeqCst)),
            )
        })
        .collect();
    let level1: Vec<GraphJob<'_, usize>> = (0..4)
        .map(|index| {
            let counter = Arc::clone(&counter);
            GraphJob::new(format!("reader-{index}"), move |_| {
                let observed = counter.load(Ordering::SeqCst);
                assert_eq!(
                    observed, 4,
                    "level 1 must observe all level 0 writes before it starts"
                );
                Ok(observed)
            })
        })
        .collect();
    let artifacts = execute_graph_levels(vec![level0, level1], 4).unwrap();
    assert_eq!(artifacts, vec![vec![0, 1, 2, 3], vec![4, 4, 4, 4]]);
}

#[test]
fn a_failed_level_cancels_all_following_levels() {
    let level0: Vec<GraphJob<'static, u8>> = vec![
        GraphJob::new("ok", |_| Ok(1)),
        GraphJob::new("boom", |_| Err("level 0 rejected".to_owned())),
    ];
    let level1: Vec<GraphJob<'static, u8>> = vec![GraphJob::new("never-runs", |_| Ok(2))];
    let error = execute_graph_levels(vec![level0, level1], 2).unwrap_err();
    assert_eq!(error.node_index, 1);
    assert!(error.node_name.contains("level 0"), "{}", error.node_name);
    assert!(error.node_name.contains("boom"), "{}", error.node_name);
}

/// 并行度硬证据(交接合同:必须证明 executor 线程并行,禁止 Promise/async
/// 冒充)。8 个互相独立的编码单元,1 线程 vs 4 线程 wall-clock 对比,
/// 加速比原样打印。≥4 逻辑核的机器断言 ≥2x;单/双核机器无法证明 4 线程
/// 线性度,如实降级为「只打印不断言 2x」并注明边界。
#[test]
fn threads_one_vs_four_wall_clock_speedup_at_least_2x() {
    let cores = logical_cores();
    let nodes = 8u64;
    // 校准:单线程总负载 ≈ 0.4s(8 × ~50ms),足够盖过调度噪声。
    let base_iterations = 40_000_000;
    let serial_jobs = jobs_for(nodes, base_iterations);
    let serial_started = Instant::now();
    let serial = execute_graph_batch(serial_jobs, 1)
        .into_artifacts()
        .unwrap();
    let serial_elapsed = serial_started.elapsed();

    let parallel_jobs = jobs_for(nodes, base_iterations);
    let parallel_started = Instant::now();
    let parallel = execute_graph_batch(parallel_jobs, 4)
        .into_artifacts()
        .unwrap();
    let parallel_elapsed = parallel_started.elapsed();

    assert_eq!(
        serial, parallel,
        "speedup harness itself must not change artifacts"
    );

    let speedup = serial_elapsed.as_secs_f64() / parallel_elapsed.as_secs_f64();
    println!(
        "executor parallel speedup evidence: nodes={nodes} serial(1 thread)={serial_elapsed:?} parallel(4 threads)={parallel_elapsed:?} speedup={speedup:.2}x logical_cores={cores}"
    );
    if cores >= 4 {
        assert!(
            speedup >= 2.0,
            "4 executor threads must beat 1 thread by ≥2x on ≥4 logical cores \
             (machine boundary: cores={cores}); measured {speedup:.2}x \
             serial={serial_elapsed:?} parallel={parallel_elapsed:?}"
        );
    } else {
        println!(
            "machine boundary: only {cores} logical cores, 4-thread linearity \
             not provable here; measured {speedup:.2}x (informational)"
        );
    }
}
