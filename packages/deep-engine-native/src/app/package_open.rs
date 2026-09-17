//! Bounded background package reads; only a successfully staged renderer replaces the scene.
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

use winit::event_loop::EventLoopProxy;

use super::{NativeApp, packet_mailbox::LatestMailbox};
use crate::{events::GpuEvent, player_content::PlayerContent};

pub(super) struct PackageOpen {
    requests: LatestMailbox<PathBuf>,
    results: LatestMailbox<Result<PlayerContent, String>>,
    wake: mpsc::SyncSender<()>,
    generation: u64,
    stopped: Arc<AtomicBool>,
}

impl Drop for PackageOpen {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

impl PackageOpen {
    fn new(
        proxy: EventLoopProxy<GpuEvent>,
        loader: fn(PathBuf) -> Result<PlayerContent, String>,
    ) -> Result<Self, String> {
        Self::with_loader(loader, move || {
            proxy.send_event(GpuEvent::PackageOpened).is_ok()
        })
    }

    fn with_loader(
        mut load: impl FnMut(PathBuf) -> Result<PlayerContent, String> + Send + 'static,
        notify: impl Fn() -> bool + Send + 'static,
    ) -> Result<Self, String> {
        let requests = LatestMailbox::default();
        let results = LatestMailbox::default();
        let (wake, receiver) = mpsc::sync_channel(1);
        let pending = requests.clone();
        let completed = results.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        std::thread::Builder::new()
            .name("runtime-package-open".into())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    if worker_stopped.load(Ordering::Acquire) {
                        break;
                    }
                    let Some(request) = pending.take_latest() else {
                        continue;
                    };
                    let result = load(request.value);
                    if worker_stopped.load(Ordering::Acquire) {
                        break;
                    }
                    if completed.push(request.generation, result) && !notify() {
                        break;
                    }
                }
            })
            .map_err(|error| format!("package-open/worker-unavailable: {error}"))?;
        Ok(Self {
            requests,
            results,
            wake,
            generation: 0,
            stopped,
        })
    }

    fn request(&mut self, path: PathBuf) -> Result<(), String> {
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| "package-open/generation-exhausted".to_owned())?;
        self.requests.push(self.generation, path);
        match self.wake.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => Ok(()),
            Err(mpsc::TrySendError::Disconnected(())) => Err("package-open/worker-stopped".into()),
        }
    }

    fn take_current(&self) -> Option<Result<PlayerContent, String>> {
        self.results
            .take_latest()
            .filter(|candidate| candidate.generation == self.generation)
            .map(|candidate| candidate.value)
    }
}

pub(super) fn request(app: &mut NativeApp, path: PathBuf) {
    // Live-reload and smoke modes retain their explicit command-line source authority.
    if app.smoke_frame
        || app.packet_live_transport.is_some()
        || app.package_live_transport.is_some()
    {
        reject(app, "file drop is unavailable in smoke/live-reload mode");
        return;
    }
    if app.package_open.is_none() {
        let loader: fn(PathBuf) -> Result<PlayerContent, String> = super::package_source::load;
        #[cfg(windows)]
        let loader = if app.content.active().x_template.is_some() {
            // 只在显式 X 窗口中复用 X 加载器；普通窗口仍拒绝 v6。
            |path: PathBuf| crate::x_package_window::prepare(&path)
        } else {
            loader
        };
        match PackageOpen::new(app.proxy.clone(), loader) {
            Ok(transport) => app.package_open = Some(transport),
            Err(error) => {
                reject(app, &error);
                return;
            }
        }
    }
    match app
        .package_open
        .as_mut()
        .expect("open transport exists")
        .request(path)
    {
        Ok(()) => {
            if let Some(window) = &app.window {
                window.set_title("Deep Engine Native Viewer — opening package");
            }
        }
        Err(error) => reject(app, &error),
    }
}

pub(super) fn flush_drop(app: &mut NativeApp) {
    match app.drop_batch.take() {
        Some(Ok(path)) => request(app, path),
        Some(Err(error)) => reject(app, error),
        None => {}
    }
}

pub(super) fn apply_latest(app: &mut NativeApp) {
    let Some(transport) = &app.package_open else {
        return;
    };
    let Some(candidate) = transport.take_current() else {
        return;
    };
    let generation = transport.generation;
    if !super::annotations::preserve(app) {
        return;
    }
    let content = match candidate {
        Ok(content) => content,
        Err(error) => {
            reject(app, &error);
            return;
        }
    };
    let Some(window) = app.window.clone() else {
        return;
    };
    let outcome = match super::package_camera::stage_open_camera(app, &content) {
        Ok(Some(renderer)) => {
            drop(app.renderer.take());
            renderer.activate_surface();
            app.renderer = Some(renderer);
            Ok(())
        }
        Ok(None) => match app.renderer.as_mut() {
            Some(renderer) => {
                pollster::block_on(renderer.replace_dropped_package(app.content.active(), &content))
            }
            None => Err("renderer unavailable".into()),
        },
        Err(error) => Err(error),
    };
    match outcome {
        Ok(()) => {
            app.state.view = content.initial_view();
            // This mode has no watcher: drop generations are the publication authority.
            app.content.publish(generation, content);
            super::selection::clear(app);
            super::annotations::clear(app);
            app.state.renderer_ready();
            window.set_title("Deep Engine Native Viewer — package opened");
            app.request_redraw();
        }
        Err(error) => {
            reject(app, &error);
            app.request_redraw();
        }
    }
}

#[cfg(test)]
#[path = "package_open_tests.rs"]
mod tests;

fn reject(app: &NativeApp, error: &str) {
    eprintln!("package open rejected, previous scene retained: {error}");
    if let Some(window) = &app.window {
        window.set_title("Deep Engine Native Viewer — package rejected, previous scene retained");
    }
}
