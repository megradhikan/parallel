// Mirrors packages/backend/src/rooms.ts colorForUser so this user's own color
// in the presence bar matches the color other clients are given for them.
const PALETTE = ["#4f46e5", "#059669", "#db2777", "#d97706", "#0891b2", "#7c3aed", "#dc2626", "#65a30d"];

export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}
