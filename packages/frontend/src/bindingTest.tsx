// Section 10.5: the binding isolation harness. Two Monaco editors on one page
// share a single in-memory Y.Doc with no network involved, so any desync here
// is the binding's fault and nothing else's. Type, paste multi-line blocks, and
// use multi-cursor (⌥-click) in either editor — the other must match exactly,
// and the live check below must stay green.
import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import * as Y from "yjs";
import type * as monacoNs from "monaco-editor";
import { monaco } from "./lib/monacoSetup";
import { useMonacoBinding } from "./hooks/useMonacoBinding";
import "./index.css";

const ydoc = new Y.Doc();
const ytext = ydoc.getText("content");
ydoc.transact(() => ytext.insert(0, "function seed() {\n  return 'edit me in either pane';\n}\n"));

function BoundEditor({ label }: { label: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<monacoNs.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const instance = monaco.editor.create(containerRef.current, {
      value: "",
      language: "javascript",
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
    });
    setEditor(instance);
    return () => {
      instance.getModel()?.dispose();
      instance.dispose();
      setEditor(null);
    };
  }, []);

  useMonacoBinding({ editor, ydoc, ytext });

  return (
    <div className="harness-pane">
      <h3>{label}</h3>
      <div ref={containerRef} className="harness-editor" />
    </div>
  );
}

function Harness() {
  const [report, setReport] = useState({ matches: true, length: ytext.length });

  useEffect(() => {
    const check = () => {
      const models = monaco.editor.getModels();
      const expected = ytext.toString();
      setReport({
        matches: models.every((m) => m.getValue() === expected),
        length: expected.length,
      });
    };
    const interval = setInterval(check, 300);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="harness">
      <header className="presence-bar">
        <span className="brand">Binding isolation harness</span>
        <span className={report.matches ? "status status-open" : "status status-closed"}>
          {report.matches ? `in sync (${report.length} chars)` : "OUT OF SYNC"}
        </span>
      </header>
      <div className="harness-panes">
        <BoundEditor label="Editor A" />
        <BoundEditor label="Editor B" />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>
);
