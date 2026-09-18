import type { PanelMode } from "../lib/protocol";

export interface PanelEntryState {
  requestId: string;
  mode: PanelMode;
  requestedBy: string;
  selectionSnippet: string;
  text: string;
  streaming: boolean;
  error?: string;
}

export function AiPanelEntry({ entry }: { entry: PanelEntryState }) {
  return (
    <article className="panel-entry">
      <header>
        <span className={`panel-mode panel-mode-${entry.mode}`}>{entry.mode}</span>
        <span className="panel-requester">{entry.requestedBy}</span>
        {entry.streaming && <span className="panel-streaming">streaming…</span>}
      </header>
      <pre className="panel-snippet">{entry.selectionSnippet}</pre>
      {entry.error ? (
        <p className="panel-error">{entry.error}</p>
      ) : (
        <p className="panel-text">{entry.text}</p>
      )}
    </article>
  );
}
