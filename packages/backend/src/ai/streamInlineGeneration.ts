import Anthropic from "@anthropic-ai/sdk";
import * as Y from "yjs";
import type { Room } from "../rooms.js";
import type { UpdateOrigin } from "../server.js";
import { MODEL } from "./model.js";

const SYSTEM_PROMPT =
  "Continue/complete the following code naturally, matching the existing style and conventions. " +
  "Output only code, no explanation, no markdown code fences.";

export interface StreamInlineGenerationArgs {
  anthropic: Anthropic;
  room: Room;
  requestId: string;
  cursorLine: number;
  cursorCol: number;
  contextWindow: string;
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  log: (msg: string) => void;
}

// Monaco addresses positions as 1-based line/column; the Y.Text is a flat
// string. Both describe the same buffer, so the conversion is exact.
export function lineColToOffset(text: string, line: number, col: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  offset += col - 1;
  return Math.max(0, Math.min(offset, text.length));
}

// Every AI-generated delta is inserted through a Yjs transaction tagged with
// an UpdateOrigin, so it flows down the exact same doc.on('update') ->
// broadcast -> Redis-publish pipeline as a human keystroke. There is no
// separate client-side "AI text" rendering path — this is the core technical
// point of the project (PRD 3.1.6 / 7.4).
export async function streamInlineGeneration({
  anthropic,
  room,
  requestId,
  cursorLine,
  cursorCol,
  contextWindow,
  onToken,
  onDone,
  onError,
  log,
}: StreamInlineGenerationArgs): Promise<void> {
  const startOffset = lineColToOffset(room.ytext.toString(), cursorLine, cursorCol);

  // Anchored as a Yjs relative position rather than a fixed numeric index:
  // this stays correct when another user deletes a line above the insertion
  // point mid-stream, which would otherwise shift every subsequent token into
  // the wrong place (PRD 7.4).
  let relPos = Y.createRelativePositionFromTypeIndex(room.ytext, startOffset);

  const origin: UpdateOrigin = { userId: "ai", excludeConnId: undefined, fromRedis: false };

  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: contextWindow }],
    });

    stream.on("text", (delta: string) => {
      const abs = Y.createAbsolutePositionFromRelativePosition(relPos, room.doc);
      const index = abs ? abs.index : room.ytext.length;

      room.doc.transact(() => {
        room.ytext.insert(index, delta);
      }, origin);

      relPos = Y.createRelativePositionFromTypeIndex(room.ytext, index + delta.length);
      onToken(delta);
    });

    await stream.finalMessage();
    log(`[ai-done] requestId=${requestId} room=${room.roomId}`);
    onDone();
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed";
    log(`[ai-error] requestId=${requestId} room=${room.roomId} message=${message}`);
    onError(message);
  }
}
