using System;
using System.Collections.Generic;
using System.Linq;
using BimStudio.Bridge;
using UnityEditor;
using UnityEngine;

namespace BimStudio.Bridge.Editor
{
    public static class BimStudioBindingEditorUtility
    {
        public const string ManifestPath = "Assets/Resources/BimStudioManifest.asset";

        public static BimStudioManifestAsset LoadManifest()
        {
            return AssetDatabase.LoadAssetAtPath<BimStudioManifestAsset>(ManifestPath);
        }

        public static void DrawManifestLink(BimStudioManifestAsset manifest)
        {
            if (manifest == null)
            {
                EditorGUILayout.HelpBox("未找到 Industrial Studio 集成清单，请先准备项目。", MessageType.Warning);
                if (GUILayout.Button("准备通信桥与集成清单")) BimStudioProjectSetup.Setup();
                return;
            }

            using (new EditorGUILayout.HorizontalScope())
            {
                EditorGUILayout.PrefixLabel("集成清单");
                if (GUILayout.Button(manifest.name, EditorStyles.objectField))
                {
                    Selection.activeObject = manifest;
                    EditorGUIUtility.PingObject(manifest);
                }
            }
        }

        public static void DrawChoice(SerializedProperty property, string label, string[] values, string emptyMessage, bool includeEmpty = false)
        {
            var choices = includeEmpty ? new[] { "（任意对象）" }.Concat(values).ToArray() : values;
            if (choices.Length == 0)
            {
                EditorGUILayout.HelpBox(emptyMessage, MessageType.Warning);
                EditorGUILayout.PropertyField(property, new GUIContent(label));
                return;
            }

            var offset = includeEmpty ? 1 : 0;
            var currentIndex = Array.IndexOf(values, property.stringValue);
            var current = currentIndex < 0 ? 0 : currentIndex + offset;
            var selected = EditorGUILayout.Popup(label, current, choices);
            property.stringValue = includeEmpty && selected == 0 ? string.Empty : values[Math.Max(0, selected - offset)];
        }

        internal static string AddDataLayer(BimStudioManifestAsset manifest, string rawKey, GameObject owner)
        {
            var key = RequireIdentifier(rawKey);
            var existing = manifest.dataLayers.FirstOrDefault(item => string.Equals(item?.key?.Trim(), key, StringComparison.Ordinal));
            if (existing != null) return existing.key.Trim();
            Undo.RecordObject(manifest, "Add Industrial Studio data layer");
            manifest.dataLayers = (manifest.dataLayers ?? Array.Empty<BimStudioDataLayer>()).Concat(new[] { new BimStudioDataLayer
            {
                key = key,
                description = owner != null ? owner.name : string.Empty,
                target = nameof(BimStudioValueBinding)
            } }).ToArray();
            SaveManifest(manifest);
            return key;
        }

        public static string AddProperty(BimStudioManifestAsset manifest, string rawKey, GameObject owner)
        {
            var key = RequireIdentifier(rawKey);
            var existing = manifest.properties.FirstOrDefault(item => string.Equals(item?.key?.Trim(), key, StringComparison.Ordinal));
            if (existing != null) return existing.key.Trim();
            Undo.RecordObject(manifest, "Add Industrial Studio property");
            manifest.properties = (manifest.properties ?? Array.Empty<BimStudioProperty>()).Concat(new[] { new BimStudioProperty
            {
                key = key,
                label = key,
                type = "string"
            } }).ToArray();
            SaveManifest(manifest);
            return key;
        }

        internal static string AddAction(BimStudioManifestAsset manifest, string rawName)
        {
            var name = RequireIdentifier(rawName);
            if ((manifest.actions ?? Array.Empty<string>()).Any(item => string.Equals(item?.Trim(), name, StringComparison.Ordinal))) return name;
            Undo.RecordObject(manifest, "Add Industrial Studio action");
            manifest.actions = (manifest.actions ?? Array.Empty<string>()).Concat(new[] { name }).ToArray();
            SaveManifest(manifest);
            return name;
        }

