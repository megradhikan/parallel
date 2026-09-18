import { useEffect, useState } from "react";
import type { WsClient } from "../lib/wsClient";
import type { PresenceSnapshot, SelectionRange, ServerMessage } from "../lib/protocol";

export interface RemoteUser {
  userId: string;
  displayName: string;
  color: string;
  selection: SelectionRange | null;
}

// Tracks everyone else in the room: who is here and where their cursor or
// selection is. Self is filtered out — this user's own caret is Monaco's.
export function usePresence(
  wsClient: WsClient | null,
  initialPresence: PresenceSnapshot[],
  selfUserId: string
): RemoteUser[] {
  const [users, setUsers] = useState<Map<string, RemoteUser>>(new Map());

  useEffect(() => {
    setUsers((prev) => {
      const next = new Map(prev);
      for (const p of initialPresence) {
        if (p.userId === selfUserId) continue;
        next.set(p.userId, {
          userId: p.userId,
          displayName: p.displayName,
          color: p.color,
          selection: p.selection,
        });
      }
      return next;
    });
  }, [initialPresence, selfUserId]);

  useEffect(() => {
    if (!wsClient) return;
    return wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type === "cursor" && msg.userId !== selfUserId) {
        setUsers((prev) => {
          const next = new Map(prev);
          next.set(msg.userId, {
            userId: msg.userId,
            displayName: msg.displayName,
            color: msg.color,
            selection: msg.selection,
          });
          return next;
        });
      } else if (msg.type === "user-left") {
        setUsers((prev) => {
          if (!prev.has(msg.userId)) return prev;
          const next = new Map(prev);
          next.delete(msg.userId);
          return next;
        });
      }
    });
  }, [wsClient, selfUserId]);

  return Array.from(users.values());
}
