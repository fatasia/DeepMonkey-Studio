(function bootstrapBimStudioEditor() {
  const FIT_DELAY_MS = 180;
  let fitTimer;
  let centerTimer;

  function centerActiveFlow() {
    const chart = document.querySelector("#red-ui-workspace-chart");
    if (!chart) return;

    const chartRect = chart.getBoundingClientRect();
    const sidebarRect = document.querySelector("#red-ui-sidebar")?.getBoundingClientRect();
    const viewportRight = sidebarRect && sidebarRect.width > 0
      ? Math.min(chartRect.right, sidebarRect.left)
      : chartRect.right;
    const nodes = [...document.querySelectorAll("g.red-ui-flow-node")]
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (!nodes.length || viewportRight <= chartRect.left) return;

    const nodeBounds = nodes.reduce((bounds, rect) => ({
      left: Math.min(bounds.left, rect.left),
      top: Math.min(bounds.top, rect.top),
      right: Math.max(bounds.right, rect.right),
      bottom: Math.max(bounds.bottom, rect.bottom)
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const nodeCenterX = (nodeBounds.left + nodeBounds.right) / 2;
    const nodeCenterY = (nodeBounds.top + nodeBounds.bottom) / 2;
    const viewportCenterX = (chartRect.left + viewportRight) / 2;
    const viewportCenterY = (chartRect.top + chartRect.bottom) / 2;

    chart.scrollLeft += nodeCenterX - viewportCenterX;
    chart.scrollTop += nodeCenterY - viewportCenterY;
  }

  function fitActiveFlow() {
    window.clearTimeout(fitTimer);
    window.clearTimeout(centerTimer);
    fitTimer = window.setTimeout(() => {
      try {
        window.RED.actions.invoke("core:zoom-fit");
      } catch {
        document.querySelector("#red-ui-view-zoom-fit")?.click();
      }
    }, FIT_DELAY_MS);
    centerTimer = window.setTimeout(centerActiveFlow, FIT_DELAY_MS + 520);
  }

  function installCanvasPanning() {
    const chart = document.querySelector("#red-ui-workspace-chart");
    if (!chart || chart.dataset.bimCanvasPanning === "ready") return;

    chart.dataset.bimCanvasPanning = "ready";
    chart.title = "在空白处按住鼠标左键拖动画布；Shift + 拖动可框选节点";

    const hint = document.createElement("span");
    hint.className = "bim-canvas-pan-hint";
    hint.textContent = "左键拖动画布";
    document.querySelector("#view-zoom-controls")?.appendChild(hint);
    document.querySelector("#red-ui-view-zoom-fit")?.addEventListener("click", () => {
      window.setTimeout(centerActiveFlow, 520);
    });

    let panState = null;

    const finishPan = (event) => {
      if (!panState) return;
      event?.preventDefault();
      event?.stopImmediatePropagation();
      chart.classList.remove("bim-canvas-panning");
      document.body.style.removeProperty("user-select");
      window.removeEventListener("mousemove", moveCanvas, true);
      window.removeEventListener("mouseup", finishPan, true);
      if (!panState.moved) {
        try { window.RED.actions.invoke("core:select-none"); } catch { /* selection is optional */ }
      }
      panState = null;
    };

    const moveCanvas = (event) => {
      if (!panState) return;
      const deltaX = event.clientX - panState.clientX;
      const deltaY = event.clientY - panState.clientY;
      if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) panState.moved = true;
      chart.scrollLeft = panState.scrollLeft - deltaX;
      chart.scrollTop = panState.scrollTop - deltaY;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    chart.addEventListener("mousedown", (event) => {
      const isCanvasBackground = event.target.closest?.(".red-ui-workspace-chart-grid");
      if (
        event.button !== 0 ||
        !isCanvasBackground ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      ) return;

      panState = {
        clientX: event.clientX,
        clientY: event.clientY,
        scrollLeft: chart.scrollLeft,
        scrollTop: chart.scrollTop,
        moved: false
      };
      chart.focus();
      chart.classList.add("bim-canvas-panning");
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", moveCanvas, true);
      window.addEventListener("mouseup", finishPan, true);
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  function initialize() {
    if (!window.RED?.events || !window.RED?.actions || !window.RED?.workspaces) {
      window.setTimeout(initialize, 120);
      return;
    }
    let initialized = false;
    const showExampleAndFit = () => {
      if (initialized) return;
      initialized = true;
      installCanvasPanning();
      try { window.RED.workspaces.show("example-td-tab"); } catch { /* flow may not exist yet */ }
      window.dispatchEvent(new Event("resize"));
      fitActiveFlow();
    };
    window.RED.events.on("flows:loaded", showExampleAndFit);
    window.RED.events.on("workspace:change", () => {
      installCanvasPanning();
      fitActiveFlow();
    });
    window.addEventListener("hashchange", fitActiveFlow);
    window.setTimeout(showExampleAndFit, 1000);
  }
  window.addEventListener("load", initialize, { once: true });
})();
