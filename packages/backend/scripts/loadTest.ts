// Section 10.3 (stretch): opens N WebSocket connections to the same room,
// each sending periodic cursor/selection updates, and reports p50/p95/p99
// broadcast latency in ms. Not a formal test framework — a measurement script.
//
// Latency technique: the sender puts Date.now() in the selection's startLine
// field (repurposed for this script only — real clients use it as a line
// number). Every other connection receives the rebroadcast and computes
// `Date.now() - startLine` as the one-way fanout latency from send to
// receipt-by-another-client.
//
// Usage: pnpm test:load -- --n=100 --durationMs=10000
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3001";
const ROOM_ID = `test-load-${Date.now()}`;

function argNumber(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const val = Number(arg.split("=")[1]);
  return Number.isFinite(val) ? val : fallback;
}

const N = argNumber("n", 50);
const DURATION_MS = argNumber("durationMs", 10000);
const SEND_INTERVAL_MS = 200;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  console.log(`[loadtest] room=${ROOM_ID} n=${N} durationMs=${DURATION_MS} ws=${WS_URL}`);

  const latencies: number[] = [];
  const sockets: WebSocket[] = [];
  let connectedCount = 0;

  const ready = new Promise<void>((resolve) => {
    for (let i = 0; i < N; i++) {
      const userId = `u-${randomUUID()}`;
      const ws = new WebSocket(WS_URL);
      sockets.push(ws);

      ws.on("open", () => {
        const joinMsg: ClientMessage = {
          type: "join",
          roomId: ROOM_ID,
          userId,
          displayName: `load-${i}`,
        };
        ws.send(JSON.stringify(joinMsg));
      });

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as ServerMessage;
        if (msg.type === "sync") {
          connectedCount++;
          if (connectedCount === N) resolve();
        } else if (msg.type === "cursor") {
          const latency = Date.now() - msg.selection.startLine;
          if (latency >= 0 && latency < 60000) latencies.push(latency);
        }
      });

      ws.on("error", (err) => console.error(`[loadtest] socket ${i} error`, err.message));
    }
  });

  await ready;
  console.log(`[loadtest] all ${N} clients connected, sending cursor updates for ${DURATION_MS}ms`);

  const senders = sockets.map((ws, i) =>
    setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const msg: ClientMessage = {
        type: "cursor",
        roomId: ROOM_ID,
        userId: `u-loadtest-${i}`,
        selection: { startLine: Date.now(), startCol: 1, endLine: 0, endCol: 1 },
      };
      ws.send(JSON.stringify(msg));
    }, SEND_INTERVAL_MS)
  );

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

  senders.forEach(clearInterval);
  sockets.forEach((ws) => ws.close());

  const sorted = [...latencies].sort((a, b) => a - b);
  console.log("---");
  console.log(`connections: ${N}`);
  console.log(`samples: ${sorted.length}`);
  console.log(`p50: ${percentile(sorted, 50)}ms`);
  console.log(`p95: ${percentile(sorted, 95)}ms`);
  console.log(`p99: ${percentile(sorted, 99)}ms`);
  console.log(`max: ${sorted[sorted.length - 1]}ms`);

  process.exit(0);
}

main().catch((err) => {
  console.error("[loadtest] error", err);
  process.exit(1);
});