        public static string AddEvent(BimStudioManifestAsset manifest, string rawName)
        {
            var name = RequireIdentifier(rawName);
            if ((manifest.events ?? Array.Empty<string>()).Any(item => string.Equals(item?.Trim(), name, StringComparison.Ordinal))) return name;
            Undo.RecordObject(manifest, "Add Industrial Studio event");
            manifest.events = (manifest.events ?? Array.Empty<string>()).Concat(new[] { name }).ToArray();
            SaveManifest(manifest);
            return name;
        }

        internal static string RegisterObject(BimStudioManifestAsset manifest, GameObject gameObject)
        {
            if (gameObject == null) throw new InvalidOperationException("请先选择一个场景对象。");
            var path = ScenePath(gameObject.transform);
            var existing = (manifest.objects ?? Array.Empty<BimStudioObject>()).FirstOrDefault(item => string.Equals(item?.path, path, StringComparison.Ordinal));
            if (existing != null && !string.IsNullOrWhiteSpace(existing.id)) return existing.id.Trim();
            var ids = new HashSet<string>((manifest.objects ?? Array.Empty<BimStudioObject>()).Select(item => item?.id).Where(item => !string.IsNullOrWhiteSpace(item)), StringComparer.Ordinal);
            var stem = RequireIdentifier(gameObject.name).Replace("/", "-");
            var id = stem;
            for (var suffix = 2; ids.Contains(id); suffix++) id = stem + "-" + suffix;
            Undo.RecordObject(manifest, "Register Industrial Studio object");
            manifest.objects = (manifest.objects ?? Array.Empty<BimStudioObject>()).Concat(new[] { new BimStudioObject { id = id, name = gameObject.name, path = path } }).ToArray();
            SaveManifest(manifest);
            return id;
        }

        private static string ScenePath(Transform transform)
        {
            var names = new System.Collections.Generic.List<string>();
            for (var current = transform; current != null; current = current.parent) names.Add(current.name);
            names.Reverse();
            return transform.gameObject.scene.name + "/" + string.Join("/", names);
        }

        private static string RequireIdentifier(string value)
        {
            var normalized = (value ?? string.Empty).Trim();
            if (normalized.Length == 0) throw new InvalidOperationException("标识不能为空。");
            return normalized;
        }

        private static void SaveManifest(BimStudioManifestAsset manifest)
        {
            EditorUtility.SetDirty(manifest);
            AssetDatabase.SaveAssets();
        }
    }

    [CustomEditor(typeof(BimStudioValueBinding))]
    public sealed class BimStudioValueBindingEditor : UnityEditor.Editor
    {
        private string newKey = string.Empty;

        public override void OnInspectorGUI()
        {
            serializedObject.Update();
            var manifest = BimStudioBindingEditorUtility.LoadManifest();
            BimStudioBindingEditorUtility.DrawManifestLink(manifest);

            var source = serializedObject.FindProperty("source");
            var key = serializedObject.FindProperty("key");
            var target = serializedObject.FindProperty("target");
            source.enumValueIndex = EditorGUILayout.Popup("监听来源", source.enumValueIndex, new[] { "数据层", "可配置属性" });

            var sourceValue = (BimStudioValueSource)source.enumValueIndex;
            var keys = sourceValue == BimStudioValueSource.DataLayer
                ? manifest?.dataLayers?.Select(item => item.key).Where(value => !string.IsNullOrWhiteSpace(value)).ToArray() ?? Array.Empty<string>()
                : manifest?.properties?.Select(item => item.key).Where(value => !string.IsNullOrWhiteSpace(value)).ToArray() ?? Array.Empty<string>();
            BimStudioBindingEditorUtility.DrawChoice(key, sourceValue == BimStudioValueSource.DataLayer ? "数据层" : "可配置属性", keys, "请先在集成清单中声明标识，再在这里选择。");
            if (manifest != null)
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    newKey = EditorGUILayout.TextField("快速新建标识", newKey);
                    using (new EditorGUI.DisabledScope(string.IsNullOrWhiteSpace(newKey)))
                    {
                        if (GUILayout.Button("新建并选中", GUILayout.Width(86)))
                        {
                            key.stringValue = sourceValue == BimStudioValueSource.DataLayer
                                ? BimStudioBindingEditorUtility.AddDataLayer(manifest, newKey, ((BimStudioValueBinding)base.target).gameObject)
                                : BimStudioBindingEditorUtility.AddProperty(manifest, newKey, ((BimStudioValueBinding)base.target).gameObject);
                            newKey = string.Empty;
                        }
                    }
                }
            }

