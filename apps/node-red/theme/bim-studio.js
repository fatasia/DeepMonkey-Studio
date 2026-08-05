(function bootstrapBimStudioEditor() {
  function initialize() {
    if (!window.RED?.events || !window.RED?.actions || !window.RED?.workspaces) {
      window.setTimeout(initialize, 120);
      return;
    }
    let initialized = false;
    const showExampleAndFit = () => {
      if (initialized) return;
      initialized = true;
      try { window.RED.workspaces.show("example-td-tab"); } catch { /* flow may not exist yet */ }
      window.setTimeout(() => {
        try { window.RED.actions.invoke("core:zoom-fit"); } catch { document.querySelector("#red-ui-view-zoom-fit")?.click(); }
      }, 260);
    };
    window.RED.events.on("flows:loaded", showExampleAndFit);
    window.setTimeout(showExampleAndFit, 1000);
  }
  window.addEventListener("load", initialize, { once: true });
})();
