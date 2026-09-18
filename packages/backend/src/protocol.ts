// Shared WebSocket message protocol. Mirrored by hand in
// packages/frontend/src/lib/protocol.ts — keep the two files in sync.
//
// join / sync / doc-update / user-joined / user-left / leave / error keep the
// same shape as Pulse's protocol (the sibling collaborative-text project) so
// the two remain structurally compatible if a shared package is ever
// extracted. Selection-based cursors and the AI panel messages are new here.

export interface SelectionRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export type PanelMode = "explain" | "fix";

export type ClientMessage =
  | { type: "join"; roomId: string; userId: string; displayName: string }
  | { type: "doc-update"; roomId: string; update: string }
  | { type: "cursor"; roomId: string; userId: string; selection: SelectionRange }
  | {
      type: "ai-request";
      roomId: string;
      userId: string;
      mode: "inline-generate";
      cursorPosition: { line: number; col: number };
      contextWindow: string;
    }
  | {
      type: "ai-request";
      roomId: string;
      userId: string;
      mode: PanelMode;
      selectionText: string;
      selectionRange: { startLine: number; endLine: number };
      fileContext: string;
    }
  | { type: "leave"; roomId: string; userId: string };

export interface PresenceSnapshot {
  userId: string;
  displayName: string;
  color: string;
  selection: SelectionRange | null;
}

export interface AiPanelEntry {
  requestId: string;
  mode: PanelMode;
  requestedBy: string;
  selectionSnippet: string;
  text: string;
}

export type ServerMessage =
  | {
      type: "sync";
      roomId: string;
      docState: string;
      presence: PresenceSnapshot[];
      aiPanelHistory: AiPanelEntry[];
    }
  | { type: "doc-update"; roomId: string; update: string; sourceUserId: string }
  | {
      type: "cursor";
      roomId: string;
      userId: string;
      displayName: string;
      color: string;
      selection: SelectionRange;
    }
  | { type: "user-joined"; roomId: string; userId: string; displayName: string }
  | { type: "user-left"; roomId: string; userId: string }
  // Inline generation: the generated text itself travels as ordinary
  // doc-update frames (it is a real CRDT edit). These three are UI hints only.
  | { type: "ai-token"; roomId: string; requestId: string; token: string }
  | { type: "ai-done"; roomId: string; requestId: string }
  | { type: "ai-error"; roomId: string; requestId: string; message: string }
  // Explain/Fix: deliberately NOT part of the document — append-only shared
  // room state broadcast to every client in the room (see PRD 7.3).
  | {
      type: "ai-panel-token";
      roomId: string;
      requestId: string;
      mode: PanelMode;
      requestedBy: string;
      selectionSnippet: string;
      token: string;
    }
  | { type: "ai-panel-done"; roomId: string; requestId: string }
  | { type: "ai-panel-error"; roomId: string; requestId: string; message: string }
  | { type: "error"; message: string };
