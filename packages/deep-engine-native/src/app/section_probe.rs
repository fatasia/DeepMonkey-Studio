use super::NativeApp;
use crate::renderer::SectionReadback;
use winit::keyboard::KeyCode;

#[derive(Default)]
pub(super) struct SectionProbe {
    step: u8,
    readback: Option<SectionReadback>,
}

pub(super) fn advance(app: &mut NativeApp) -> Result<bool, String> {
    let mut probe = app.section_probe.take().ok_or("section probe missing")?;
    let renderer = app.renderer.as_ref().ok_or("section renderer missing")?;
    match probe.step {
        0 => {
            let readback = SectionReadback::new(renderer);
            readback.capture(renderer, true);
            probe.readback = Some(readback);
            super::section::key(app, KeyCode::KeyC);
        }
        1 => {
            let readback = probe.readback.as_ref().ok_or("section readback missing")?;
            readback.capture(renderer, false);
            readback.finish(renderer, false)?;
            let size = app
                .window
                .as_ref()
                .ok_or("section window missing")?
                .inner_size();
            for y in 0..size.height {
                for x in 0..size.width {
                    if let Some(hit) = crate::player_picking::pick(
                        app.content.active().packet(),
                        app.state.view,
                        [size.width, size.height],
                        [x as f64, y as f64],
                    ) && hit.point[0] < -1e-5
                    {
                        return Err("sectioned triangle was pickable".into());
                    }
                }
            }
            super::section::key(app, KeyCode::KeyC);
        }
        _ => {
            let readback = probe.readback.as_ref().ok_or("section readback missing")?;
            readback.capture(renderer, false);
            readback.finish(renderer, true)?;
            println!(
                "native section GPU probe OK: fragment=clipped shadow=clipped picking=filtered reset=exact"
            );
            return Ok(true);
        }
    }
    probe.step += 1;
    app.section_probe = Some(probe);
    Ok(false)
}
