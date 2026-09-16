use super::NativeApp;
use crate::player_content::chart_sim::ChartSimHost;
use std::time::{Duration, Instant};
use winit::event_loop::{ActiveEventLoop, ControlFlow};

/// 积压追赶节奏:每次唤醒至多提交一帧,最快 10ms 一帧,不忙等也不跳样本。
pub(super) const MIN_WAKE_MS: u64 = 10;
/// 唤醒上限与 sim fixture 允许的最大 interval 一致:极慢样本按期等待,不空转。
pub(super) const MAX_WAKE_MS: u64 = 86_400_000;
/// GPU 候选失败(渲染器未就绪、stage 拒绝)后的重试退避。
pub(super) const RETRY_BACKOFF_MS: u64 = 100;

/// 调度数学(固定时钟可测):距下一次唤醒的时长。积压时不追平历史欠账,
/// 只按追赶节奏逐帧补;无到期信息(时钟耗尽)时按上限等待。
pub(super) fn wake_delay(due_ms: Option<u64>, elapsed_ms: u64) -> Duration {
    let delay = due_ms
        .map(|due| due.saturating_sub(elapsed_ms))
        .unwrap_or(MAX_WAKE_MS);
    Duration::from_millis(delay.clamp(MIN_WAKE_MS, MAX_WAKE_MS))
}

/// 单次唤醒的结果;`Idle` 与 `Committed` 都已按新游标重排唤醒时刻。
pub(super) enum PumpOutcome {
    /// 唤醒未到或无到期样本:游标与提交计数均不变。
    Idle,
    /// 成功提交一帧:committed_frames 已 +1。
    Committed,
    /// 候选被拒:游标保持原位,按退避重试。
    Failed,
}

/// tick 与 smoke 注入共用的唯一推进实现。渲染器 gate 在 prepare 之前,
/// 因此任何失败路径(含渲染器未就绪)都不触碰 prepare/commit,游标原地保持。
/// 前置条件:宿主存在且 source 未取消。
pub(super) fn pump(app: &mut NativeApp, host: &mut ChartSimHost, now: Instant) -> PumpOutcome {
    let started = *host.started.get_or_insert(now);
    if host.wake_at.is_some_and(|wake| now < wake) {
        return PumpOutcome::Idle;
    }
    let elapsed = now
        .duration_since(started)
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let result = if app.renderer.is_none() {
        Err("chart renderer is not ready".into())
    } else {
        apply_frame(app, host, elapsed)
    };
    match result {
        Ok(committed) => {
            host.last_error = None;
            host.wake_at = now.checked_add(wake_delay(host.source.next_due_ms().ok(), elapsed));
            if committed {
                PumpOutcome::Committed
            } else {
                PumpOutcome::Idle
            }
        }
        Err(error) => {
            if host.last_error.as_ref() != Some(&error) {
                eprintln!("chart sim: {error}");
            }
            host.last_error = Some(error);
            host.wake_at = now.checked_add(Duration::from_millis(RETRY_BACKOFF_MS));
            PumpOutcome::Failed
        }
    }
}

pub(super) fn tick(app: &mut NativeApp, event_loop: &ActiveEventLoop) {
    if app.smoke_frame {
        return;
    }
    let Some(mut host) = app.content.active_mut().chart_sim.take() else {
        // 换包丢弃宿主后残留调度必须归位;新包的宿主从首帧重新起算。
        if app.chart_sim_scheduled {
            event_loop.set_control_flow(ControlFlow::Wait);
            app.chart_sim_scheduled = false;
        }
        return;
    };
    if host.source.is_cancelled() {
        // 取消即终态:没有下一次到期,调度归位;宿主保留以便复查游标与错误。
        event_loop.set_control_flow(ControlFlow::Wait);
        app.chart_sim_scheduled = false;
        app.content.active_mut().chart_sim = Some(host);
        return;
    }
    pump(app, &mut host, Instant::now());
    if let Some(wake) = host.wake_at {
        event_loop.set_control_flow(ControlFlow::WaitUntil(wake));
        app.chart_sim_scheduled = true;
    }
    app.content.active_mut().chart_sim = Some(host);
}

fn apply_frame(app: &mut NativeApp, host: &mut ChartSimHost, elapsed: u64) -> Result<bool, String> {
    let revision = app
        .content
        .active()
        .chart
        .as_ref()
        .ok_or("chart sim source missing")?
        .data_revision();
    let Some(frame) = host.source.prepare(elapsed, revision)? else {
        return Ok(false);
    };
    let message = frame.message().clone();
    super::chart::update(app, |chart| chart.apply_data_message(message).map(|_| true));
    let committed = app
        .content
        .active()
        .chart
        .as_ref()
        .ok_or("chart sim source missing")?
        .data_revision();
    host.source.commit(frame, committed)?;
    host.committed_frames += 1;
    Ok(true)
}

/// fixture seed=1、rows=[C,D,E]:tick0..3 滚动窗口的 x 维期望值。
const SMOKE_TICK_X: [&str; 4] = ["D", "E", "C", "D"];

/// smoke 注入(--smoke-chart-sim):用 tick 同款 pump 在正常视口(640x360)下
/// 走完真实定时、空闲不产出、积压追赶、GPU 失败恢复与取消终态的完整流程。
/// 阶段计数借用 chart_probe(转发链路只判断其是否为 Some)。
pub(super) fn advance_smoke(app: &mut NativeApp) -> Result<bool, String> {
    let mut host = app
        .content
        .active_mut()
        .chart_sim
        .take()
        .ok_or("sim host missing")?;
    let result = advance_smoke_step(app, &mut host);
    app.content.active_mut().chart_sim = Some(host);
    result
}

