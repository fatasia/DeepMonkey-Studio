using System.IO;
using System.Linq;
using BimStudio.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace BimStudio.Bridge.Editor
{
    [CustomEditor(typeof(BimStudioManifestAsset))]
    public sealed class BimStudioManifestAssetEditor : UnityEditor.Editor
    {
        private bool showEvents = true;
        private bool showActions = true;
        private bool showLayers = true;
        private bool showObjects = true;
        private bool showProperties = true;

        public override void OnInspectorGUI()
        {
            serializedObject.Update();
            var manifest = (BimStudioManifestAsset)target;
            var validation = BimStudioManifestValidator.Validate(manifest);

            EditorGUILayout.Space(4);
            EditorGUILayout.LabelField("Industrial Studio · Unity WebGL 集成清单", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("在这里声明稳定的业务标识。平台将据此生成场景、事件、数据层、对象、动作和属性配置。", MessageType.Info);
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("创建 / 修复通信桥")) BimStudioProjectSetup.EnsureBridgeObject();
                if (GUILayout.Button("从场景自动同步")) BimStudioManifestSynchronizer.Synchronize(manifest);
                if (GUILayout.Button("立即校验")) LogValidation(validation);
            }
            if (GUILayout.Button("一键准备、构建并导出 WebGL ZIP", GUILayout.Height(28)))
                BimStudioWebGLPackageExporter.BuildAndExport();
            using (new EditorGUI.DisabledScope(Selection.activeGameObject == null))
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("添加数据 / 属性绑定")) AddBinding<BimStudioValueBinding>();
                if (GUILayout.Button("添加动作绑定")) AddBinding<BimStudioActionBinding>();
            }
            using (new EditorGUI.DisabledScope(Selection.activeGameObject == null))
                if (GUILayout.Button("添加事件回传（按钮 / 碰撞 / 动画事件）")) AddBinding<BimStudioEventEmitter>();
            if (Selection.activeGameObject == null)
                EditorGUILayout.HelpBox("选择一个场景对象后，即可添加无代码绑定。", MessageType.Info);

            DrawValidation(validation);
            DrawSection("Unity 发出的事件", "events", ref showEvents);
            DrawSection("平台下发的动作", "actions", ref showActions);
            DrawSection("数据层", "dataLayers", ref showLayers);
            DrawSection("业务对象", "objects", ref showObjects);
            DrawSection("可配置属性", "properties", ref showProperties);
            serializedObject.ApplyModifiedProperties();
        }

        private void DrawSection(string label, string propertyName, ref bool expanded)
        {
            var property = serializedObject.FindProperty(propertyName);
            EditorGUILayout.Space(3);
            expanded = EditorGUILayout.Foldout(expanded, $"{label} ({property.arraySize})", true);
            if (expanded) EditorGUILayout.PropertyField(property, GUIContent.none, true);
        }

        private static void DrawValidation(BimStudioManifestValidation validation)
        {
            foreach (var error in validation.errors) EditorGUILayout.HelpBox(error, MessageType.Error);
            foreach (var warning in validation.warnings) EditorGUILayout.HelpBox(warning, MessageType.Warning);
            if (validation.errors.Count == 0 && validation.warnings.Count == 0) EditorGUILayout.HelpBox("集成清单已通过 Industrial Studio 发布校验。", MessageType.Info);
        }

        private static void LogValidation(BimStudioManifestValidation validation)
        {
            foreach (var error in validation.errors) Debug.LogError($"[Industrial Studio Manifest] {error}");
            foreach (var warning in validation.warnings) Debug.LogWarning($"[Industrial Studio Manifest] {warning}");
            if (validation.IsValid) Debug.Log("[Industrial Studio 集成清单] 校验通过。");
        }

        private static void AddBinding<T>() where T : Component
        {
            var gameObject = Selection.activeGameObject;
            if (gameObject == null) return;
            var binding = Undo.AddComponent<T>(gameObject);
            Selection.activeObject = binding;
            EditorGUIUtility.PingObject(binding);
        }
    }

    public static class BimStudioProjectSetup
    {
        private const string ManifestPath = "Assets/Resources/BimStudioManifest.asset";

        [MenuItem("Industrial Studio/准备项目（通信桥与集成清单）", priority = 1)]
        public static void Setup()
        {
            EnsureBridgeObject();
            var manifest = EnsureManifest();
            Selection.activeObject = manifest;
            EditorGUIUtility.PingObject(manifest);
        }

        public static BimStudioManifestAsset EnsureManifest()
        {
            var manifest = AssetDatabase.LoadAssetAtPath<BimStudioManifestAsset>(ManifestPath);
            if (manifest != null) return manifest;

            Directory.CreateDirectory("Assets/Resources");
            manifest = ScriptableObject.CreateInstance<BimStudioManifestAsset>();
            AssetDatabase.CreateAsset(manifest, ManifestPath);
            AssetDatabase.SaveAssets();
            return manifest;
        }

        public static bool PrepareForExport(out BimStudioManifestAsset manifest, out string error)
        {
            manifest = null;
            error = string.Empty;
            if (!BuildPipeline.IsBuildTargetSupported(BuildTargetGroup.WebGL, BuildTarget.WebGL))
            {
                error = "当前 Unity 编辑器未安装 WebGL Build Support，请先通过 Unity Hub 补装该模块。";
                return false;
            }

            EnsureBridgeObject();
            manifest = EnsureManifest();
            if (!EnsureActiveSceneInBuildSettings(out error)) return false;
            return true;
        }

        public static bool EnsureActiveSceneInBuildSettings(out string error)
        {
            error = string.Empty;
            var activeScene = SceneManager.GetActiveScene();
            if (!activeScene.IsValid() || !activeScene.isLoaded)
            {
                error = "请先打开要导出的场景，然后重试。";
                return false;
            }

            if (string.IsNullOrWhiteSpace(activeScene.path))
            {
                if (Application.isBatchMode)
                {
                    error = "批处理导出前必须先保存当前场景。";
                    return false;
                }
                var scenePath = EditorUtility.SaveFilePanelInProject(
                    "保存要导出到 Industrial Studio 的场景",
                    string.IsNullOrWhiteSpace(activeScene.name) ? "BimStudioScene" : activeScene.name,
                    "unity",
                    "导出 WebGL 前需要先保存当前场景。");
                if (string.IsNullOrWhiteSpace(scenePath))
                {
                    error = "已取消保存场景。";
                    return false;
                }
                if (!EditorSceneManager.SaveScene(activeScene, scenePath))
                {
                    error = "Unity 无法保存当前场景。";
                    return false;
                }
                activeScene = SceneManager.GetActiveScene();
            }
            else if (activeScene.isDirty && Application.isBatchMode && !EditorSceneManager.SaveScene(activeScene))
            {
                error = "批处理导出前，Unity 无法保存当前场景。";
                return false;
            }
            else if (activeScene.isDirty && !Application.isBatchMode && !EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo())
            {
                error = "已取消保存场景。";
                return false;
            }

            var scenes = EditorBuildSettings.scenes.ToList();
            var sceneIndex = scenes.FindIndex(scene => string.Equals(scene.path, activeScene.path, System.StringComparison.OrdinalIgnoreCase));
            if (sceneIndex >= 0)
            {
                if (!scenes[sceneIndex].enabled) scenes[sceneIndex] = new EditorBuildSettingsScene(activeScene.path, true);
            }
            else
            {
                scenes.Add(new EditorBuildSettingsScene(activeScene.path, true));
            }
            EditorBuildSettings.scenes = scenes.ToArray();
            return true;
        }

        public static void EnsureBridgeObject()
        {
            var bridge = FindBridge();
            if (bridge == null)
            {
                var gameObject = new GameObject("BimStudioBridge");
                bridge = Undo.AddComponent<BimStudioBridge>(gameObject);
                Undo.RegisterCreatedObjectUndo(gameObject, "Create Industrial Studio Bridge");
                EditorSceneManager.MarkSceneDirty(gameObject.scene);
            }
            else if (bridge.gameObject.name != "BimStudioBridge")
            {
                Undo.RecordObject(bridge.gameObject, "Rename Industrial Studio Bridge");
                bridge.gameObject.name = "BimStudioBridge";
                EditorSceneManager.MarkSceneDirty(bridge.gameObject.scene);
            }
            Selection.activeGameObject = bridge.gameObject;
            EditorGUIUtility.PingObject(bridge.gameObject);
        }

        private static BimStudioBridge FindBridge()
        {
#if UNITY_2023_1_OR_NEWER
            return Object.FindFirstObjectByType<BimStudioBridge>();
#else
            return Object.FindObjectOfType<BimStudioBridge>();
#endif
        }
    }
}
