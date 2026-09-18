using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

/// <summary>Deterministic, isolated benchmark scene controller for the bridge-smoke project.</summary>
public sealed class UnityBenchmarkController : MonoBehaviour
{
    [Serializable] private sealed class Sample { public int frame; public float frameMs; public float cameraX; public float cameraZ; public long managedBytes; }
    [Serializable] private sealed class Report
    {
        public string engine = "unity";
        public string unityVersion;
        public string graphicsDevice;
        public string graphicsApi;
        public string timingSource = "cpu-frame-interval";
        public string fixture = "synthetic-cubes-v1";
        public string trajectory = "orbit-0.35-radians-per-second-fixed-60hz";
        public string startedUtc;
        public bool rendered;
        public int warmupFrames;
        public int objectCount;
        public int sampleCount;
        public int width;
        public int height;
        public List<Sample> samples = new List<Sample>();
    }

    public int objectCount = 1000;
    public int warmupFrames = 30;
    public int measuredFrames = 120;
    public float orbitRadius = 35f;
    public float orbitSpeed = 0.35f;
    private readonly List<float> frameTimes = new List<float>();
    private Report report;
    private float angle;
    private int frame;
    private Camera cam;

    private void Start()
    {
        if (SystemInfo.graphicsDeviceType == UnityEngine.Rendering.GraphicsDeviceType.Null)
        {
            Debug.LogError("Benchmark requires a graphics device; remove -nographics. No performance report was written.");
            enabled = false;
            Application.Quit(2);
            return;
        }
        QualitySettings.vSyncCount = 0;
        Application.targetFrameRate = -1;
        Application.runInBackground = true;
        cam = Camera.main;
        if (cam == null) { var go = new GameObject("BenchmarkCamera"); cam = go.AddComponent<Camera>(); }
        report = new Report { unityVersion = Application.unityVersion, objectCount = objectCount,
            graphicsDevice = SystemInfo.graphicsDeviceName, graphicsApi = SystemInfo.graphicsDeviceType.ToString(),
            startedUtc = DateTime.UtcNow.ToString("O"), rendered = true, warmupFrames = warmupFrames,
            width = Screen.width, height = Screen.height };
        var parent = new GameObject("BenchmarkObjects").transform;
        var primitive = GameObject.CreatePrimitive(PrimitiveType.Cube);
        primitive.SetActive(false);
        for (var i = 0; i < objectCount; i++)
        {
            var go = Instantiate(primitive, parent);
            go.name = "BenchCube-" + i;
            var x = (i % 40) - 20;
            var z = (i / 40) - (objectCount / 80f);
            go.transform.position = new Vector3(x * 1.25f, (i % 7) * 0.18f, z * 1.25f);
            go.SetActive(true);
        }
        Destroy(primitive);
    }

    private void Update()
    {
        // 每个采样索引使用相同相机位置，避免快引擎与慢引擎走不同轨迹。
        angle = orbitSpeed * Mathf.Max(0, frame - warmupFrames) / 60f;
        if (cam != null)
        {
            cam.transform.position = new Vector3(Mathf.Sin(angle) * orbitRadius, 18f, Mathf.Cos(angle) * orbitRadius);
            cam.transform.LookAt(Vector3.zero);
        }
        frame++;
        if (frame <= warmupFrames) return;
        var ms = Time.unscaledDeltaTime * 1000f;
        frameTimes.Add(ms);
        report.samples.Add(new Sample { frame = frame - warmupFrames, frameMs = ms, cameraX = cam.transform.position.x, cameraZ = cam.transform.position.z, managedBytes = GC.GetTotalMemory(false) });
        if (frameTimes.Count >= measuredFrames) WriteReport();
    }

    private void WriteReport()
    {
        report.sampleCount = report.samples.Count;
        var dir = Path.Combine(Application.persistentDataPath, "deep-engine-benchmarks");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "unity-benchmark.json");
        File.WriteAllText(path, JsonUtility.ToJson(report, true));
        Debug.Log("Unity benchmark report: " + path);
        enabled = false;
    }
}
