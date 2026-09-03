using System.IO;
using BimStudio.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

public static class BridgeSmokeBuilder
{
    public static void Validate()
    {
        CreateScene();
        PrepareProject();
        var marker = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Build", "compile-ok.txt"));
        Directory.CreateDirectory(Path.GetDirectoryName(marker));
        File.WriteAllText(marker, Application.unityVersion);
        Debug.Log($"Industrial Studio Unity bridge package validation succeeded: {Application.unityVersion}");
    }

    public static void Build()
    {
        CreateScene();
        if (!BimStudio.Bridge.Editor.BimStudioProjectSetup.PrepareForExport(out _, out var preparationError))
            throw new BuildFailedException("Industrial Studio automatic project preparation failed: " + preparationError);
        AssertPrepared();
        var output = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Build", "WebGL"));
        Directory.CreateDirectory(output);
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { "Assets/BridgeSmoke.unity" },
            locationPathName = output,
            target = BuildTarget.WebGL,
            options = BuildOptions.None
        });
        if (report.summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded)
            throw new BuildFailedException($"Industrial Studio Unity bridge smoke build failed: {report.summary.result}");
        BimStudio.Bridge.Editor.BimStudioWebGLPackageExporter.CreateZip(output, Path.Combine(Path.GetDirectoryName(output), "bim-studio-webgl.zip"));
        Debug.Log($"Industrial Studio Unity bridge smoke build succeeded: {report.summary.totalSize} bytes");
    }

    private static void CreateScene()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        EditorSceneManager.SaveScene(scene, "Assets/BridgeSmoke.unity");
        EditorBuildSettings.scenes = new EditorBuildSettingsScene[0];
    }

    private static void PrepareProject()
    {
        BimStudio.Bridge.Editor.BimStudioProjectSetup.EnsureBridgeObject();
        BimStudio.Bridge.Editor.BimStudioProjectSetup.EnsureManifest();
        if (!BimStudio.Bridge.Editor.BimStudioProjectSetup.EnsureActiveSceneInBuildSettings(out var error))
            throw new BuildFailedException("Industrial Studio scene preparation failed: " + error);
        AssertPrepared();
    }

    private static void AssertPrepared()
    {
        var bridgeObject = GameObject.Find("BimStudioBridge");
        if (bridgeObject == null || bridgeObject.GetComponent<BimStudioBridge>() == null)
            throw new BuildFailedException("Industrial Studio automatic setup did not create the Bridge object.");
        var manifest = AssetDatabase.LoadAssetAtPath<BimStudio.Bridge.Editor.BimStudioManifestAsset>("Assets/Resources/BimStudioManifest.asset");
        if (manifest == null) throw new BuildFailedException("Industrial Studio automatic setup did not create the Manifest asset.");
        manifest.events = new string[0];
        manifest.actions = new string[0];
        manifest.dataLayers = new BimStudio.Bridge.Editor.BimStudioDataLayer[0];
        manifest.objects = new BimStudio.Bridge.Editor.BimStudioObject[0];
        EditorUtility.SetDirty(manifest);
        AssetDatabase.SaveAssets();
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
            throw new BuildFailedException("Industrial Studio automatic manifest discovery did not find every no-code binding.");
        if (string.IsNullOrWhiteSpace(actionBinding.objectId))
            throw new BuildFailedException("Industrial Studio automatic manifest discovery did not assign a stable business object ID.");
        var validation = BimStudio.Bridge.Editor.BimStudioManifestValidator.Validate(manifest);
        if (!validation.IsValid) throw new BuildFailedException("Industrial Studio no-code binding validation failed: " + string.Join("; ", validation.errors));
        var preparedScene = System.Array.Find(EditorBuildSettings.scenes, item => item.enabled && item.path == "Assets/BridgeSmoke.unity");
        if (preparedScene == null) throw new BuildFailedException("Industrial Studio automatic setup did not enable the active scene in Build Settings.");
    }
}
