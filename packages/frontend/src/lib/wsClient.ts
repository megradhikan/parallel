import type { ClientMessage, ServerMessage } from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

type MessageListener = (msg: ServerMessage) => void;
type StatusListener = (status: ConnectionStatus) => void;

const MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

// Raw WebSocket wrapper: connect, reconnect with exponential backoff
// (500ms doubling to 8s, capped at 10 attempts), message send/receive.
// Section 6.3: on reconnect we do NOT discard local state — the caller
// (useYDoc) keeps its Y.Doc across reconnects and re-sends 'join'; Yjs's
// offline-first guarantee merges edits made while disconnected.
export class WsClient {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private manuallyClosed = false;
  private status: ConnectionStatus = "connecting";
  private queue: ClientMessage[] = [];
  private messageListeners = new Set<MessageListener>();
  private statusListeners = new Set<StatusListener>();

  constructor(private url: string) {
    this.connect();
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }

  private connect(): void {
    this.ws = new WebSocket(this.url);
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");

    this.ws.onopen = () => {
      this.attempts = 0;
      this.setStatus("open");
      this.flushQueue();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        this.messageListeners.forEach((l) => l(msg));
      } catch {
        // ignore malformed frame
      }
    };

    this.ws.onclose = () => {
      if (this.manuallyClosed) return;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.attempts >= MAX_ATTEMPTS) {
      this.setStatus("closed");
      return;
    }
    const delay = Math.min(BASE_DELAY_MS * 2 ** this.attempts, MAX_DELAY_MS);
    this.attempts += 1;
    this.setStatus("reconnecting");
    setTimeout(() => this.connect(), delay);
  }

  private flushQueue(): void {
    const pending = this.queue;
    this.queue = [];
    pending.forEach((msg) => this.send(msg));
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  close(): void {
    this.manuallyClosed = true;
    this.ws?.close();
  }
}
