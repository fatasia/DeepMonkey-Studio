using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace BimStudio.Bridge.Editor
{
    public static class BimStudioWebGLPackageExporter
    {
        [MenuItem("Industrial Studio/一键构建并导出 WebGL ZIP", priority = 2)]
        public static void BuildAndExport()
        {
            if (!BimStudioProjectSetup.PrepareForExport(out var manifest, out var preparationError))
            {
                EditorUtility.DisplayDialog("Industrial Studio", preparationError, "确定");
                return;
            }

            BimStudioManifestSynchronizer.Synchronize(manifest);

            var validation = BimStudioManifestValidator.Validate(manifest);
            if (!validation.IsValid)
            {
                Selection.activeObject = manifest;
                EditorGUIUtility.PingObject(manifest);
                EditorUtility.DisplayDialog("Industrial Studio", "请先修复集成清单中的问题：\n\n" + string.Join("\n", validation.errors), "打开集成清单");
                return;
            }

            var enabledScenes = EditorBuildSettings.scenes.Where(scene => scene.enabled && File.Exists(scene.path)).Select(scene => scene.path).ToArray();
            if (enabledScenes.Length == 0)
            {
                EditorUtility.DisplayDialog("Industrial Studio", "没有可导出的已保存场景。", "确定");
                return;
            }

            var defaultName = string.IsNullOrWhiteSpace(PlayerSettings.productName) ? "UnityWebGL" : SafeFileName(PlayerSettings.productName);
            var zipPath = EditorUtility.SaveFilePanel("导出 Industrial Studio Unity WebGL ZIP", LastExportDirectory(), defaultName + ".zip", "zip");
            if (string.IsNullOrWhiteSpace(zipPath)) return;
            EditorPrefs.SetString("BimStudio.LastExportDirectory", Path.GetDirectoryName(zipPath) ?? string.Empty);

            try
            {
                BuildToZip(zipPath, enabledScenes);
                EditorUtility.RevealInFinder(zipPath);
                EditorUtility.DisplayDialog("Industrial Studio", "WebGL ZIP 已生成，可直接拖入 Industrial Studio：\n\n" + zipPath, "完成");
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
                EditorUtility.DisplayDialog("Industrial Studio 导出失败", exception.Message, "打开控制台");
                throw;
            }
            finally
            {
                EditorUtility.ClearProgressBar();
            }
        }

        public static void BuildToZip(string zipPath, string[] scenes)
        {
            if (string.IsNullOrWhiteSpace(zipPath)) throw new ArgumentException("必须指定 ZIP 输出路径。", nameof(zipPath));
            if (scenes == null || scenes.Length == 0) throw new BuildFailedException("没有可构建的已启用场景。");
            var buildRoot = Path.GetFullPath(Path.Combine("Library", "BimStudioBuilds", Guid.NewGuid().ToString("N")));
            try
            {
                Directory.CreateDirectory(buildRoot);
                EditorUtility.DisplayProgressBar("Industrial Studio", "正在构建 Unity WebGL…", 0.2f);
                var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
                {
                    scenes = scenes,
                    locationPathName = buildRoot,
                    target = BuildTarget.WebGL,
                    options = BuildOptions.None
                });
                if (report.summary.result != BuildResult.Succeeded)
                    throw new BuildFailedException($"Unity WebGL 构建失败：{report.summary.result}");
                EditorUtility.DisplayProgressBar("Industrial Studio", "正在打包可直接导入的 ZIP…", 0.9f);
                CreateZip(buildRoot, zipPath);
            }
            finally
            {
                if (Directory.Exists(buildRoot)) Directory.Delete(buildRoot, true);
                EditorUtility.ClearProgressBar();
            }
        }

        public static void CreateZip(string buildRoot, string zipPath)
        {
            var resolvedRoot = Path.GetFullPath(buildRoot);
            var resolvedZip = Path.GetFullPath(zipPath);
            if (!File.Exists(Path.Combine(resolvedRoot, "index.html")))
                throw new BuildFailedException("构建结果中缺少 index.html。");
            if (!File.Exists(Path.Combine(resolvedRoot, "bim-studio.manifest.json")))
                throw new BuildFailedException("构建结果中缺少 bim-studio.manifest.json。");
            Directory.CreateDirectory(Path.GetDirectoryName(resolvedZip) ?? Directory.GetCurrentDirectory());
            if (File.Exists(resolvedZip)) File.Delete(resolvedZip);
            using var archive = ZipFile.Open(resolvedZip, ZipArchiveMode.Create);
            foreach (var file in Directory.EnumerateFiles(resolvedRoot, "*", SearchOption.AllDirectories))
            {
                var relative = file.Substring(resolvedRoot.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Replace('\\', '/');
                archive.CreateEntryFromFile(file, relative, System.IO.Compression.CompressionLevel.Optimal);
            }
        }

        private static string LastExportDirectory()
        {
            var stored = EditorPrefs.GetString("BimStudio.LastExportDirectory", string.Empty);
            return Directory.Exists(stored) ? stored : Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        }

        private static string SafeFileName(string value)
        {
            return string.Concat(value.Select(character => Path.GetInvalidFileNameChars().Contains(character) ? '_' : character)).Trim();
        }
    }
}
