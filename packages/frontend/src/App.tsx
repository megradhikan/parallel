import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Routes, Route, useNavigate, useParams } from "react-router-dom";
import { useYDoc } from "./hooks/useYDoc";
import { usePresence } from "./hooks/usePresence";
import { CodeEditor } from "./components/CodeEditor";
import { PresenceBar } from "./components/PresenceBar";
import { AiPanel } from "./components/AiPanel";
import type { PanelEntryState } from "./components/AiPanelEntry";
import { GenerateButton } from "./components/GenerateButton";
import { colorForUser } from "./lib/color";
import type { PanelMode, SelectionRange, ServerMessage } from "./lib/protocol";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3001";
const API_URL = WS_URL.replace(/^ws/, "http");
const CURSOR_THROTTLE_MS = 50;
const CONTEXT_LIMIT = 4000;

function getOrCreateUserId(): string {
  const key = "parallel:userId";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = `u-${crypto.randomUUID()}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}

function HomePage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/rooms`, { method: "POST" });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = (await res.json()) as { roomId: string };
      navigate(`/room/${data.roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create room");
      setCreating(false);
    }
  };

  return (
    <div className="home">
      <h1>Parallel</h1>
      <p>
        A shared code editor with live cursors, CRDT-safe concurrent editing, and two AI features:
        code generated straight into the document, and a shared explain/fix panel.
      </p>
      <button className="generate-btn" onClick={handleCreate} disabled={creating}>
        {creating ? "Creating…" : "New room"}
      </button>
      {error && <p className="error-banner">{error}</p>}
    </div>
  );
}

function NamePrompt({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [name, setName] = useState(`Guest-${Math.random().toString(36).slice(2, 6)}`);
  return (
    <div className="home">
      <h1>Join room</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim() || "Guest";
          sessionStorage.setItem("parallel:displayName", trimmed);
          onSubmit(trimmed);
        }}
      >
        <input
          className="name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          maxLength={40}
        />
        <button className="generate-btn" type="submit">
          Join
        </button>
      </form>
    </div>
  );
}

function RoomPage() {
  const { roomId = "" } = useParams();
  const [displayName, setDisplayName] = useState<string | null>(() =>
    sessionStorage.getItem("parallel:displayName")
  );
  const userId = useRef(getOrCreateUserId()).current;

  if (!displayName) return <NamePrompt onSubmit={setDisplayName} />;
  return <RoomWorkspace roomId={roomId} userId={userId} displayName={displayName} />;
}

function RoomWorkspace({
  roomId,
  userId,
  displayName,
}: {
  roomId: string;
  userId: string;
  displayName: string;
}) {
  const { ydoc, ytext, wsClient, status, initialPresence, initialPanelHistory } = useYDoc(
    roomId,
    userId,
    displayName,
    WS_URL
  );
  const remoteUsers = usePresence(wsClient, initialPresence, userId);
  const [panelEntries, setPanelEntries] = useState<PanelEntryState[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const lastCursorSentAt = useRef(0);
  const cursorRef = useRef({ line: 1, col: 1 });

  useEffect(() => {
    if (initialPanelHistory.length === 0) return;
    setPanelEntries((prev) => {
      const seen = new Set(prev.map((e) => e.requestId));
      const restored = initialPanelHistory
        .filter((entry) => !seen.has(entry.requestId))
        .map<PanelEntryState>((entry) => ({ ...entry, streaming: false }));
      return [...restored, ...prev];
    });
  }, [initialPanelHistory]);

  // Panel frames arrive for every request in the room, including other
  // people's — an entry is created the first time its requestId is seen.
  useEffect(() => {
    if (!wsClient) return;
    return wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type === "ai-panel-token") {
        setPanelEntries((prev) => {
          const existing = prev.find((e) => e.requestId === msg.requestId);
          if (!existing) {
            return [
              ...prev,
              {
                requestId: msg.requestId,
                mode: msg.mode,
                requestedBy: msg.requestedBy,
                selectionSnippet: msg.selectionSnippet,
                text: msg.token,
                streaming: true,
              },
            ];
          }
          return prev.map((e) =>
            e.requestId === msg.requestId ? { ...e, text: e.text + msg.token } : e
          );
        });
      } else if (msg.type === "ai-panel-done") {
        setPanelEntries((prev) =>
          prev.map((e) => (e.requestId === msg.requestId ? { ...e, streaming: false } : e))
        );
      } else if (msg.type === "ai-panel-error") {
        setPanelEntries((prev) =>
          prev.map((e) =>
            e.requestId === msg.requestId ? { ...e, streaming: false, error: msg.message } : e
          )
        );
        setAiError(msg.message);
        setTimeout(() => setAiError(null), 6000);
      } else if (msg.type === "ai-done") {
        setIsStreaming(false);
      } else if (msg.type === "ai-error") {
        setIsStreaming(false);
        setAiError(msg.message);
        setTimeout(() => setAiError(null), 6000);
      }
    });
  }, [wsClient]);

  const handleSelectionChange = useCallback(
    (selection: SelectionRange) => {
      cursorRef.current = { line: selection.endLine, col: selection.endCol };
      if (!wsClient) return;
      const now = Date.now();
      if (now - lastCursorSentAt.current < CURSOR_THROTTLE_MS) return;
      lastCursorSentAt.current = now;
      wsClient.send({ type: "cursor", roomId, userId, selection });
    },
    [wsClient, roomId, userId]
  );

  const handleRequestPanel = useCallback(
    (mode: PanelMode, selectionText: string, range: { startLine: number; endLine: number }) => {
      if (!wsClient) return;
      wsClient.send({
        type: "ai-request",
        roomId,
        userId,
        mode,
        selectionText,
        selectionRange: range,
        fileContext: ytext.toString().slice(0, CONTEXT_LIMIT * 2),
      });
    },
    [wsClient, roomId, userId, ytext]
  );

  const handleGenerate = useCallback(
    (line?: number, col?: number) => {
      if (!wsClient || isStreaming) return;
      const position = line && col ? { line, col } : cursorRef.current;
      const fullText = ytext.toString();
      const contextWindow = fullText.length > CONTEXT_LIMIT ? fullText.slice(-CONTEXT_LIMIT) : fullText;
      setIsStreaming(true);
      wsClient.send({
        type: "ai-request",
        roomId,
        userId,
        mode: "inline-generate",
        cursorPosition: position,
        contextWindow,
      });
    },
    [wsClient, isStreaming, ytext, roomId, userId]
  );

  return (
    <div className="room">
      <PresenceBar
        roomId={roomId}
        selfName={displayName}
        selfColor={colorForUser(userId)}
        remoteUsers={remoteUsers}
        status={status}
      />
      <div className="room-body">
        <div className="editor-column">
          <div className="editor-toolbar">
            <GenerateButton onClick={() => handleGenerate()} isStreaming={isStreaming} />
            {aiError && <span className="error-banner">AI error: {aiError}</span>}
          </div>
          <CodeEditor
            ydoc={ydoc}
            ytext={ytext}
            remoteUsers={remoteUsers}
            onSelectionChange={handleSelectionChange}
            onRequestPanel={handleRequestPanel}
            onGenerate={(line, col) => handleGenerate(line, col)}
          />
        </div>
        <AiPanel entries={panelEntries} />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/room/:roomId" element={<RoomPage />} />
      </Routes>
    </BrowserRouter>
  );
}