fn advance_smoke_step(app: &mut NativeApp, host: &mut ChartSimHost) -> Result<bool, String> {
    let step = app.chart_probe.unwrap_or(0);
    match step {
        0 => {
            let list = chart(app)?.frame().display_list();
            if (list.logical_width as u32, list.logical_height as u32) != (640, 360) {
                return Err(format!(
                    "sim smoke: unexpected viewport {}x{}",
                    list.logical_width, list.logical_height
                ));
            }
            match pump(app, host, Instant::now()) {
                PumpOutcome::Committed => expect_tick(app, host, 0)?,
                _ => return Err("sim smoke: first real-clock frame was not committed".into()),
            }
        }
        1 => {
            // 空闲注入:唤醒未到,连续推进都不得产出或消费游标。
            for _ in 0..2 {
                assert_idle(app, host)?;
            }
        }
        2 | 4 => {
            // 真实定时/积压追赶:未到期就交还重绘循环,由真实 Instant 决定何时提交。
            match pump(app, host, Instant::now()) {
                PumpOutcome::Idle => return Ok(false),
                PumpOutcome::Committed => expect_tick(app, host, if step == 2 { 1 } else { 2 })?,
                PumpOutcome::Failed => {
                    return Err("sim smoke: unexpected candidate rejection".into());
                }
            }
            if step == 4 {
                // 每唤醒至多一帧:即便仍有积压,紧接的推进也必须等下一次唤醒。
                assert_idle(app, host)?;
            }
        }
        3 => {
            // 制造积压:宿主停顿超过一个 interval,醒来必须从最早未提交 tick 补起。
            std::thread::sleep(Duration::from_millis(250));
        }
        5 => {
            // GPU 候选失败注入:渲染器离位时推进必须失败,且游标与计数都不动。
            let renderer = app.renderer.take();
            host.wake_at = None;
            let outcome = pump(app, host, Instant::now());
            app.renderer = renderer;
            if !matches!(outcome, PumpOutcome::Failed) {
                return Err("sim smoke: renderer outage was not reported".into());
            }
            if host.committed_frames != 3
                || host.source.next_due_ms() != Ok(300)
                || host.last_error.is_none()
            {
                return Err("sim smoke: failed candidate moved the cursor".into());
            }
        }
        6 => {
            // 恢复:渲染器就位后从原游标续跑,样本序列无缺口。
            host.wake_at = None;
            match pump(app, host, Instant::now()) {
                PumpOutcome::Committed => expect_tick(app, host, 3)?,
                _ => return Err("sim smoke: did not resume after recovery".into()),
            }
        }
        _ => {
            host.source.cancel();
            let revision = chart(app)?.data_revision();
            if host.source.prepare(u64::MAX, revision)?.is_some()
                || host.source.next_due_ms().is_ok()
            {
                return Err("cancelled sim still produces data".into());
            }
            println!(
                "native chart sim smoke: 640x360 real-clock commits with backlog catch-up, GPU-failure recovery and cancellation clean"
            );
            app.chart_probe = None;
            return Ok(true);
        }
    }
    app.chart_probe = Some(step + 1);
    Ok(false)
}

fn chart(app: &NativeApp) -> Result<&deep_engine_native::chart::ChartRuntime, String> {
    app.content
        .active()
        .chart
        .as_ref()
        .ok_or_else(|| "sim smoke: chart missing".into())
}

fn expect_tick(app: &mut NativeApp, host: &mut ChartSimHost, tick: usize) -> Result<(), String> {
    if host.committed_frames != tick as u64 + 1 {
        return Err("sim smoke: commit count out of step".into());
    }
    let dataset = chart(app)?
        .source()
        .datasets
        .iter()
        .find(|d| d.id == "main")
        .ok_or("sim smoke: dataset missing")?;
    let last = dataset.rows.last().ok_or("sim smoke: no rows")?[0].clone();
    let x = serde_json::to_value(last).map_err(|e| e.to_string())?;
    if x.as_str() != Some(SMOKE_TICK_X[tick]) {
        return Err(format!("sim smoke: sample gap at tick {tick}: got {x:?}"));
    }
    Ok(())
}

fn assert_idle(app: &mut NativeApp, host: &mut ChartSimHost) -> Result<(), String> {
    let before = host.committed_frames;
    if !matches!(pump(app, host, Instant::now()), PumpOutcome::Idle)
        || host.committed_frames != before
    {
        return Err("sim smoke: idle pump produced output".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MAX_WAKE_MS, MIN_WAKE_MS, RETRY_BACKOFF_MS, wake_delay};
    use std::time::Duration;

    #[test]
    fn wake_delay_covers_backlog_future_and_clock_exhaustion() {
        // 积压:不追平历史欠账,按追赶节奏逐帧补。
        assert_eq!(
            wake_delay(Some(0), 5_000),
            Duration::from_millis(MIN_WAKE_MS)
        );
        // 恰好到期:同样取下限,避免零间隔忙等。
        assert_eq!(
            wake_delay(Some(100), 100),
            Duration::from_millis(MIN_WAKE_MS)
        );
        // 未来到期:按差值等待,不受下限影响。
        assert_eq!(wake_delay(Some(3_600), 100), Duration::from_millis(3_500));
        // 无到期信息与时钟耗尽:按上限等待,不空转。
        assert_eq!(wake_delay(None, 0), Duration::from_millis(MAX_WAKE_MS));
        assert_eq!(
            wake_delay(Some(u64::MAX), 0),
            Duration::from_millis(MAX_WAKE_MS)
        );
        assert_eq!(RETRY_BACKOFF_MS, 100);
    }
}
