// Unity 批处理入口:建场景 → 产材质资产 → 存资产 → 构建 Windows x64 播放器 → 退出。
// 用法:Unity.exe -batchmode -quit -projectPath <proj> -executeMethod BenchBuild.BuildAndQuit -logFile <log>
using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class BenchBuild
{
    public static void BuildAndQuit()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var runnerGo = new GameObject("BenchRunner");
        runnerGo.AddComponent<BenchRunner>();
        var cameraGo = new GameObject("MainCamera");
        cameraGo.tag = "MainCamera";
        cameraGo.AddComponent<Camera>();

        // 材质资产化进 Resources:播放器里 Shader.Find("Standard") 会被裁剪(无资产引用),必须资产化
        var resources = Path.Combine("Assets", "Resources");
        Directory.CreateDirectory(resources);
        for (int i = 0; i < 6; i++)
            AssetDatabase.CreateAsset(BenchRunner.CreateBenchMaterial(i), $"Assets/Resources/bench-mat-{i}.mat");
        AssetDatabase.CreateAsset(BenchRunner.CreateGroundMaterial(), "Assets/Resources/bench-ground.mat");
        AssetDatabase.SaveAssets();

        var scenePath = Path.Combine("Assets", "Bench.unity");
        EditorSceneManager.SaveScene(scene, scenePath);

        var output = Environment.GetEnvironmentVariable("BENCH_PLAYER_OUT");
        if (string.IsNullOrEmpty(output)) output = Path.Combine(Directory.GetParent(Application.dataPath).FullName, "Builds", "bench.exe");
        Directory.CreateDirectory(Path.GetDirectoryName(output));
        var options = new BuildPlayerOptions
        {
            scenes = new[] { scenePath },
            locationPathName = output,
            target = BuildTarget.StandaloneWindows64,
        };
        var report = BuildPipeline.BuildPlayer(options);
        var summary = report.summary;
        Console.WriteLine($"[bench-build] result={summary.result} size={summary.totalSize} errors={summary.totalErrors} output={output}");
        if (summary.result != BuildResult.Succeeded || summary.totalErrors > 0) EditorApplication.Exit(3);
        EditorApplication.Exit(0);
    }
}