            EditorGUILayout.Space(4);
            target.enumValueIndex = EditorGUILayout.Popup("更新目标", target.enumValueIndex, new[]
            {
                "对象显示 / 隐藏", "Animator 浮点参数", "Animator 布尔参数", "Animator 触发器",
                "材质浮点属性", "材质颜色", "位置 X", "位置 Y", "位置 Z", "旋转 X", "旋转 Y", "旋转 Z",
                "缩放 X", "缩放 Y", "缩放 Z", "相机视野角", "正交相机尺寸",
                "灯光启用", "灯光强度", "灯光颜色", "灯光范围", "聚光灯角度", "触发 UnityEvent"
            });
            var targetValue = (BimStudioValueTarget)target.enumValueIndex;
            if (targetValue != BimStudioValueTarget.InvokeEvent)
                EditorGUILayout.PropertyField(serializedObject.FindProperty("targetObject"), new GUIContent("目标对象"));
            if (targetValue == BimStudioValueTarget.AnimatorFloat || targetValue == BimStudioValueTarget.AnimatorBool || targetValue == BimStudioValueTarget.AnimatorTrigger)
            {
                EditorGUILayout.PropertyField(serializedObject.FindProperty("animator"), new GUIContent("Animator 组件"));
                EditorGUILayout.PropertyField(serializedObject.FindProperty("parameter"), new GUIContent("Animator 参数"));
            }
            if (targetValue == BimStudioValueTarget.MaterialFloat || targetValue == BimStudioValueTarget.MaterialColor)
            {
                EditorGUILayout.PropertyField(serializedObject.FindProperty("targetRenderer"), new GUIContent("渲染器"));
                EditorGUILayout.PropertyField(serializedObject.FindProperty("parameter"), new GUIContent("Shader 属性"));
            }
            if (targetValue == BimStudioValueTarget.CameraFieldOfView || targetValue == BimStudioValueTarget.CameraOrthographicSize)
                EditorGUILayout.PropertyField(serializedObject.FindProperty("targetCamera"), new GUIContent("相机组件"));
            if (targetValue == BimStudioValueTarget.LightEnabled || targetValue == BimStudioValueTarget.LightIntensity || targetValue == BimStudioValueTarget.LightColor || targetValue == BimStudioValueTarget.LightRange || targetValue == BimStudioValueTarget.LightSpotAngle)
                EditorGUILayout.PropertyField(serializedObject.FindProperty("targetLight"), new GUIContent("灯光组件"));
            if (targetValue == BimStudioValueTarget.InvokeEvent)
                EditorGUILayout.PropertyField(serializedObject.FindProperty("onValue"), new GUIContent("收到数据时"));

