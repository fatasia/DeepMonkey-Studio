using System.Diagnostics;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

namespace BimStudio.RevitWorker;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static int Main(string[] args)
    {
        try
        {
            var options = Arguments.Parse(args);
            if (options.Value("inspect") is { } inspectPath)
            {
                Console.WriteLine(JsonSerializer.Serialize(RevitFileInspector.Inspect(inspectPath), JsonOptions));
                return 0;
            }
            Run(options);
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception.Message);
            return 1;
        }
    }

    private static void Run(Arguments options)
    {
        var version = options.Value("revit-version") ?? Environment.GetEnvironmentVariable("RVT_REVIT_VERSION") ?? "2026";
        var timeoutSeconds = options.IntValue("timeout-seconds", 1800);
        using var mutex = new Mutex(false, $"Local\\BimStudio.RevitWorker.{version}");
        var lockAcquired = false;
        try
        {
            lockAcquired = mutex.WaitOne(TimeSpan.FromSeconds(timeoutSeconds));
        }
        catch (AbandonedMutexException)
        {
            // The previous converter process exited unexpectedly. Windows grants
            // ownership to this thread, so the queue can safely recover.
            lockAcquired = true;
        }
        if (!lockAcquired) throw new TimeoutException("等待 Revit Worker 作业锁超时");
        try
        {
            RunAsync(options).GetAwaiter().GetResult();
        }
        finally
        {
            mutex.ReleaseMutex();
        }
    }

    private static async Task RunAsync(Arguments options)
    {
        var input = Path.GetFullPath(options.Required("input"));
        var output = Path.GetFullPath(options.Required("output"));
        var mode = options.Value("mode") ?? "native-glb";
        var version = options.Value("revit-version") ?? Environment.GetEnvironmentVariable("RVT_REVIT_VERSION") ?? "2026";
        var timeoutSeconds = options.IntValue("timeout-seconds", 1800);
        if (!File.Exists(input)) throw new FileNotFoundException("RVT 文件不存在", input);
        if (mode is not ("ifc" or "native-glb")) throw new ArgumentException("--mode 必须是 ifc 或 native-glb");
        if (!int.TryParse(version, out var numericVersion) || numericVersion < 2019 || numericVersion > 2099)
            throw new ArgumentException("--revit-version 必须是四位 Revit 版本号");

        Directory.CreateDirectory(output);
        var workerRoot = WorkerPaths.VersionRoot(version);
        Directory.CreateDirectory(workerRoot);
        Directory.CreateDirectory(Path.Combine(workerRoot, "jobs"));
        Directory.CreateDirectory(Path.Combine(workerRoot, "results"));

        await EnsureRevitAsync(version, workerRoot, TimeSpan.FromSeconds(150));
        var job = new WorkerJob(
            Guid.NewGuid().ToString("N"), input, output, mode, version, DateTimeOffset.UtcNow);
        var jobPath = Path.Combine(workerRoot, "jobs", $"{job.Id}.job.json");
        await AtomicJson.WriteAsync(jobPath, job, JsonOptions);
        Console.WriteLine($"已投递 {mode} 作业 {job.Id}，复用 Revit {version} 常驻进程");

        var resultPath = Path.Combine(workerRoot, "results", $"{job.Id}.result.json");
        var deadline = DateTimeOffset.UtcNow.AddSeconds(timeoutSeconds);
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (File.Exists(resultPath))
            {
                var result = JsonSerializer.Deserialize<WorkerResult>(await File.ReadAllTextAsync(resultPath), JsonOptions)
                    ?? throw new InvalidDataException("Revit Worker 返回了无效结果");
                File.Delete(resultPath);
                if (!result.Success) throw new InvalidOperationException(result.Error ?? "Revit 转换失败");
                var expected = Path.Combine(output, mode == "ifc" ? "model.ifc" : "geometry.glb");
                if (!File.Exists(expected)) throw new FileNotFoundException("Revit 报告成功但没有生成目标文件", expected);
                Console.WriteLine($"转换完成：{expected}");
                return;
            }
            await Task.Delay(500);
        }
        throw new TimeoutException($"Revit 转换超过 {timeoutSeconds} 秒，作业 {job.Id} 仍未完成");
    }

    private static async Task EnsureRevitAsync(string version, string workerRoot, TimeSpan timeout)
    {
        if (await IsReadyAsync(workerRoot)) return;
        var executable = WorkerPaths.RevitExecutable(version);
        if (!File.Exists(executable)) throw new FileNotFoundException($"找不到 Revit {version}", executable);

        var startInfo = new ProcessStartInfo(executable, "/nosplash")
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(executable)!,
            WindowStyle = ProcessWindowStyle.Minimized,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        startInfo.Environment["BIM_STUDIO_WORKER_ROOT"] = workerRoot;
        startInfo.Environment["BIM_STUDIO_WORKER_VERSION"] = version;
        var process = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动 Revit");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        var deadline = DateTimeOffset.UtcNow.Add(timeout);
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (await IsReadyAsync(workerRoot)) return;
            await Task.Delay(1000);
        }
        throw new TimeoutException($"Revit {version} 已启动，但 Add-in 在 {timeout.TotalSeconds:0} 秒内没有就绪；请检查 Add-in 安装和 Revit 日志");
    }

    private static async Task<bool> IsReadyAsync(string workerRoot)
    {
        var readyPath = Path.Combine(workerRoot, "ready.json");
        if (!File.Exists(readyPath)) return false;
        try
        {
            var ready = JsonSerializer.Deserialize<WorkerReady>(await File.ReadAllTextAsync(readyPath), JsonOptions);
            if (ready is null || DateTimeOffset.UtcNow - ready.HeartbeatUtc > TimeSpan.FromSeconds(15)) return false;
            return Process.GetProcessById(ready.ProcessId).ProcessName.StartsWith("Revit", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }
}

internal sealed record WorkerJob(string Id, string Input, string Output, string Mode, string RevitVersion, DateTimeOffset CreatedUtc);
internal sealed record WorkerResult(string Id, bool Success, string? Error, DateTimeOffset CompletedUtc);
internal sealed record WorkerReady(int ProcessId, string RevitVersion, DateTimeOffset HeartbeatUtc);

internal static class WorkerPaths
{
    public static IReadOnlyList<(string Version, string Executable)> InstalledRevits()
    {
        var found = new Dictionary<string, string>();
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            var name = entry.Key?.ToString() ?? "";
            var match = System.Text.RegularExpressions.Regex.Match(name, @"^REVIT_(20\d{2})_PATH$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            var executable = entry.Value?.ToString();
            if (match.Success && !string.IsNullOrWhiteSpace(executable) && File.Exists(executable)) found[match.Groups[1].Value] = Path.GetFullPath(executable);
        }
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        for (var year = 2019; year <= DateTime.Now.Year + 2; year++)
        {
            var version = year.ToString();
            var executable = Path.Combine(programFiles, "Autodesk", $"Revit {version}", "Revit.exe");
            if (!found.ContainsKey(version) && File.Exists(executable)) found[version] = executable;
        }
        return found.OrderByDescending(item => int.Parse(item.Key)).Select(item => (item.Key, item.Value)).ToArray();
    }

    public static string VersionRoot(string version)
    {
        var configured = Environment.GetEnvironmentVariable("BIM_STUDIO_WORKER_ROOT");
        if (!string.IsNullOrWhiteSpace(configured))
        {
            var configuredRoot = Path.GetFullPath(configured);
            return string.Equals(Path.GetFileName(configuredRoot.TrimEnd(Path.DirectorySeparatorChar)), version, StringComparison.OrdinalIgnoreCase)
                ? configuredRoot
                : Path.Combine(configuredRoot, version);
        }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BimStudio", "RevitWorker", version);
    }

    public static string RevitExecutable(string version)
    {
        var configured = Environment.GetEnvironmentVariable($"REVIT_{version}_PATH");
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Autodesk", $"Revit {version}", "Revit.exe");
    }
}

internal sealed record RevitFileInspection(string? SourceVersion);

internal static class RevitFileInspector
{
    public static RevitFileInspection Inspect(string input)
    {
        var sourcePath = Path.GetFullPath(input);
        if (!File.Exists(sourcePath)) throw new FileNotFoundException("RVT 文件不存在", sourcePath);
        var installation = WorkerPaths.InstalledRevits().FirstOrDefault();
        if (string.IsNullOrWhiteSpace(installation.Executable)) throw new InvalidOperationException("没有检测到可用于读取 RVT 信息的 Revit");
        var revitDirectory = Path.GetDirectoryName(installation.Executable)!;
        AssemblyLoadContext.Default.Resolving += (_, name) =>
        {
            var dependency = Path.Combine(revitDirectory, $"{name.Name}.dll");
            return File.Exists(dependency) ? AssemblyLoadContext.Default.LoadFromAssemblyPath(dependency) : null;
        };
        var api = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(revitDirectory, "RevitAPI.dll"));
        var basicFileInfo = api.GetType("Autodesk.Revit.DB.BasicFileInfo", throwOnError: true)!;
        var extract = basicFileInfo.GetMethod("Extract", BindingFlags.Public | BindingFlags.Static, [typeof(string)])
            ?? throw new MissingMethodException("Revit API 缺少 BasicFileInfo.Extract");
        var info = extract.Invoke(null, [sourcePath]) ?? throw new InvalidDataException("无法读取 RVT 基本信息");
        try
        {
            var format = basicFileInfo.GetProperty("Format")?.GetValue(info)?.ToString();
            var match = System.Text.RegularExpressions.Regex.Match(format ?? "", @"20\d{2}");
            return new RevitFileInspection(match.Success ? match.Value : null);
        }
        finally
        {
            if (info is IDisposable disposable) disposable.Dispose();
        }
    }
}

internal sealed class Arguments
{
    private readonly Dictionary<string, string> _values;
    private Arguments(Dictionary<string, string> values) => _values = values;

    public static Arguments Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index += 2)
        {
            if (!args[index].StartsWith("--", StringComparison.Ordinal) || index + 1 >= args.Length)
                throw new ArgumentException("参数格式应为 --name value");
            values[args[index][2..]] = args[index + 1];
        }
        return new Arguments(values);
    }

    public string Required(string name) => Value(name) ?? throw new ArgumentException($"缺少 --{name}");
    public string? Value(string name) => _values.TryGetValue(name, out var value) ? value : null;
    public int IntValue(string name, int fallback) => int.TryParse(Value(name), out var value) ? value : fallback;
}

internal static class AtomicJson
{
    public static async Task WriteAsync<T>(string path, T value, JsonSerializerOptions options)
    {
        var temporary = path + ".tmp";
        await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(value, options));
        File.Move(temporary, path, true);
    }
}
