//! X 窗口 tick 与 GPU 发布编排；失败保留最后已呈现内容。
use super::{
    NativeApp,
    x_transport::{Receipt, Transport},
};
use deep_engine_native::{
    compat_x::{XDynamicContent, scheduler::XTickBinding},
    deep2d::Deep2dRuntimeContent,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use winit::event_loop::{ActiveEventLoop, ControlFlow};

const TICK_INTERVAL: Duration = Duration::from_millis(16);

pub(super) struct Runtime {
    template: Arc<XDynamicContent>,
    transport: Transport,
    started: Instant,
    wake: Instant,
    accepted: u64,
    pending: Option<Receipt>,
    stopped: bool,
    inputs: super::x_input::InputQueue,
}

pub(super) fn presented(app: &mut NativeApp) {
    let Some(template) = app.content.active().x_template.clone() else {
        app.x_runtime.take();
        return;
    };
    if app
        .x_runtime
        .as_ref()
        .is_some_and(|runtime| Arc::ptr_eq(&runtime.template, &template))
    {
        return;
    }
    app.x_runtime.take();
    match Transport::start(template.clone(), app.proxy.clone()) {
        Ok(transport) => {
            app.x_runtime = Some(Runtime {
                template,
                transport,
                started: Instant::now(),
                wake: Instant::now(),
                accepted: 0,
                pending: None,
                stopped: false,
                inputs: Default::default(),
            });
        }
        Err(error) => fail(app, &error),
    }
}

pub(super) fn smoke_pending(app: &NativeApp) -> bool {
    app.content.active().x_template.is_some()
        && app
            .x_runtime
            .as_ref()
            .is_none_or(|runtime| runtime.accepted < 3 && !runtime.stopped)
}

pub(super) fn input(app: &mut NativeApp, event: deep_engine_native::compat_x::XEvent) {
    let source = app.content.active().x_template.clone();
    let result = app
        .x_runtime
        .as_mut()
        .filter(|runtime| {
            !runtime.stopped
                && source
                    .as_ref()
                    .is_some_and(|source| Arc::ptr_eq(source, &runtime.template))
        })
        .ok_or("X input unavailable before first presentation or after session stop")
        .and_then(|runtime| runtime.inputs.push(event));
    if let Err(error) = result {
        fail(app, error);
    }
}

pub(super) fn tick(app: &mut NativeApp, event_loop: &ActiveEventLoop) -> bool {
    let Some(mut runtime) = app.x_runtime.take() else {
        return false;
    };
    // Arc 身份绑定活动包；已排队的旧回执不能更新新包。
    if app
        .content
        .active()
        .x_template
        .as_ref()
        .is_none_or(|source| !Arc::ptr_eq(source, &runtime.template))
    {
        event_loop.set_control_flow(ControlFlow::Wait);
        return false;
    }
    let result = advance(app, &mut runtime);
    if let Err(error) = result {
        runtime.stopped = true;
        runtime.transport.close();
        fail(app, &error);
    }
    let wake = if runtime.stopped || runtime.transport.busy() {
        ControlFlow::Wait
    } else {
        ControlFlow::WaitUntil(runtime.wake)
    };
    app.x_runtime = Some(runtime);
    event_loop.set_control_flow(wake);
    if app.smoke_frame && app.state.failure.is_some() {
        event_loop.exit();
    }
    true
}

fn advance(app: &mut NativeApp, runtime: &mut Runtime) -> Result<(), String> {
    if runtime.stopped {
        return Ok(());
    }
    if runtime.pending.is_some() && Instant::now() < runtime.wake {
        return Ok(());
    }
    if let Some(result) = runtime.transport.poll() {
        runtime.pending = Some(result?);
    }
    if let Some(receipt) = runtime.pending.as_ref() {
        if Some(receipt.output.epoch)
            != runtime
                .template
                .request
                .expected_epoch
                .checked_add(runtime.accepted + 1)
        {
            return Err("X window receipt epoch mismatch".into());
        }
        let display = receipt
            .output
            .display_list()?
            .ok_or("X tick must publish a display layer")?;
        let unchanged = app
            .content
            .active()
            .deep2d
            .as_ref()
            .is_some_and(|old| old.display_list() == display);
        if !unchanged {
            let candidate = Deep2dRuntimeContent::DisplayList(display.clone());
            let context =
                super::deep2d_context::active_frame_context(app, &candidate, receipt.output.epoch);
            let renderer = app.renderer.as_mut().ok_or("X renderer unavailable")?;
            let staged =
                pollster::block_on(renderer.stage_deep2d_update_inner(Some(&candidate), context))?;
            let outcome = renderer.present_deep2d_update(staged);
            if !super::dashboard::presented(app, outcome)? {
                runtime.wake = Instant::now() + Duration::from_millis(100);
                return Ok(());
            }
            app.content.active_mut().deep2d = Some(candidate);
        }
        runtime.accepted += 1;
        if app.smoke_frame {
            println!(
                "native X window tick: {}",
                serde_json::json!({
                    "epoch": receipt.output.epoch, "workerProcessId": receipt.process_id,
                    "accepted": runtime.accepted, "outputHash": receipt.output.output_hash,
                    "reusedPresentedLayer": unchanged,
                })
            );
            app.request_redraw();
        }
        runtime.pending = None;
        runtime.wake = Instant::now() + TICK_INTERVAL;
    }
    if runtime.transport.busy() || runtime.pending.is_some() || Instant::now() < runtime.wake {
        return Ok(());
    }
    let request = &runtime.template.request;
    let sequence = runtime.accepted + 1;
    runtime.transport.submit(XTickBinding {
        epoch: request
            .expected_epoch
            .checked_add(sequence)
            .ok_or("X epoch overflow")?,
        started_at_ms: request
            .started_at_ms
            .checked_add(runtime.started.elapsed().as_millis() as u64)
            .ok_or("X clock overflow")?,
        random_seed: request
            .random_seed
            .checked_add(sequence)
            .ok_or("X seed overflow")?,
        events: runtime.inputs.take_or_defaults(&request.events),
    })
}

fn fail(app: &mut NativeApp, error: &str) {
    eprintln!("{error}");
    if let Some(window) = &app.window {
        crate::window_chrome::set_title(window, &format!("Deep Engine X — {error}"));
    }
    if app.smoke_frame {
        app.state.failed(error.to_owned());
    }
}
