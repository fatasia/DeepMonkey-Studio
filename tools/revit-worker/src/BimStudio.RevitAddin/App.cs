using System.Diagnostics;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;

namespace BimStudio.RevitAddin;

public sealed class App : IExternalApplication
{
    private string _workerRoot = "";
    private string _version = "";
    private System.Threading.Timer? _heartbeatTimer;
    private ExternalEvent? _jobEvent;
    private volatile bool _processing;

    public Result OnStartup(UIControlledApplication application)
    {
        _version = application.ControlledApplication.VersionNumber;
        var configuredRoot = Environment.GetEnvironmentVariable("BIM_STUDIO_WORKER_ROOT");
        if (string.IsNullOrWhiteSpace(configuredRoot))
        {
            var installationDirectory = Path.GetDirectoryName(typeof(App).Assembly.Location) ?? "";
            var rootConfiguration = Path.Combine(installationDirectory, "worker-root.txt");
            if (File.Exists(rootConfiguration)) configuredRoot = File.ReadAllText(rootConfiguration).Trim();
        }
        if (string.IsNullOrWhiteSpace(configuredRoot))
        {
            _workerRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BimStudio", "RevitWorker", _version);
        }
        else
        {
            var configuredPath = Path.GetFullPath(configuredRoot);
            _workerRoot = string.Equals(Path.GetFileName(configuredPath.TrimEnd(Path.DirectorySeparatorChar)), _version, StringComparison.OrdinalIgnoreCase)
                ? configuredPath
                : Path.Combine(configuredPath, _version);
        }
        Directory.CreateDirectory(Path.Combine(_workerRoot, "jobs"));
        Directory.CreateDirectory(Path.Combine(_workerRoot, "results"));
        RecoverInterruptedJobs();
        _jobEvent = ExternalEvent.Create(new JobExternalEventHandler(ProcessNextJob));
        _heartbeatTimer = new System.Threading.Timer(
            _ => OnWorkerTimer(),
            null,
            TimeSpan.Zero,
            TimeSpan.FromSeconds(2));
        application.DialogBoxShowing += OnDialogBoxShowing;
        return Result.Succeeded;
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        application.DialogBoxShowing -= OnDialogBoxShowing;
        _heartbeatTimer?.Dispose();
        _heartbeatTimer = null;
        _jobEvent?.Dispose();
        _jobEvent = null;
        return Result.Succeeded;
    }

    private void OnWorkerTimer()
    {
        WriteHeartbeat();
        if (_processing || _jobEvent is null) return;
        try
        {
            if (Directory.EnumerateFiles(Path.Combine(_workerRoot, "jobs"), "*.job.json").Any())
            {
                _jobEvent.Raise();
            }
        }
        catch (IOException)
        {
            // A worker may be atomically publishing or claiming the next job.
        }
        catch (ObjectDisposedException)
        {
            // Revit is shutting down while the timer callback is finishing.
        }
    }

    private void WriteHeartbeat()
    {
        try
        {
            JsonFiles.WriteAtomic(
                Path.Combine(_workerRoot, "ready.json"),
                new WorkerReady(Process.GetCurrentProcess().Id, _version, DateTimeOffset.UtcNow));
        }
        catch (IOException)
        {
            // Another Revit instance may briefly own the atomic heartbeat file.
        }
    }

    private void RecoverInterruptedJobs()
    {
        var jobsDirectory = Path.Combine(_workerRoot, "jobs");
        foreach (var processingPath in Directory.EnumerateFiles(jobsDirectory, "*.processing.json"))
        {
            var jobPath = processingPath.Replace(".processing.json", ".job.json");
            if (!File.Exists(jobPath)) File.Move(processingPath, jobPath);
        }
    }

    private void OnDialogBoxShowing(object? sender, DialogBoxShowingEventArgs eventArgs)
    {
        if (!_processing) return;
        if (eventArgs.DialogId == "TaskDialog_Views_Related_To_Analytical_Changed")
        {
            eventArgs.OverrideResult((int)TaskDialogResult.Close);
        }
    }

    private void ProcessNextJob(UIApplication uiApplication)
    {
        if (_processing) return;
        var jobPath = Directory.EnumerateFiles(Path.Combine(_workerRoot, "jobs"), "*.job.json")
            .OrderBy(File.GetCreationTimeUtc)
            .FirstOrDefault();
        if (jobPath is null) return;
        ProcessJob(uiApplication, jobPath);
    }

    private void ProcessJob(UIApplication uiApplication, string jobPath)
    {
        _processing = true;
        WorkerJob? job = null;
        var processingPath = jobPath.Replace(".job.json", ".processing.json");
        try
        {
            File.Move(jobPath, processingPath);
        }
        catch (IOException)
        {
            _processing = false;
            return;
        }
        try
        {
            job = JsonFiles.Read<WorkerJob>(processingPath);
            if (!string.Equals(job.RevitVersion, _version, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"作业需要 Revit {job.RevitVersion}，当前常驻进程是 {_version}");
            Directory.CreateDirectory(job.Output);
            Export(uiApplication, job);
            WriteResult(job, true, null);
        }
        catch (Exception exception)
        {
            if (job is not null) WriteResult(job, false, exception.ToString());
            else File.WriteAllText(processingPath + ".error.txt", exception.ToString());
        }
        finally
        {
            if (File.Exists(processingPath)) File.Delete(processingPath);
            _processing = false;
        }
    }

    private static void Export(UIApplication uiApplication, WorkerJob job)
    {
        var openOptions = new OpenOptions();
        try
        {
            openOptions.SetOpenWorksetsConfiguration(new WorksetConfiguration(WorksetConfigurationOption.CloseAllWorksets));
        }
        catch
        {
            // Non-workshared models do not need a workset configuration.
        }
        Document? document = null;
        try
        {
            var modelPath = ModelPathUtils.ConvertUserVisiblePathToModelPath(job.Input);
            document = uiApplication.Application.OpenDocumentFile(modelPath, openOptions);
            if (job.Mode == "ifc")
            {
                IfcJobExporter.Export(document, job.Output);
            }
            else if (job.Mode == "native-glb")
            {
                NativeGlbJobExporter.Export(document, job.Output);
            }
            else
            {
                throw new ArgumentException($"未知转换模式：{job.Mode}");
            }
        }
        finally
        {
            document?.Close(false);
        }
    }

    private void WriteResult(WorkerJob job, bool success, string? error)
    {
        var path = Path.Combine(_workerRoot, "results", $"{job.Id}.result.json");
        JsonFiles.WriteAtomic(path, new WorkerResult(job.Id, success, error, DateTimeOffset.UtcNow));
    }
}

internal sealed class JobExternalEventHandler : IExternalEventHandler
{
    private readonly Action<UIApplication> _execute;

    public JobExternalEventHandler(Action<UIApplication> execute) => _execute = execute;

    public void Execute(UIApplication application) => _execute(application);

    public string GetName() => "Deep Monkey Studio persistent conversion queue";
}