            if (string.IsNullOrWhiteSpace(key.stringValue))
                EditorGUILayout.HelpBox("构建 WebGL 前请选择集成清单中的标识。", MessageType.Error);
            serializedObject.ApplyModifiedProperties();
        }
    }

    [CustomEditor(typeof(BimStudioActionBinding))]
    public sealed class BimStudioActionBindingEditor : UnityEditor.Editor
    {
        private string newAction = string.Empty;

        public override void OnInspectorGUI()
        {
            serializedObject.Update();
            var manifest = BimStudioBindingEditorUtility.LoadManifest();
            BimStudioBindingEditorUtility.DrawManifestLink(manifest);
            var actions = manifest?.actions?.Where(value => !string.IsNullOrWhiteSpace(value)).ToArray() ?? Array.Empty<string>();
            var objects = manifest?.objects?.Where(value => !string.IsNullOrWhiteSpace(value.id)).Select(value => value.id).ToArray() ?? Array.Empty<string>();
            var action = serializedObject.FindProperty("action");
            BimStudioBindingEditorUtility.DrawChoice(action, "平台动作", actions, "请先在集成清单中声明平台动作，再在这里选择。");
            if (manifest != null)
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    newAction = EditorGUILayout.TextField("快速新建动作", newAction);
                    using (new EditorGUI.DisabledScope(string.IsNullOrWhiteSpace(newAction)))
                        if (GUILayout.Button("新建并选中", GUILayout.Width(86))) { action.stringValue = BimStudioBindingEditorUtility.AddAction(manifest, newAction); newAction = string.Empty; }
                }
            }
            var objectId = serializedObject.FindProperty("objectId");
            BimStudioBindingEditorUtility.DrawChoice(objectId, "业务对象", objects, "未声明业务对象；留空时接收全局动作。", true);
            if (manifest != null && GUILayout.Button("将当前 GameObject 注册为业务对象"))
                objectId.stringValue = BimStudioBindingEditorUtility.RegisterObject(manifest, ((BimStudioActionBinding)target).gameObject);
            EditorGUILayout.PropertyField(serializedObject.FindProperty("onTriggered"), new GUIContent("收到动作时"));
            if (string.IsNullOrWhiteSpace(action.stringValue))
                EditorGUILayout.HelpBox("构建 WebGL 前请选择集成清单中的平台动作。", MessageType.Error);
            serializedObject.ApplyModifiedProperties();
        }
    }

    [CustomEditor(typeof(BimStudioEventEmitter))]
    public sealed class BimStudioEventEmitterEditor : UnityEditor.Editor
    {
        private string newEvent = string.Empty;

        public override void OnInspectorGUI()
        {
            serializedObject.Update();
            var manifest = BimStudioBindingEditorUtility.LoadManifest();
            BimStudioBindingEditorUtility.DrawManifestLink(manifest);
            var eventName = serializedObject.FindProperty("eventName");
            var events = manifest?.events?.Where(value => !string.IsNullOrWhiteSpace(value)).ToArray() ?? Array.Empty<string>();
            BimStudioBindingEditorUtility.DrawChoice(eventName, "回传事件", events, "请先新建一个 Unity 回传事件。", false);
            if (manifest != null)
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    newEvent = EditorGUILayout.TextField("快速新建事件", newEvent);
                    using (new EditorGUI.DisabledScope(string.IsNullOrWhiteSpace(newEvent)))
                        if (GUILayout.Button("新建并选中", GUILayout.Width(86))) { eventName.stringValue = BimStudioBindingEditorUtility.AddEvent(manifest, newEvent); newEvent = string.Empty; }
                }
            }
            EditorGUILayout.PropertyField(serializedObject.FindProperty("payloadJson"), new GUIContent("事件数据 JSON"));
            EditorGUILayout.HelpBox("将本组件的 Emit() 连接到 Button、Collider、动画事件或任意 UnityEvent，即可把事件回传 Industrial Studio；不需要编写脚本。", MessageType.Info);
            if (string.IsNullOrWhiteSpace(eventName.stringValue)) EditorGUILayout.HelpBox("构建 WebGL 前请选择回传事件。", MessageType.Error);
            serializedObject.ApplyModifiedProperties();
        }
    }
}
