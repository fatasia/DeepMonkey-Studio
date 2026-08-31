using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Callbacks;
using UnityEditor.PackageManager;
using UnityEngine;

namespace BimStudio.Bridge.Editor
{
    public static class BimStudioWebGLExporter
    {
        [PostProcessBuild(900)]
        public static void ExportManifest(BuildTarget target, string outputPath)
        {
            if (target != BuildTarget.WebGL) return;
            var settings = Resources.Load<BimStudioManifestAsset>("BimStudioManifest")
                ?? AssetDatabase.LoadAssetAtPath<BimStudioManifestAsset>("Assets/Resources/BimStudioManifest.asset")
                ?? Resources.FindObjectsOfTypeAll<BimStudioManifestAsset>().FirstOrDefault();
            if (settings == null) throw new BuildFailedException("缺少 BIM Studio 集成清单，请先运行“BIM Studio/准备项目（通信桥与集成清单）”。");
            var validation = BimStudioManifestValidator.Validate(settings);
            if (!validation.IsValid) throw new BuildFailedException("BIM Studio 集成清单校验失败：\n" + string.Join("\n", validation.errors));
            foreach (var warning in validation.warnings) Debug.LogWarning("[BIM Studio Manifest] " + warning);
            var manifest = new BimStudioManifest
            {
                scenes = EditorBuildSettings.scenes.Where(scene => scene.enabled).Select(scene => Path.GetFileNameWithoutExtension(scene.path)).ToArray(),
                events = settings?.events ?? Array.Empty<string>(),
                actions = settings?.actions ?? Array.Empty<string>(),
                dataLayers = settings?.dataLayers ?? Array.Empty<BimStudioDataLayer>(),
                objects = settings?.objects ?? Array.Empty<BimStudioObject>(),
                properties = settings?.properties ?? Array.Empty<BimStudioProperty>()
            };
            File.WriteAllText(Path.Combine(outputPath, "bim-studio.manifest.json"), JsonUtility.ToJson(manifest, true));
            InstallBrowserBridge(outputPath);
            AssetDatabase.Refresh();
        }

        private static void InstallBrowserBridge(string outputPath)
        {
            var package = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(BimStudioWebGLExporter).Assembly);
            if (package == null) throw new BuildFailedException("无法定位 BIM Studio Bridge 插件目录。");

            var source = Path.Combine(package.resolvedPath, "Editor", "unity-bridge.js");
            var target = Path.Combine(outputPath, "unity-bridge.js");
            var indexPath = Path.Combine(outputPath, "index.html");
            if (!File.Exists(source) || !File.Exists(indexPath))
                throw new BuildFailedException("BIM Studio Bridge 找不到 unity-bridge.js 或构建生成的 index.html。");

            File.Copy(source, target, true);
            var html = File.ReadAllText(indexPath);
            const string scriptTag = "<script src=\"unity-bridge.js\"></script>";
            if (!html.Contains(scriptTag))
                html = html.Replace("</head>", "  " + scriptTag + Environment.NewLine + "  </head>");

            const string promiseMarker = ".then((unityInstance) => {";
            var promiseIndex = html.IndexOf(promiseMarker, StringComparison.Ordinal);
            if (promiseIndex < 0)
                throw new BuildFailedException("BIM Studio Bridge 无法在 index.html 中定位 Unity 播放器创建回调。");

            var registration = promiseMarker + Environment.NewLine +
                "                window.BimStudioUnityBridge.register(unityInstance, \"BimStudioBridge\");";
            html = html.Replace(promiseMarker, registration);
            File.WriteAllText(indexPath, html);
        }
    }
}
