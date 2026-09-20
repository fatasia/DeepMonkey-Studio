// 隐藏 Windows 控制台窗口（批次 E A5：PE 子系统必须是 GUI 而非 CONSOLE）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bim_studio_desktop_lib::run();
}
