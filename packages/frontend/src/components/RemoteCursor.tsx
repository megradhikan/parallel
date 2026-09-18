import { useEffect } from "react";
import type * as monacoNs from "monaco-editor";
import { monaco } from "../lib/monacoSetup";
import type { RemoteUser } from "../hooks/usePresence";

interface RemoteCursorProps {
  editor: monacoNs.editor.IStandaloneCodeEditor | null;
  user: RemoteUser;
}

const styleSheetId = "remote-cursor-styles";
const injected = new Set<string>();

// Monaco decorations are styled by class name, so each user needs their own
// rule carrying their color. Injected once per user for the life of the page.
function ensureStyles(userId: string, color: string): string {
  const safeId = userId.replace(/[^a-zA-Z0-9]/g, "");
  if (injected.has(safeId)) return safeId;
  injected.add(safeId);

  let sheet = document.getElementById(styleSheetId) as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = styleSheetId;
    document.head.appendChild(sheet);
  }
  sheet.appendChild(
    document.createTextNode(`
.remote-selection-${safeId} { background-color: ${color}33; }
.remote-caret-${safeId} { border-left: 2px solid ${color}; margin-left: -1px; }
.remote-tag-${safeId} { background-color: ${color}; }
`)
  );
  return safeId;
}

// Renders one remote user's selection highlight, caret, and name tag inside
// Monaco: a decorations collection for the ranges, a content widget for the
// label. Both are torn down when the user leaves (the component unmounts).
export function RemoteCursor({ editor, user }: RemoteCursorProps) {
  useEffect(() => {
    if (!editor || !user.selection) return;
    const safeId = ensureStyles(user.userId, user.color);
    const { startLine, startCol, endLine, endCol } = user.selection;

    const decorations: monacoNs.editor.IModelDeltaDecoration[] = [
      {
        range: new monaco.Range(endLine, endCol, endLine, endCol),
        options: { className: `remote-caret-${safeId}`, stickiness: 1 },
      },
    ];
    const hasSelection = startLine !== endLine || startCol !== endCol;
    if (hasSelection) {
      decorations.push({
        range: new monaco.Range(startLine, startCol, endLine, endCol),
        options: { className: `remote-selection-${safeId}` },
      });
    }

    const collection = editor.createDecorationsCollection(decorations);

    const node = document.createElement("div");
    node.className = `remote-tag remote-tag-${safeId}`;
    node.textContent = user.displayName;

    const widget: monacoNs.editor.IContentWidget = {
      getId: () => `remote-tag-${user.userId}`,
      getDomNode: () => node,
      getPosition: () => ({
        position: { lineNumber: endLine, column: endCol },
        preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE],
      }),
    };
    editor.addContentWidget(widget);

    return () => {
      collection.clear();
      editor.removeContentWidget(widget);
    };
  }, [editor, user.userId, user.color, user.displayName, user.selection]);

  return null;
}
