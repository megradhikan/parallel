# Parallel

A real-time collaborative code editor. Multiple people edit one JavaScript file in a shared room, see each other's cursors and selections live, and get two AI features: code generated straight into the document at the cursor, and an explain/fix panel whose responses stream to everyone in the room.

Monaco for the editor, Yjs for conflict-free merging, a hand-rolled binding between the two, a plain `ws` server, and Redis pub/sub so the whole thing survives more than one backend instance.

```
browser (Monaco) ──hand-rolled binding──▶ Y.Doc ──base64 update──▶ ws server ──▶ Y.Doc (authoritative)
      ▲                                                                              │
      └────────────────────── doc-update broadcast ◀── Redis pub/sub ◀───────────────┘
                                                        (cross-instance fanout)
```

## What is interesting here

**The Monaco↔Yjs binding is hand-written** ([`useMonacoBinding.ts`](packages/frontend/src/hooks/useMonacoBinding.ts)). The official `y-monaco` package exists and works — writing it by hand is the point. Both directions run through one guard flag:

- **Monaco → Yjs**: `model.onDidChangeContent` gives `{rangeOffset, rangeLength, text}` per change; each becomes a delete and/or insert on the `Y.Text` inside a single transaction. Monaco orders changes from the end of the document backwards, so a multi-cursor edit (one event, several non-contiguous ranges) applies in order with no offset bookkeeping.
- **Yjs → Monaco**: `ytext.observe` gives a retain/insert/delete delta for any update this editor did not originate; each op becomes a `model.applyEdits()` call. Never `model.setValue()` — that resets the cursor and destroys the undo stack, which on a remote keystroke means losing your place several times a second.
- `isApplyingRemote` breaks the loop between the two. Without it, every remote edit written into the model fires the local-change handler, gets re-applied to the `Y.Text`, re-broadcast, and the clients ping-pong forever.

**AI-generated code is a real CRDT edit, not a rendering trick.** Each streamed token is inserted into the server's `Y.Text` in a transaction tagged with an origin, so it flows down the exact same `doc.on('update')` → broadcast → Redis-publish path as a human keystroke. The insertion point is anchored with `Y.createRelativePositionFromTypeIndex`, so if someone deletes a line above it mid-stream the remaining tokens still land in the right place instead of drifting.

**Explain/Fix deliberately does not go through the document.** Panel content is commentary *about* the code, not code — append-only shared state that needs no conflict resolution. Keeping it on its own message type avoids polluting the file and sidesteps an entire class of "two people ran Explain on overlapping selections" conflicts that never needed solving.

## Measured numbers

All from `pnpm test:load` against a single backend process on an M-series Mac, 200 cursor updates/sec/client into one room, real round-trip (send → receipt by another client):

| Connections | p50 | p95 | p99 | samples |
|---|---|---|---|---|
| 100 | 49 ms | 82 ms | 92 ms | 485,100 |
| 150 | 97 ms | 183 ms | 256 ms | 1,091,985 |
| 200 | 1,068 ms | 4,399 ms | 5,479 ms | 1,159,834 |

The cliff between 150 and 200 is the honest part: cursor fanout inside one room is O(n²) — every client's update is serialized to every other client — so at 200 connections a single Node process is pushing ~200k messages/sec and falls behind. Fixes in order of payoff: batch cursor frames per tick instead of per message, then shard rooms across instances (the Redis layer already supports it), then move presence off the document socket entirely.

`pnpm test:concurrent` (the correctness bar, section 10.2) passes end to end:

```
both clients converged to an identical string: true
same-offset concurrent inserts each present exactly once: true
overlapping bursts all present exactly once, none lost or duplicated (10 lines): true
deleted range is gone: true
insert made inside the deleted range survived exactly once: true
converged result parses as valid JavaScript: true
```

The parser check is doing real work, not decoration — it caught a genuine bug while this test was being written (the fixture produced duplicate `const` declarations, which converge byte-identically on both clients and are still broken JavaScript).

## Running it

```bash
pnpm install
cp .env.example packages/backend/.env     # add ANTHROPIC_API_KEY
cp .env.example packages/frontend/.env    # keep only VITE_WS_URL
pnpm dev:backend                          # :3001
pnpm dev:frontend                         # :5173
```

Open `http://localhost:5173`, click **New room**, and paste the room URL into a second browser window.

Without an `ANTHROPIC_API_KEY` everything except the two AI features works; an AI request returns a clear error instead of failing silently.

| Script | What it does |
|---|---|
| `pnpm test:concurrent` | Section 10.2 correctness test — convergence, no loss/duplication, and the result must parse as JavaScript |
| `pnpm test:load -- --n=150 --durationMs=10000` | Section 10.3 load test — p50/p95/p99 of real round-trip latency |
| `pnpm test:cross-instance` | Section 3.2.1 — proves two backend processes sync through Redis, not shared memory |
| `/binding-test.html` | Section 10.5 — two Monaco editors sharing one in-memory `Y.Doc`, no network, with a live in-sync indicator |

Cross-instance check, with Redis running and `REDIS_URL` set in `packages/backend/.env`:

```bash
PORT=3001 pnpm --filter backend start &
PORT=3002 pnpm --filter backend start &
pnpm test:cross-instance
```

## Environment

```
# packages/backend/.env
PORT=3001
ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_MODEL=claude-sonnet-5      # optional override
# REDIS_URL=redis://localhost:6379     # only needed to run >1 backend instance

# packages/frontend/.env
VITE_WS_URL=ws://localhost:3001
```

## Deploying

Backend on Railway (Node service + managed Redis add-on), frontend on Vercel as a static Vite build.

- Railway: root `packages/backend`, start command `pnpm start`, set `ANTHROPIC_API_KEY` and `REDIS_URL`. `/health` returns 200 with instance id, uptime, and active room count.
- Vercel: root `packages/frontend`, build `pnpm build`, output `dist`, set `VITE_WS_URL` to the Railway service's `wss://` URL. `vercel.json` rewrites `/room/:id` to the SPA entry.

## Scope

Single shared JavaScript file per room. No file tree, no code execution, no language server, no auth beyond a display-name prompt, desktop viewport only. Monaco's built-in JavaScript diagnostics are turned off on purpose — half-typed code from other people is not an error worth flagging.

## Notes on implementation choices

Three places where this departs from the spec it was built to, each deliberate:

- **Remote updates apply as Yjs deltas, not as a whole-document diff.** The spec called for diffing the model's content against the `Y.Text` and applying the difference. Translating the delta's retain/insert/delete ops directly into `applyEdits` ranges is more precise: a whole-document diff collapses a remote multi-cursor edit into one large range replacement, which moves every cursor and marker inside it.
- **Each binding instance tags transactions with a unique origin object**, not a shared string constant. Two bindings on one `Y.Doc` would otherwise ignore each other's edits — which is exactly the case the isolation harness exercises.
- **New rooms open onto a small seeded file** rather than an empty buffer, so a fresh room shows real syntax-highlighted code on first load.

Sibling project: [Pulse](https://github.com/megradhikan/pulse), the same sync architecture applied to plain text. The `join` / `sync` / `doc-update` / `user-joined` / `user-left` / `leave` / `error` message shapes are kept compatible between the two.

## License

MIT
