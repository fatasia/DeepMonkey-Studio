(function () {
  "use strict";
  var VERSION = 1;
  var unityInstance;
  var receiverObject = "BimStudioBridge";
  var widgetId = "";
  var parentOrigin = "*";

  function emit(type, detail) {
    var message = Object.assign({ source: "unity-webgl", version: VERSION, type: type, widgetId: widgetId, emittedAt: Date.now() }, detail || {});
    window.parent.postMessage(message, parentOrigin);
  }

  function forward(message) {
    if (!unityInstance || typeof unityInstance.SendMessage !== "function") return;
    unityInstance.SendMessage(receiverObject, "ApplyStudioMessage", JSON.stringify(message));
    var payload = message && message.payload;
    var layers = message.type === "dataLayers" ? payload : message.type === "init" && payload ? payload.dataLayers : null;
    var properties = message.type === "properties" ? payload : message.type === "init" && payload ? payload.properties : null;
    forwardKeyValues("ApplyDataLayer", layers);
    forwardKeyValues("ApplyProperty", properties);
  }

  function forwardKeyValues(method, values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) return;
    Object.keys(values).forEach(function (key) {
      unityInstance.SendMessage(receiverObject, method, JSON.stringify({ key: key, valueJson: JSON.stringify(values[key]) }));
    });
  }

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (event.source !== window.parent || !message || message.source !== "bim-studio" || message.version !== VERSION) return;
    parentOrigin = event.origin || parentOrigin;
    widgetId = message.widgetId || widgetId;
    forward(message);
  });

  window.BimStudioUnityBridge = {
    register: function (instance, objectName) {
      unityInstance = instance;
      receiverObject = objectName || receiverObject;
      emit("ready");
    },
    emit: function (eventName, payload) {
      emit("event", { eventName: eventName, payload: payload === undefined ? null : payload });
    },
    error: function (message) {
      emit("error", { message: String(message || "Unity runtime error") });
    },
    ack: function (messageId, messageType) {
      emit("ack", { messageId: String(messageId || ""), messageType: String(messageType || "") });
    },
    health: function (messageId, fps, scene) {
      emit("health", { messageId: String(messageId || ""), fps: Number(fps || 0), scene: String(scene || "") });
    },
    capabilities: function (values) {
      emit("capabilities", { capabilities: Array.isArray(values) ? values : [] });
    }
  };
})();
