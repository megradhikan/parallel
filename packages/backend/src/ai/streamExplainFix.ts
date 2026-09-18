import Anthropic from "@anthropic-ai/sdk";
import type { PanelMode } from "../protocol.js";
import { MODEL } from "./model.js";

const EXPLAIN_SYSTEM =
  "Explain what the following code does, concisely, for another engineer reading it for the first time. " +
  "Do not suggest changes unless something is clearly broken.";

const FIX_SYSTEM =
  "Review the following code for bugs or issues. If you find one, explain what's wrong and show the " +
  "corrected version. If the code looks correct, say so briefly.";

export interface StreamExplainFixArgs {
  anthropic: Anthropic;
  mode: PanelMode;
  requestId: string;
  roomId: string;
  selectionText: string;
  fileContext: string;
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (message: string) => void;
  log: (msg: string) => void;
}

// Streams commentary *about* the code to the shared side panel. Deliberately
// never touches the Y.Doc: panel entries are append-only shared state, not
// document content, so they need no conflict resolution (PRD 7.3). A "fix"
// response is prose too — it is never auto-applied to the file.
export async function streamExplainFix({
  anthropic,
  mode,
  requestId,
  roomId,
  selectionText,
  fileContext,
  onToken,
  onDone,
  onError,
  log,
}: StreamExplainFixArgs): Promise<void> {
  const userContent =
    mode === "fix"
      ? `Selected code:\n${selectionText}\n\n--- Full file, for context only ---\n${fileContext}`
      : selectionText;

  let full = "";

  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      system: mode === "explain" ? EXPLAIN_SYSTEM : FIX_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    });

    stream.on("text", (delta: string) => {
      full += delta;
      onToken(delta);
    });

    await stream.finalMessage();
    log(`[ai-panel-done] requestId=${requestId} room=${roomId} mode=${mode} chars=${full.length}`);
    onDone(full);
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed";
    log(`[ai-panel-error] requestId=${requestId} room=${roomId} mode=${mode} message=${message}`);
    onError(message);
  }
}
