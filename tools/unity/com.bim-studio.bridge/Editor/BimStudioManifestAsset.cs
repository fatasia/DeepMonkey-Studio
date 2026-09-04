using System;
using UnityEngine;

namespace BimStudio.Bridge.Editor
{
    [Serializable] public sealed class BimStudioManifest
    {
        public int schemaVersion = 1;
        public int bridgeVersion = 1;
        public string playerUrl = "index.html";
        public string unityVersion = Application.unityVersion;
        public string bridgePackageVersion = "0.6.1";
        public string[] scenes = Array.Empty<string>();
        public string[] events = Array.Empty<string>();
        public string[] actions = Array.Empty<string>();
        public BimStudioDataLayer[] dataLayers = Array.Empty<BimStudioDataLayer>();
        public BimStudioObject[] objects = Array.Empty<BimStudioObject>();
        public BimStudioProperty[] properties = Array.Empty<BimStudioProperty>();
        public string[] runtimeCapabilities = { "ack", "heartbeat", "data-layers", "properties", "actions", "events" };
    }

    [Serializable] public sealed class BimStudioDataLayer
    {
        [InspectorName("数据层标识")] public string key;
        [InspectorName("说明")] public string description;
        [InspectorName("主键字段")] public string keyField;
        [InspectorName("Unity 目标适配器")] public string target;
    }
    [Serializable] public sealed class BimStudioObject
    {
        [InspectorName("稳定 ID")] public string id;
        [InspectorName("显示名称")] public string name;
        [InspectorName("场景路径")] public string path;
        [InspectorName("标签")] public string[] tags = Array.Empty<string>();
    }
    [Serializable] public sealed class BimStudioProperty
    {
        [InspectorName("属性标识")] public string key;
        [InspectorName("显示名称")] public string label;
        [InspectorName("类型（string / number / boolean / color / select）")] public string type = "string";
        [InspectorName("业务对象 ID")] public string target;
        [InspectorName("可选项") ] public string[] options = Array.Empty<string>();
    }

    [CreateAssetMenu(fileName = "BimStudioManifest", menuName = "Deep Monkey Studio/Unity WebGL 集成清单")]
    public sealed class BimStudioManifestAsset : ScriptableObject
    {
        public string[] events = Array.Empty<string>();
        public string[] actions = Array.Empty<string>();
        public BimStudioDataLayer[] dataLayers = Array.Empty<BimStudioDataLayer>();
        public BimStudioObject[] objects = Array.Empty<BimStudioObject>();
        public BimStudioProperty[] properties = Array.Empty<BimStudioProperty>();
    }
}
