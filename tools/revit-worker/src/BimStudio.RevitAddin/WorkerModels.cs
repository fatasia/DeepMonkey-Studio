using System.Text.Json;

namespace BimStudio.RevitAddin;

internal sealed record WorkerJob(string Id, string Input, string Output, string Mode, string RevitVersion, DateTimeOffset CreatedUtc);
internal sealed record WorkerResult(string Id, bool Success, string? Error, DateTimeOffset CompletedUtc);
internal sealed record WorkerReady(int ProcessId, string RevitVersion, DateTimeOffset HeartbeatUtc);

internal static class JsonFiles
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static T Read<T>(string path) => JsonSerializer.Deserialize<T>(File.ReadAllText(path), Options)
        ?? throw new InvalidDataException($"JSON 文件无效：{path}");

    public static void WriteAtomic<T>(string path, T value)
    {
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(value, Options));
        if (File.Exists(path)) File.Delete(path);
        File.Move(temporary, path);
    }
}
