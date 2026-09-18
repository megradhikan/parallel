import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import type { ServerMessage } from "./protocol.js";

export const INSTANCE_ID = randomUUID();

interface FanoutEnvelope {
  instanceId: string;
  payload: ServerMessage;
}

// One channel per room (`room:{roomId}:updates`). Every cross-instance
// message — doc-update, cursor, user-joined/left, and the AI panel frames —
// goes through here, so a room split across backend instances converges on
// both the document and the shared AI panel.
export class RedisPubSub {
  private pub: Redis;
  private sub: Redis;
  private subscribedChannels = new Set<string>();

  constructor(
    redisUrl: string,
    private onRemoteMessage: (roomId: string, payload: ServerMessage) => void,
    private log: (msg: string) => void
  ) {
    this.pub = new Redis(redisUrl, { lazyConnect: false });
    this.sub = new Redis(redisUrl, { lazyConnect: false });

    this.pub.on("error", (err) => this.log(`[redis:pub:error] ${err.message}`));
    this.sub.on("error", (err) => this.log(`[redis:sub:error] ${err.message}`));

    this.sub.on("message", (channel: string, raw: string) => {
      const roomId = channel.split(":")[1];
      let envelope: FanoutEnvelope;
      try {
        envelope = JSON.parse(raw);
      } catch {
        return;
      }
      if (envelope.instanceId === INSTANCE_ID) return; // echo of our own publish
      this.onRemoteMessage(roomId, envelope.payload);
    });
  }

  private channelFor(roomId: string): string {
    return `room:${roomId}:updates`;
  }

  async ensureSubscribed(roomId: string): Promise<void> {
    const channel = this.channelFor(roomId);
    if (this.subscribedChannels.has(channel)) return;
    this.subscribedChannels.add(channel);
    await this.sub.subscribe(channel);
    this.log(`[redis:subscribe] channel=${channel}`);
  }

  async publish(roomId: string, payload: ServerMessage): Promise<void> {
    const envelope: FanoutEnvelope = { instanceId: INSTANCE_ID, payload };
    await this.pub.publish(this.channelFor(roomId), JSON.stringify(envelope));
  }

  async close(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
