import { useEffect, useRef } from "react";
import { AiPanelEntry, type PanelEntryState } from "./AiPanelEntry";

interface AiPanelProps {
  entries: PanelEntryState[];
}

// Shared room state, not a private chat: every Explain/Fix response streams to
// everyone in the room, whoever asked for it (PRD 7.3).
export function AiPanel({ entries }: AiPanelProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  return (
    <aside className="ai-panel">
      <h2>Shared AI panel</h2>
      {entries.length === 0 ? (
        <p className="panel-empty">
          Select code in the editor and choose <strong>Explain</strong> or <strong>Fix</strong>. The
          response streams here for everyone in the room.
        </p>
      ) : (
        entries.map((entry) => <AiPanelEntry key={entry.requestId} entry={entry} />)
      )}
      <div ref={endRef} />
    </aside>
  );
}
