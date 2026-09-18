import { useEffect, useRef, useState } from "react";
import type * as monacoNs from "monaco-editor";
import * as Y from "yjs";
import { monaco } from "../lib/monacoSetup";
import { useMonacoBinding } from "../hooks/useMonacoBinding";
import { RemoteCursor } from "./RemoteCursor";
import type { RemoteUser } from "../hooks/usePresence";
import type { PanelMode, SelectionRange } from "../lib/protocol";

interface CodeEditorProps {
  ydoc: Y.Doc;
  ytext: Y.Text;
  remoteUsers: RemoteUser[];
  onSelectionChange: (selection: SelectionRange) => void;
  onRequestPanel: (mode: PanelMode, selectionText: string, range: { startLine: number; endLine: number }) => void;
  onGenerate: (line: number, col: number) => void;
}

interface ToolbarState {
  top: number;
  left: number;
}

export function CodeEditor({
  ydoc,
  ytext,
  remoteUsers,
  onSelectionChange,
  onRequestPanel,
  onGenerate,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<monacoNs.editor.IStandaloneCodeEditor | null>(null);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);

  // Kept in a ref so the Monaco listeners registered once on mount always call
  // the current handlers instead of the ones captured at first render.
  const handlers = useRef({ onSelectionChange, onRequestPanel, onGenerate });
  handlers.current = { onSelectionChange, onRequestPanel, onGenerate };

  useEffect(() => {
    if (!containerRef.current) return;

    const instance = monaco.editor.create(containerRef.current, {
      value: "",
      language: "javascript",
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      tabSize: 2,
    });
    setEditor(instance);

    const positionToolbar = () => {
      const selection = instance.getSelection();
      if (!selection || selection.isEmpty()) {
        setToolbar(null);
        return;
      }
      const visible = instance.getScrolledVisiblePosition(selection.getStartPosition());
      if (!visible) {
        setToolbar(null);
        return;
      }
      setToolbar({ top: Math.max(0, visible.top - 34), left: visible.left });
    };

    const selectionSub = instance.onDidChangeCursorSelection((e) => {
      handlers.current.onSelectionChange({
        startLine: e.selection.startLineNumber,
        startCol: e.selection.startColumn,
        endLine: e.selection.endLineNumber,
        endCol: e.selection.endColumn,
      });
      positionToolbar();
    });
    const scrollSub = instance.onDidScrollChange(positionToolbar);

    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => {
      const position = instance.getPosition();
      if (position) handlers.current.onGenerate(position.lineNumber, position.column);
    });

    return () => {
      selectionSub.dispose();
      scrollSub.dispose();
      instance.getModel()?.dispose();
      instance.dispose();
      setEditor(null);
    };
  }, []);

  useMonacoBinding({ editor, ydoc, ytext });

  const requestPanel = (mode: PanelMode) => {
    if (!editor) return;
    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!selection || !model || selection.isEmpty()) return;
    onRequestPanel(mode, model.getValueInRange(selection), {
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
    });
    setToolbar(null);
  };

  return (
    <div className="editor-wrap">
      <div ref={containerRef} className="editor" />
      {toolbar && (
        <div className="selection-toolbar" style={{ top: toolbar.top, left: toolbar.left }}>
          <button onClick={() => requestPanel("explain")}>Explain</button>
          <button onClick={() => requestPanel("fix")}>Fix</button>
        </div>
      )}
      {remoteUsers.map((user) => (
        <RemoteCursor key={user.userId} editor={editor} user={user} />
      ))}
    </div>
  );
}
