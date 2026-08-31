/** pnpm 会把脚本名后的参数直接传给 Tauri；额外的 `--` 会误落到 Cargo。 */
export function desktopDevelopmentArguments(webAlreadyRunning) {
  return [
    "--filter",
    "@bim-studio/desktop",
    "dev",
    ...(webAlreadyRunning ? ["--config", "src-tauri/tauri.existing-dev.conf.json"] : []),
  ];
}
