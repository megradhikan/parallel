import "dotenv/config";
import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import * as Y from "yjs";
import Groq from "groq-sdk";

import type {
  AiPanelEntry,
  ClientMessage,
  PresenceSnapshot,
  ServerMessage,
} from "./protocol.js";
import {
  type Room,
  type Connection,
  appendPanelEntry,
  colorForUser,
  getOrCreateRoom,
  getRoom,
  scheduleEvictionIfEmpty,
} from "./rooms.js";
import { RedisPubSub } from "./redisPubSub.js";
import { healthcheckHandler } from "./healthcheck.js";
import { streamInlineGeneration } from "./ai/streamInlineGeneration.js";
import { streamExplainFix } from "./ai/streamExplainFix.js";

// Tags every Yjs transaction so the single doc.on('update') handler below
// knows who to exclude from local broadcast and whether to re-publish to
// Redis, without a separate code path for AI vs. human edits.
export interface UpdateOrigin {
  userId: string;
  excludeConnId: string | undefined;
  fromRedis: boolean;
}

const PORT = Number(process.env.PORT ?? 3001);
const REDIS_URL = process.env.REDIS_URL;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", healthcheckHandler);

app.post("/api/rooms", (_req, res) => {
  const roomId = nanoid(10);
  getOrCreateRoom(roomId);
  log(`[room-created] roomId=${roomId}`);
  res.status(201).json({ roomId });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Redis pub/sub only matters once you run more than one backend instance —
// a single process broadcasts to its own connections from memory just fine.
// Wiring it up is opt-in via REDIS_URL so a solo deployment doesn't need a
// Redis add-on at all.
const redisPubSub = REDIS_URL ? new RedisPubSub(REDIS_URL, handleRedisMessage, log) : null;

// Set of roomIds that already have a doc.on('update') broadcast handler
// registered, so we don't double-register across reconnects/rejoins.
const wiredRooms = new Set<string>();

// In-flight explain/fix responses, keyed by requestId. Every instance
// accumulates from the token frames it sees (its own or Redis-relayed), so
// each instance's room history ends up identical without shipping the whole
// entry a second time on completion.
const panelBuffers = new Map<string, AiPanelEntry>();

function wireRoomBroadcast(room: Room): void {
  if (wiredRooms.has(room.roomId)) return;
  wiredRooms.add(room.roomId);

  room.doc.on("update", (update: Uint8Array, origin: unknown) => {
    const tag = origin as UpdateOrigin;
    const sourceUserId = tag?.userId ?? "unknown";

    const message: ServerMessage = {
      type: "doc-update",
      roomId: room.roomId,
      update: Buffer.from(update).toString("base64"),
      sourceUserId,
    };

    broadcastLocal(room, message, tag?.excludeConnId);
    log(
      `[merge] room=${room.roomId} source=${sourceUserId} bytes=${update.length} fromRedis=${Boolean(
        tag?.fromRedis
      )}`
    );

    if (!tag?.fromRedis) {
      redisPubSub
        ?.publish(room.roomId, message)
        .catch((err) => log(`[redis:publish:error] ${err.message}`));
    }
  });
}

function broadcastLocal(room: Room, message: ServerMessage, excludeConnId?: string): void {
  const raw = JSON.stringify(message);
  for (const conn of room.connections.values()) {
    if (conn.connId === excludeConnId) continue;
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(raw);
    }
  }
}

// Panel frames go to *every* client in the room, including the requester —
// the panel is shared room state, not a private response (PRD 6.2).
function applyPanelMessage(room: Room, message: ServerMessage): void {
  if (message.type === "ai-panel-token") {
    const existing = panelBuffers.get(message.requestId);
    if (existing) {
      existing.text += message.token;
    } else {
      panelBuffers.set(message.requestId, {
        requestId: message.requestId,
        mode: message.mode,
        requestedBy: message.requestedBy,
        selectionSnippet: message.selectionSnippet,
        text: message.token,
      });
    }
  } else if (message.type === "ai-panel-done") {
    const buffered = panelBuffers.get(message.requestId);
    panelBuffers.delete(message.requestId);
    if (buffered) appendPanelEntry(room, buffered);
  } else if (message.type === "ai-panel-error") {
    // Drop the partial — an errored request leaves no history entry.
    panelBuffers.delete(message.requestId);
  }

  broadcastLocal(room, message);
}

function publishPanelMessage(room: Room, message: ServerMessage): void {
  applyPanelMessage(room, message);
  redisPubSub
    ?.publish(room.roomId, message)
    .catch((err) => log(`[redis:publish:error] ${err.message}`));
}

function handleRedisMessage(roomId: string, payload: ServerMessage): void {
  const room = getRoom(roomId);
  if (!room) return; // no local clients in this room on this instance

  if (payload.type === "doc-update") {
    wireRoomBroadcast(room);
    const origin: UpdateOrigin = {
      userId: payload.sourceUserId,
      excludeConnId: undefined,
      fromRedis: true,
    };
    Y.applyUpdate(room.doc, Buffer.from(payload.update, "base64"), origin);
    // Note: applying the update fires doc.on('update') above, which already
    // broadcasts locally and (because fromRedis=true) does not re-publish.
    return;
  }

  if (
    payload.type === "ai-panel-token" ||
    payload.type === "ai-panel-done" ||
    payload.type === "ai-panel-error"
  ) {
    applyPanelMessage(room, payload);
    return;
  }

  if (payload.type === "cursor") {
    room.presence.set(payload.userId, {
      userId: payload.userId,
      displayName: payload.displayName,
      color: payload.color,
      selection: payload.selection,
    });
  } else if (payload.type === "user-left") {
    room.presence.delete(payload.userId);
  }

  broadcastLocal(room, payload);
}

wss.on("connection", (ws: WebSocket) => {
  const connId = randomUUID();
  let joinedRoomId: string | null = null;
  let joinedUserId: string | null = null;

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(
        JSON.stringify({ type: "error", message: "malformed message" } satisfies ServerMessage)
      );
      return;
    }

    switch (msg.type) {
      case "join": {
        const room = getOrCreateRoom(msg.roomId);
        wireRoomBroadcast(room);
        redisPubSub
          ?.ensureSubscribed(msg.roomId)
          .catch((err) => log(`[redis:sub:error] ${err.message}`));

        joinedRoomId = msg.roomId;
        joinedUserId = msg.userId;

        const connection: Connection = { connId, ws, userId: msg.userId };
        room.connections.set(connId, connection);

        const existingPresence = room.presence.get(msg.userId);
        const presence: PresenceSnapshot = existingPresence ?? {
          userId: msg.userId,
          displayName: msg.displayName,
          color: colorForUser(msg.userId),
          selection: null,
        };
        presence.displayName = msg.displayName;
        room.presence.set(msg.userId, presence);

        const syncMessage: ServerMessage = {
          type: "sync",
          roomId: msg.roomId,
          docState: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64"),
          presence: Array.from(room.presence.values()),
          aiPanelHistory: room.aiPanelHistory,
        };
        ws.send(JSON.stringify(syncMessage));

        const joinedMessage: ServerMessage = {
          type: "user-joined",
          roomId: msg.roomId,
          userId: msg.userId,
          displayName: msg.displayName,
        };
        broadcastLocal(room, joinedMessage, connId);
        redisPubSub
          ?.publish(msg.roomId, joinedMessage)
          .catch((err) => log(`[redis:publish:error] ${err.message}`));

        log(`[join] room=${msg.roomId} user=${msg.userId} name=${msg.displayName} connId=${connId}`);
        break;
      }

      case "doc-update": {
        const room = getRoom(msg.roomId);
        const conn = room?.connections.get(connId);
        if (!room || !conn) return;

        const origin: UpdateOrigin = {
          userId: conn.userId,
          excludeConnId: connId,
          fromRedis: false,
        };
        try {
          Y.applyUpdate(room.doc, Buffer.from(msg.update, "base64"), origin);
        } catch (err) {
          log(`[doc-update:error] room=${msg.roomId} ${(err as Error).message}`);
        }
        break;
      }

      case "cursor": {
        const room = getRoom(msg.roomId);
        const conn = room?.connections.get(connId);
        if (!room || !conn) return;

        const color = colorForUser(msg.userId);
        const existing = room.presence.get(msg.userId);
        const displayName = existing?.displayName ?? msg.userId;
        room.presence.set(msg.userId, {
          userId: msg.userId,
          displayName,
          color,
          selection: msg.selection,
        });

        const cursorMessage: ServerMessage = {
          type: "cursor",
          roomId: msg.roomId,
          userId: msg.userId,
          displayName,
          color,
          selection: msg.selection,
        };
        broadcastLocal(room, cursorMessage, connId);
        redisPubSub
          ?.publish(msg.roomId, cursorMessage)
          .catch((err) => log(`[redis:publish:error] ${err.message}`));
        break;
      }

      case "ai-request": {
        const room = getRoom(msg.roomId);
        if (!room) return;

        const requestId = `req-${randomUUID()}`;
        const isPanelRequest = msg.mode === "explain" || msg.mode === "fix";

        if (!groq) {
          const message = "GROQ_API_KEY is not configured on the server";
          const errMsg: ServerMessage = isPanelRequest
            ? { type: "ai-panel-error", roomId: msg.roomId, requestId, message }
            : { type: "ai-error", roomId: msg.roomId, requestId, message };
          ws.send(JSON.stringify(errMsg));
          return;
        }

        log(`[ai-request] room=${msg.roomId} user=${msg.userId} mode=${msg.mode} requestId=${requestId}`);

        if (msg.mode === "inline-generate") {
          streamInlineGeneration({
            groq,
            room,
            requestId,
            cursorLine: msg.cursorPosition.line,
            cursorCol: msg.cursorPosition.col,
            contextWindow: msg.contextWindow,
            log,
            onToken: (token) =>
              broadcastLocal(room, { type: "ai-token", roomId: msg.roomId, requestId, token }),
            onDone: () => broadcastLocal(room, { type: "ai-done", roomId: msg.roomId, requestId }),
            onError: (message) =>
              broadcastLocal(room, { type: "ai-error", roomId: msg.roomId, requestId, message }),
          });
          break;
        }

        const requestedBy = room.presence.get(msg.userId)?.displayName ?? msg.userId;
        const selectionSnippet =
          msg.selectionText.length > 80 ? `${msg.selectionText.slice(0, 80)}…` : msg.selectionText;

        streamExplainFix({
          groq,
          mode: msg.mode,
          requestId,
          roomId: msg.roomId,
          selectionText: msg.selectionText,
          fileContext: msg.fileContext,
          log,
          onToken: (token) =>
            publishPanelMessage(room, {
              type: "ai-panel-token",
              roomId: msg.roomId,
              requestId,
              mode: msg.mode as "explain" | "fix",
              requestedBy,
              selectionSnippet,
              token,
            }),
          onDone: () =>
            publishPanelMessage(room, { type: "ai-panel-done", roomId: msg.roomId, requestId }),
          onError: (message) =>
            publishPanelMessage(room, {
              type: "ai-panel-error",
              roomId: msg.roomId,
              requestId,
              message,
            }),
        });
        break;
      }

      case "leave": {
        handleDisconnect(msg.roomId, msg.userId, connId);
        break;
      }
    }
  });

  ws.on("close", () => {
    if (joinedRoomId && joinedUserId) {
      handleDisconnect(joinedRoomId, joinedUserId, connId);
    }
  });
});

function handleDisconnect(roomId: string, userId: string, connId: string): void {
  const room = getRoom(roomId);
  if (!room) return;
  if (!room.connections.has(connId)) return; // already handled (e.g. leave then close)

  room.connections.delete(connId);
  room.presence.delete(userId);

  const leftMessage: ServerMessage = { type: "user-left", roomId, userId };
  broadcastLocal(room, leftMessage);
  redisPubSub?.publish(roomId, leftMessage).catch((err) => log(`[redis:publish:error] ${err.message}`));

  log(`[leave] room=${roomId} user=${userId} connId=${connId} remaining=${room.connections.size}`);

  scheduleEvictionIfEmpty(roomId, (evictedRoomId) => {
    wiredRooms.delete(evictedRoomId);
    log(`[evict] room=${evictedRoomId}`);
  });
}

server.listen(PORT, () => {
  log(
    `[listening] port=${PORT} redis=${REDIS_URL ?? "disabled (single instance)"} aiEnabled=${Boolean(groq)}`
  );
});
