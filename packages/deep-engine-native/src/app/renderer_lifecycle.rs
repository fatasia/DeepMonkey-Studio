use super::*;

impl NativeApp {
    pub(super) fn initialize_renderer(&mut self) {
        let Some(window) = self.window.as_ref() else {
            return;
        };
        let renderer_id = self.next_renderer_id;
        self.next_renderer_id = self
            .next_renderer_id
            .checked_add(1)
            .expect("renderer generation exhausted");
        let replacing_live_renderer = self.renderer.is_some();
        match pollster::block_on(Renderer::new(
            window.clone(),
            self.proxy.clone(),
            renderer_id,
            self.content.active(),
            self.state.view,
            self.features.for_content(self.content.active()),
        )) {
            Ok(renderer) => {
                self.state.renderer_ready();
                report_renderer_ready(&renderer);
                // P1-19:图表内容才需要字体,因此能力探测只在此时做一次。
                // 探测要遍历系统字体库(实测约 9ms),不放进无文本场景的启动路径。
                if self.content.active().chart.is_some() {
                    let capability = self
                        .chart_text
                        .get_or_insert_with(Default::default)
                        .font_capability();
                    println!("native font capability: {}", capability.summary());
                    for face in capability.faces.iter().take(8) {
                        println!(
                            "native font face: family={} postscript={} weight={} italic={} mono={} hash={:016x} bytes={}",
                            face.identity.family,
                            face.identity.post_script_name,
                            face.identity.weight,
                            face.identity.italic,
                            face.identity.monospaced,
                            face.identity.content_hash,
                            face.identity.content_bytes
                        );
                    }
                    if capability.faces.len() > 8 {
                        println!(
                            "native font capability: {} more faces omitted",
                            capability.faces.len() - 8
                        );
                    }
                }
                self.renderer = Some(renderer);
                crate::window_chrome::set_title(window, "");
                window.request_redraw();
            }
            Err(error) => {
                eprintln!("{error}");
                if self.smoke_frame || !replacing_live_renderer {
                    self.state.failed(error);
                }
                if replacing_live_renderer {
                    crate::window_chrome::set_title(
                        window,
                        "Deep Engine Native Viewer — rebuild rejected, previous frame retained",
                    );
                    window.request_redraw();
                } else {
                    crate::window_chrome::set_title(
                        window,
                        "Deep Engine Native Viewer — GPU initialization failed (press R)",
                    );
                }
            }
        }
    }
}
