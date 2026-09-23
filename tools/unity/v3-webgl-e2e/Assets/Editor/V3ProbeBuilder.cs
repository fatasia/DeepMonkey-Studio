// V3 Unity WebGL 本机导出验证构建器（batchmode 命令行入口）。
// 场景 = 默认场景 + 一个红色无光照立方体（材质验证目标）+ Deep Monkey Studio bridge no-code 探针。
// 构建输出与 ZIP 路径由环境变量 BIM_V3_BUILD_OUTPUT / BIM_V3_ZIP_OUTPUT 注入（见 run-v3-webgl-build.ps1）。
using System;
using System.IO;
using BimStudio.Bridge;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class V3ProbeBuilder
{
    public static void Build()
    {
        var output = Environment.GetEnvironmentVariable("BIM_V3_BUILD_OUTPUT");
        var zipPath = Environment.GetEnvironmentVariable("BIM_V3_ZIP_OUTPUT");
        if (string.IsNullOrWhiteSpace(output) || string.IsNullOrWhiteSpace(zipPath))
            throw new BuildFailedException("缺少 BIM_V3_BUILD_OUTPUT / BIM_V3_ZIP_OUTPUT 环境变量。");

        CreateScene();
        if (!BimStudio.Bridge.Editor.BimStudioProjectSetup.PrepareForExport(out _, out var preparationError))
            throw new BuildFailedException("Deep Monkey Studio V3 探针工程准备失败: " + preparationError);
        AssertPrepared();

        // 无压缩格式：产物可直接被静态服务器托管（无需 Content-Encoding 协商），e2e 验收更可判定。
        // Unity 6 API：PlayerSettings.WebGL.compressionFormat（WebGLCompressionFormat.Brotli/Gzip/Disabled）。
        PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
        Directory.CreateDirectory(output);
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { "Assets/V3Probe.unity" },
            locationPathName = output,
            target = BuildTarget.WebGL,
            options = BuildOptions.None
        });
        if (report.summary.result != BuildResult.Succeeded)
            throw new BuildFailedException($"Deep Monkey Studio V3 WebGL build failed: {report.summary.result}");

        BimStudio.Bridge.Editor.BimStudioWebGLPackageExporter.CreateZip(output, zipPath);
        Debug.Log($"Deep Monkey Studio V3 WebGL build succeeded: {report.summary.totalSize} bytes -> {output}");
    }

    private static void CreateScene()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var cameraGo = new GameObject("Main Camera");
        cameraGo.tag = "MainCamera";
        var camera = cameraGo.AddComponent<Camera>();
        camera.backgroundColor = new Color(0.09f, 0.13f, 0.15f);
        camera.clearFlags = CameraClearFlags.SolidColor;
        cameraGo.transform.position = new Vector3(0f, 0.7f, -3.2f);
        cameraGo.transform.rotation = Quaternion.Euler(9f, 0f, 0f);
        var lightGo = new GameObject("Directional Light");
        var light = lightGo.AddComponent<Light>();
        light.type = LightType.Directional;
        light.intensity = 1.1f;
        lightGo.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
        var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
        cube.name = "V3Cube";
        cube.transform.position = Vector3.zero;
        cube.GetComponent<Renderer>().sharedMaterial = new Material(Shader.Find("Unlit/Color"))
        {
            color = new Color(0.86f, 0.28f, 0.22f)
        };
        EditorSceneManager.SaveScene(scene, "Assets/V3Probe.unity");
        EditorBuildSettings.scenes = new EditorBuildSettingsScene[0];
    }

    // 与 BridgeSmokeBuilder.AssertPrepared 同族：no-code 绑定 → 清单发现 → 校验 → 场景入构。
    private static void AssertPrepared()
    {
        var bridgeObject = GameObject.Find("BimStudioBridge");
        if (bridgeObject == null || bridgeObject.GetComponent<BimStudioBridge>() == null)
            throw new BuildFailedException("Deep Monkey Studio automatic setup did not create the Bridge object.");
        var manifest = AssetDatabase.LoadAssetAtPath<BimStudio.Bridge.Editor.BimStudioManifestAsset>("Assets/Resources/BimStudioManifest.asset");
        if (manifest == null) throw new BuildFailedException("Deep Monkey Studio automatic setup did not create the Manifest asset.");
        var probe = GameObject.Find("BridgeNoCodeProbe") ?? new GameObject("BridgeNoCodeProbe");
        var valueBinding = probe.GetComponent<BimStudioValueBinding>() ?? probe.AddComponent<BimStudioValueBinding>();
        valueBinding.key = "telemetry";
        var actionBinding = probe.GetComponent<BimStudioActionBinding>() ?? probe.AddComponent<BimStudioActionBinding>();
        actionBinding.action = "focus";
        var emitter = probe.GetComponent<BimStudioEventEmitter>() ?? probe.AddComponent<BimStudioEventEmitter>();
        emitter.eventName = "device-click";
        emitter.payloadJson = "{\"deviceId\":\"pump-01\"}";
        EditorSceneManager.SaveScene(probe.scene);
        BimStudio.Bridge.Editor.BimStudioManifestSynchronizer.Synchronize(manifest);
        if (System.Array.Find(manifest.dataLayers, item => item.key == "telemetry") == null ||
            System.Array.IndexOf(manifest.actions, "focus") < 0 || System.Array.IndexOf(manifest.events, "device-click") < 0 || manifest.objects.Length != 1)
            throw new BuildFailedException("Deep Monkey Studio automatic manifest discovery did not find every no-code binding.");
        if (GameObject.Find("V3Cube") == null)
            throw new BuildFailedException("V3 探针场景缺少材质验证立方体。");
        var validation = BimStudio.Bridge.Editor.BimStudioManifestValidator.Validate(manifest);
        if (!validation.IsValid) throw new BuildFailedException("Deep Monkey Studio no-code binding validation failed: " + string.Join("; ", validation.errors));
        var preparedScene = System.Array.Find(EditorBuildSettings.scenes, item => item.enabled && item.path == "Assets/V3Probe.unity");
        if (preparedScene == null) throw new BuildFailedException("Deep Monkey Studio automatic setup did not enable the active scene in Build Settings.");
    }
}
