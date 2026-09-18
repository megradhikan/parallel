// Stretch goal (section 3.2.1): proves that a client connected to one backend
// instance sees edits made by a client connected to a DIFFERENT backend
// instance, via Redis pub/sub fan-out (room:{roomId}:updates) — not shared
// memory, since these are two separate processes.
//
// Expects two backend instances already running against the same Redis:
//   PORT=3001 pnpm dev:backend
//   PORT=3002 pnpm dev:backend
import WebSocket from "ws";
import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";

const WS_URL_A = process.env.WS_URL_A ?? "ws://localhost:3001";
const WS_URL_B = process.env.WS_URL_B ?? "ws://localhost:3002";
const ROOM_ID = `test-cross-instance-${Date.now()}`;
const MARKER_A = "// FROM_INSTANCE_A_PORT_3001\n";
const MARKER_B = "// FROM_INSTANCE_B_PORT_3002\n";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

interface ClientHandle {
  ws: WebSocket;
  doc: Y.Doc;
  ytext: Y.Text;
  synced: Promise<void>;
}

function connectClient(wsUrl: string, userId: string, displayName: string): ClientHandle {
  const ws = new WebSocket(wsUrl);
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

async function main() {
  console.log(`[cross-instance] room=${ROOM_ID}`);
  console.log(`[cross-instance] client A -> ${WS_URL_A}`);
  console.log(`[cross-instance] client B -> ${WS_URL_B}`);

  const clientA = connectClient(WS_URL_A, `u-${randomUUID()}`, "Instance A client");
  const clientB = connectClient(WS_URL_B, `u-${randomUUID()}`, "Instance B client");

  await Promise.all([clientA.synced, clientB.synced]);
  console.log("[cross-instance] both clients synced (each to a different instance)");

  clientA.doc.transact(() => clientA.ytext.insert(0, MARKER_A), "local");
  console.log("[cross-instance] client A (port 3001) inserted its marker");

  await new Promise((resolve) => setTimeout(resolve, 800));

  clientB.doc.transact(() => clientB.ytext.insert(0, MARKER_B), "local");
  console.log("[cross-instance] client B (port 3002) inserted its marker");

  await new Promise((resolve) => setTimeout(resolve, 1200));

  const finalA = clientA.ytext.toString();
  const finalB = clientB.ytext.toString();

  clientA.ws.close();
  clientB.ws.close();

  const converged = finalA === finalB;
  const aSawB = finalA.includes(MARKER_B.trim());
  const bSawA = finalB.includes(MARKER_A.trim());
  const pass = converged && aSawB && bSawA;

  console.log("---");
  console.log(`converged across instances: ${converged}`);
  console.log(`client on instance A received instance B's edit (via Redis): ${aSawB}`);
  console.log(`client on instance B received instance A's edit (via Redis): ${bSawA}`);
  console.log(pass ? "PASS" : "FAIL");

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[cross-instance] error", err);
  process.exit(1);
});
