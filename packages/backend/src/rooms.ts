import * as Y from "yjs";
import type { WebSocket } from "ws";
import type { AiPanelEntry, PresenceSnapshot } from "./protocol.js";

export interface Connection {
  connId: string;
  ws: WebSocket;
  userId: string;
}

export interface Room {
  roomId: string;
  doc: Y.Doc;
  ytext: Y.Text;
  connections: Map<string, Connection>;
  presence: Map<string, PresenceSnapshot>;
  aiPanelHistory: AiPanelEntry[];
  evictionTimer: ReturnType<typeof setTimeout> | null;
}

const EVICTION_MS = 10 * 60 * 1000;
const PANEL_HISTORY_LIMIT = 20;

const rooms = new Map<string, Room>();

const COLOR_PALETTE = [
  "#4f46e5",
  "#059669",
  "#db2777",
  "#d97706",
  "#0891b2",
  "#7c3aed",
  "#dc2626",
  "#65a30d",
];

const STARTER_FILE = `// Shared JavaScript file — everyone in this room edits this same buffer.
function total(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

function applyDiscount(items, percent) {
  const discounted = items.map((item) => ({ ...item, price: item.price * (1 - percent) }));
  return total(discounted);
}
`;

export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return COLOR_PALETTE[hash % COLOR_PALETTE.length];
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function getOrCreateRoom(roomId: string): Room {
  const existing = rooms.get(roomId);
  if (existing) {
    if (existing.evictionTimer) {
      clearTimeout(existing.evictionTimer);
      existing.evictionTimer = null;
    }
    return existing;
  }
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  // Seed a small file so a fresh room opens onto real, highlightable code
  // instead of an empty buffer. Tagged 'seed' so it never looks like a user
  // edit in the logs.
  doc.transact(() => ytext.insert(0, STARTER_FILE), "seed");

  const room: Room = {
    roomId,
    doc,
    ytext,
    connections: new Map(),
    presence: new Map(),
    aiPanelHistory: [],
    evictionTimer: null,
  };
  rooms.set(roomId, room);
  return room;
}

export function appendPanelEntry(room: Room, entry: AiPanelEntry): void {
  room.aiPanelHistory.push(entry);
  if (room.aiPanelHistory.length > PANEL_HISTORY_LIMIT) {
    room.aiPanelHistory.splice(0, room.aiPanelHistory.length - PANEL_HISTORY_LIMIT);
  }
}

export function scheduleEvictionIfEmpty(
  roomId: string,
  onEvict: (roomId: string) => void
): void {
  const room = rooms.get(roomId);
  if (!room || room.connections.size > 0) return;
  if (room.evictionTimer) clearTimeout(room.evictionTimer);
  room.evictionTimer = setTimeout(() => {
    rooms.delete(roomId);
    onEvict(roomId);
  }, EVICTION_MS);
}

export function getRoomCount(): number {
  return rooms.size;
}
