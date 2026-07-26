import React, { useEffect, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";

window.EXCALIDRAW_ASSET_PATH = "/kanban-assets/excalidraw/";

const TYPE_LABELS = {
  problem: "問題",
  customer: "目標使用者",
  insight: "洞察",
  solution: "方案",
  value: "價值",
  distribution: "通路",
  "business-model": "商業模式",
  moat: "護城河",
  risk: "風險",
  experiment: "實驗",
  component: "元件",
  decision: "決策",
  task: "任務",
  note: "筆記",
};

const STATUS_COLORS = {
  draft: { stroke: "#88929e", fill: "#20262d" },
  fact: { stroke: "#45d29a", fill: "#102921" },
  assumption: { stroke: "#e2aa43", fill: "#302510" },
  hypothesis: { stroke: "#e2aa43", fill: "#302510" },
  decision: { stroke: "#42c7d5", fill: "#102b30" },
};

function defaultLayout(index) {
  const column = index % 3;
  const row = Math.floor(index / 3);
  return { x: 80 + column * 360, y: 80 + row * 240, w: 280, h: 152 };
}

function nodeElementId(nodeId) {
  return "bp_node_" + nodeId;
}

function documentToElements(document) {
  if (!document) return [];
  const activeNodes = document.nodes.filter((node) => !node.archived);
  const nodeIds = new Set(activeNodes.map((node) => node.id));
  const layoutById = new Map();
  const skeleton = activeNodes.map((node, index) => {
    const layout = node.layout || defaultLayout(index);
    layoutById.set(node.id, layout);
    const colors = STATUS_COLORS[node.status] || STATUS_COLORS.draft;
    const body = node.body ? "\n\n" + node.body.slice(0, 180) : "";
    return {
      id: nodeElementId(node.id),
      type: "rectangle",
      x: layout.x,
      y: layout.y,
      width: layout.w,
      height: layout.h,
      strokeColor: colors.stroke,
      backgroundColor: colors.fill,
      fillStyle: "solid",
      strokeWidth: 2,
      roughness: 1,
      roundness: { type: 3 },
      label: {
        text: (TYPE_LABELS[node.type] || node.type) + "  " + node.title + body,
        fontSize: 18,
        fontFamily: 2,
        textAlign: "left",
        verticalAlign: "top",
        strokeColor: "#e8edf3",
      },
    };
  });
  for (const edge of document.edges) {
    if (edge.archived || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    const from = layoutById.get(edge.from);
    const to = layoutById.get(edge.to);
    const x = from.x + from.w;
    const y = from.y + from.h / 2;
    skeleton.push({
      id: "bp_edge_" + edge.id,
      type: "arrow",
      x,
      y,
      points: [[0, 0], [to.x - x, to.y + to.h / 2 - y]],
      strokeColor: "#9ba6b3",
      strokeWidth: 2,
      roughness: 1,
      startBinding: { elementId: nodeElementId(edge.from), focus: 0, gap: 8 },
      endBinding: { elementId: nodeElementId(edge.to), focus: 0, gap: 8 },
      startArrowhead: null,
      endArrowhead: "arrow",
      label: edge.label || edge.relation
        ? { text: edge.label || edge.relation, fontSize: 14, fontFamily: 2 }
        : undefined,
    });
  }
  return convertToExcalidrawElements(skeleton, { regenerateIds: false });
}

function BlueprintCanvas() {
  const [document, setDocument] = React.useState(window.__MONSTRARE_BLUEPRINT__ || null);
  const apiRef = useRef(null);
  const documentRef = useRef(document);
  const ignoreChangesUntil = useRef(0);
  const layoutTimer = useRef(null);
  const elements = useMemo(() => documentToElements(document), [document]);

  function fitScene(nextElements = elements) {
    if (!apiRef.current || !nextElements.length) return;
    apiRef.current.updateScene({
      appState: { theme: "dark", viewBackgroundColor: "#0c1014", zenModeEnabled: true },
    });
    apiRef.current.scrollToContent(nextElements, {
      fitToViewport: true,
      viewportZoomFactor: 0.82,
      animate: false,
    });
  }

  useEffect(() => {
    const onDocument = (event) => setDocument(event.detail || null);
    window.addEventListener("monstrare:blueprint-document", onDocument);
    return () => window.removeEventListener("monstrare:blueprint-document", onDocument);
  }, []);

  useEffect(() => {
    documentRef.current = document;
    if (!apiRef.current) return;
    ignoreChangesUntil.current = Date.now() + 500;
    apiRef.current.updateScene({
      elements,
      appState: { theme: "dark", viewBackgroundColor: "#0c1014", zenModeEnabled: true },
      commitToHistory: false,
    });
    if (elements.length) {
      requestAnimationFrame(() => fitScene(elements));
    }
  }, [document, elements]);

  useEffect(() => {
    if (!rootElement || typeof ResizeObserver === "undefined") return undefined;
    let timer = null;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 320 || rect.height < 320) return;
      clearTimeout(timer);
      timer = setTimeout(() => fitScene(), 120);
    });
    observer.observe(rootElement);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [elements]);

  useEffect(() => () => clearTimeout(layoutTimer.current), []);

  function handleChange(sceneElements, appState) {
    const selectedIds = Object.keys(appState.selectedElementIds || {});
    const selected = selectedIds.find((id) => id.startsWith("bp_node_"));
    window.dispatchEvent(new CustomEvent("monstrare:blueprint-node-select", {
      detail: selected ? selected.slice("bp_node_".length) : "",
    }));

    if (!documentRef.current || Date.now() < ignoreChangesUntil.current) return;
    clearTimeout(layoutTimer.current);
    layoutTimer.current = setTimeout(() => {
      const current = documentRef.current;
      const layouts = [];
      for (const node of current.nodes) {
        const element = sceneElements.find((item) => item.id === nodeElementId(node.id));
        if (!element || element.isDeleted) continue;
        const layout = {
          x: Math.round(element.x),
          y: Math.round(element.y),
          w: Math.round(element.width),
          h: Math.round(element.height),
        };
        const previous = node.layout;
        if (
          !previous ||
          previous.x !== layout.x ||
          previous.y !== layout.y ||
          previous.w !== layout.w ||
          previous.h !== layout.h
        ) {
          layouts.push({ nodeId: node.id, layout });
        }
      }
      if (layouts.length) {
        window.dispatchEvent(new CustomEvent("monstrare:blueprint-layout", { detail: layouts }));
      }
    }, 700);
  }

  return (
    <Excalidraw
      excalidrawAPI={(api) => {
        apiRef.current = api;
        ignoreChangesUntil.current = Date.now() + 500;
        requestAnimationFrame(() => fitScene(elements));
      }}
      initialData={{
        elements,
        appState: {
          theme: "dark",
          viewBackgroundColor: "#0c1014",
          zenModeEnabled: true,
          currentItemFontFamily: 2,
        },
      }}
      theme="dark"
      langCode="zh-TW"
      autoFocus={false}
      onChange={handleChange}
      UIOptions={{
        canvasActions: {
          clearCanvas: false,
          loadScene: false,
          saveToActiveFile: false,
          toggleTheme: false,
        },
        tools: { image: false },
      }}
    />
  );
}

const rootElement = document.getElementById("blueprint-canvas-root");
if (rootElement) createRoot(rootElement).render(<BlueprintCanvas />);
