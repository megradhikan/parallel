// Mirrors packages/backend/src/protocol.ts — keep the two files in sync.

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
  | { type: "ai-token"; roomId: string; requestId: string; token: string }
  | { type: "ai-done"; roomId: string; requestId: string }
  | { type: "ai-error"; roomId: string; requestId: string; message: string }
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
