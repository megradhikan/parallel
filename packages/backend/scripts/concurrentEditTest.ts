// Section 10.2: the single most important correctness test in the project.
//
// Two raw WebSocket connections join one room and run three concurrent-edit
// scenarios against the shared Y.Text:
//   1. both insert at literally the same character offset, simultaneously
//   2. rapid overlapping edit bursts in two different regions of the file
//   3. one client deletes a range while the other is inserting inside it
//
// Then it asserts that both connections converge to an identical string, that
// nothing was lost or duplicated, and — the check specific to a code editor —
// that the converged result still parses as valid JavaScript. The edits are
// constructed so that *any* correct CRDT merge order yields valid JS; a merge
// that interleaves characters from two concurrent inserts would converge
// byte-identically on both clients and still fail the parser check.
//
// Requires the backend server to already be running (pnpm dev:backend).
import WebSocket from "ws";
import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { parse } from "acorn";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3001";
const ROOM_ID = `test-concurrent-${Date.now()}`;

const BASE = `function alpha() {
  return 1;
}

function beta() {
  return 2;
}

function gamma() {
  return 3;
}
`;

const HEADER_A = "// HEADER_FROM_CLIENT_A\n";
const HEADER_B = "// HEADER_FROM_CLIENT_B\n";
// Each burst line declares a uniquely named binding: five identical `const`
// declarations in one scope would be a syntax error even after a perfect
// merge, which would make the parser check below meaningless.
const burstA = (i: number) => `  const fromA${i} = 1;\n`;
const burstB = (i: number) => `  const fromB${i} = 2;\n`;
const BURST_ITERATIONS = 5;
const INJECTED_B = "\nconst injectedByB = 42;\n";

interface ClientHandle {
  ws: WebSocket;
  doc: Y.Doc;
  ytext: Y.Text;
  synced: Promise<void>;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function connectClient(userId: string, displayName: string): ClientHandle {
  const ws = new WebSocket(WS_URL);
  const doc = new Y.Doc();
  const ytext = doc.getText("content");

  let resolveSynced: () => void;
  const synced = new Promise<void>((resolve) => (resolveSynced = resolve));

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const msg: ClientMessage = { type: "doc-update", roomId: ROOM_ID, update: toBase64(update) };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  });

  ws.on("open", () => {
    const joinMsg: ClientMessage = { type: "join", roomId: ROOM_ID, userId, displayName };
    ws.send(JSON.stringify(joinMsg));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    if (msg.type === "sync") {
      Y.applyUpdate(doc, fromBase64(msg.docState), "remote");
      resolveSynced();
    } else if (msg.type === "doc-update") {
      Y.applyUpdate(doc, fromBase64(msg.update), "remote");
    }
  });

  return { ws, doc, ytext, synced };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function parsesAsJavaScript(source: string): { ok: boolean; error?: string } {
  try {
    parse(source, { ecmaVersion: 2022, sourceType: "module" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  console.log(`[test] room=${ROOM_ID} ws=${WS_URL}`);

  const clientA = connectClient(`u-${randomUUID()}`, "Client A");
  const clientB = connectClient(`u-${randomUUID()}`, "Client B");

  await Promise.all([clientA.synced, clientB.synced]);

  // Normalize: rooms open with a seeded starter file, so client A replaces the
  // whole buffer with a known base before the scenarios run.
  clientA.doc.transact(() => {
    clientA.ytext.delete(0, clientA.ytext.length);
    clientA.ytext.insert(0, BASE);
  }, "local");
  await settle(600);
  console.log(`[test] both clients synced on base file (${clientA.ytext.length} chars)`);

  // --- Scenario 1: simultaneous insert at the same offset ---------------
  clientA.doc.transact(() => clientA.ytext.insert(0, HEADER_A), "local");
  clientB.doc.transact(() => clientB.ytext.insert(0, HEADER_B), "local");
  await settle(600);
  console.log("[test] scenario 1 done: simultaneous insert at offset 0");

  // --- Scenario 2: rapid overlapping bursts in two regions --------------
  for (let i = 0; i < BURST_ITERATIONS; i++) {
    const aText = clientA.ytext.toString();
    const aAnchor = aText.indexOf("  return 1;");
    const bText = clientB.ytext.toString();
    const bAnchor = bText.indexOf("  return 2;");
    if (aAnchor >= 0) clientA.doc.transact(() => clientA.ytext.insert(aAnchor, burstA(i)), "local");
    if (bAnchor >= 0) clientB.doc.transact(() => clientB.ytext.insert(bAnchor, burstB(i)), "local");
    await settle(30);
  }
  await settle(600);
  console.log(`[test] scenario 2 done: ${BURST_ITERATIONS} overlapping bursts per client`);

  // --- Scenario 3: delete a range the other client is editing inside ----
  const textForDelete = clientA.ytext.toString();
  const gammaStart = textForDelete.indexOf("function gamma()");
  const gammaEnd = textForDelete.indexOf("}", textForDelete.indexOf("return 3;")) + 1;
  const textForInsert = clientB.ytext.toString();
  const insertInsideGamma = textForInsert.indexOf("return 3;");

  clientA.doc.transact(() => clientA.ytext.delete(gammaStart, gammaEnd - gammaStart), "local");
  clientB.doc.transact(() => clientB.ytext.insert(insertInsideGamma, INJECTED_B), "local");
  await settle(1500);
  console.log("[test] scenario 3 done: delete-range vs concurrent insert inside it");

  const finalA = clientA.ytext.toString();
  const finalB = clientB.ytext.toString();

  clientA.ws.close();
  clientB.ws.close();

  const converged = finalA === finalB;
  const headersIntact =
    occurrences(finalA, HEADER_A.trim()) === 1 && occurrences(finalA, HEADER_B.trim()) === 1;
  const burstLines = Array.from({ length: BURST_ITERATIONS }, (_, i) => [burstA(i), burstB(i)]).flat();
  const burstsIntact = burstLines.every((line) => occurrences(finalA, line.trim()) === 1);
  const deletedRangeGone = !finalA.includes("function gamma()");
  const concurrentInsertSurvived = occurrences(finalA, "injectedByB") === 1;
  const parsed = parsesAsJavaScript(finalA);

  const pass =
    converged &&
    headersIntact &&
    burstsIntact &&
    deletedRangeGone &&
    concurrentInsertSurvived &&
    parsed.ok;

  console.log("---");
  console.log(finalA);
  console.log("---");
  console.log(`both clients converged to an identical string: ${converged}`);
  console.log(`same-offset concurrent inserts each present exactly once: ${headersIntact}`);
  console.log(
    `overlapping bursts all present exactly once, none lost or duplicated (${burstLines.length} lines): ${burstsIntact}`
  );
  console.log(`deleted range is gone: ${deletedRangeGone}`);
  console.log(`insert made inside the deleted range survived exactly once: ${concurrentInsertSurvived}`);
  console.log(`converged result parses as valid JavaScript: ${parsed.ok}${parsed.error ? ` (${parsed.error})` : ""}`);
  console.log(pass ? "PASS" : "FAIL");

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[test] error", err);
  process.exit(1);
});
