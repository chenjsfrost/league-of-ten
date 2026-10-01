import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../supabase";
import { PLAYER_COLORS } from "./models";
import { workerInterval } from "./ticker";

export const MAX_PLAYERS = 10;

/** Seats go stale after 15 s without a heartbeat (see supabase/migrations/*_room_seats.sql). */
const HEARTBEAT_MS = 5000;
const MIN_REFRESH_MS = 1000;
/** Messages signed further than this from the server clock are dropped, which stops old ones being replayed. */
const MAX_MESSAGE_AGE_MS = 10_000;
/** Per sender and event type: sustained messages per second, which is also the burst size. */
const RATE_LIMIT = 60;
const MAX_PAYLOAD_LENGTH = 16_384;

const SIGNING = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGNATURE = { name: "ECDSA", hash: "SHA-256" } as const;

export interface Member {
  /** Seat id, assigned by the server. One seat per account per room. */
  id: string;
  userId: string;
  name: string;
  color: number;
  /** Server time in ms. The earliest member is the host. */
  joinedAt: number;
}

interface Seat extends Member {
  publicKey: string;
}

interface SeatRow {
  id: string;
  user_id: string;
  name: string;
  public_key: string;
  joined_at: number;
}

/** Every broadcast is wrapped in one of these: event, from, sequence number, server time, JSON data, signature. */
interface Envelope {
  e: string;
  f: string;
  n: number;
  t: number;
  d: string;
  s: string;
}

type Handler = (payload: any, from: string) => void;

/**
 * A dungeon room over a Supabase Realtime channel.
 *
 * The server assigns seats (see join_room in the migration), so nobody can choose their own place in the
 * host order. A member is anyone with a live seat who is also in the channel's presence. Each session signs
 * its messages with a key registered on its seat, and handlers only see messages that verify, along with
 * the sender's seat id. Payload fields can't be trusted to say who sent them.
 */
export class Room {
  members: Member[] = [];
  /** Set once join() resolves "ok". */
  me!: Member;

  private channel?: RealtimeChannel;
  private signingKey?: CryptoKey;
  private seats = new Map<string, Seat>();
  private present = new Set<string>();
  private verifyKeys = new Map<string, Promise<CryptoKey>>();
  private lastSeq = new Map<string, number>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private handlers = new Map<string, Handler[]>();
  private memberListeners: ((members: Member[]) => void)[] = [];
  private lostListeners: (() => void)[] = [];
  private membersKey = "";
  private seq = 0;
  private serverOffset = 0;
  private outbox = Promise.resolve();
  private inbox = Promise.resolve();
  private lastRefresh = 0;
  private refreshQueued = false;
  private stopHeartbeat?: () => void;
  private closed = false;
  private lost = false;

  constructor(readonly code: string) {}

  get hostId(): string {
    return this.members[0]?.id ?? this.me.id;
  }

  get isHost(): boolean {
    return this.hostId === this.me.id;
  }

  on(event: string, handler: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
  }

  onMembers(listener: (members: Member[]) => void) {
    this.memberListeners.push(listener);
  }

  /** Called if the server drops our seat, e.g. because the same account joined from another tab. */
  onLost(listener: () => void) {
    this.lostListeners.push(listener);
  }

  send(event: string, payload: unknown) {
    const key = this.signingKey;
    const channel = this.channel;
    if (!key || !channel || this.closed) return;
    const envelope = { e: event, f: this.me.id, n: this.seq++, t: Math.round(this.serverNow()), d: JSON.stringify(payload) };
    // Signing is async; chain it so messages go out in order.
    this.outbox = this.outbox
      .then(async () => {
        const sig = await crypto.subtle.sign(SIGNATURE, key, signedBytes(this.code, envelope));
        void channel.send({ type: "broadcast", event: "m", payload: { ...envelope, s: toBase64(sig) } });
      })
      .catch(() => {});
  }

  async join(): Promise<"ok" | "full" | "error"> {
    const keys = await crypto.subtle.generateKey(SIGNING, false, ["sign", "verify"]);
    const publicKey = toBase64(await crypto.subtle.exportKey("raw", keys.publicKey));
    const { data, error } = await supabase.rpc("join_room", { p_room: this.code, p_public_key: publicKey });
    if (error) return error.message === "room_full" ? "full" : "error";

    this.applySeats(data);
    const mine = this.seats.get(data.id);
    if (!mine) return "error";
    this.me = mine;
    this.signingKey = keys.privateKey;

    const channel = supabase.channel(`dungeon:${this.code}`, {
      config: { broadcast: { self: false }, presence: { key: mine.id } },
    });
    this.channel = channel;
    channel.on("broadcast", { event: "m" }, ({ payload }) => {
      this.inbox = this.inbox.then(() => this.receive(payload)).catch(() => {});
    });

    const result = await new Promise<"ok" | "error">((resolve) => {
      channel.on("presence", { event: "sync" }, () => {
        this.present = new Set(Object.keys(channel.presenceState()));
        if ([...this.present].some((id) => !this.seats.has(id))) this.requestRefresh();
        this.updateMembers();
        if (this.present.has(mine.id)) resolve("ok");
      });
      channel.subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          const res = await channel.track({ online: true });
          if (res !== "ok") resolve("error");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          resolve("error");
        }
      });
    });

    if (result !== "ok") {
      await this.leave();
      return result;
    }
    this.stopHeartbeat = workerInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    return "ok";
  }

  async leave() {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat?.();
    if (this.channel) await supabase.removeChannel(this.channel);
    if (this.me) await supabase.rpc("leave_room", { p_id: this.me.id });
  }

  private async receive(raw: unknown) {
    if (!isEnvelope(raw) || this.closed) return;
    const sender = this.seats.get(raw.f);
    if (!sender) {
      // Possibly someone who just joined and whose seat we haven't fetched yet.
      this.requestRefresh();
      return;
    }
    if (sender.id === this.me.id || !this.members.some((m) => m.id === sender.id)) return;
    if (raw.n <= (this.lastSeq.get(sender.id) ?? -1)) return;
    if (Math.abs(this.serverNow() - raw.t) > MAX_MESSAGE_AGE_MS) return;

    const signature = fromBase64(raw.s);
    if (!signature) return;
    const key = await this.verifyKeyFor(sender);
    if (!key || !(await crypto.subtle.verify(SIGNATURE, key, signature, signedBytes(this.code, raw)))) return;

    // Only verified messages count against the rate limit, so forgeries can't use up a real player's budget.
    if (!this.allow(`${sender.id}:${raw.e}`)) return;
    this.lastSeq.set(sender.id, raw.n);

    let payload: unknown;
    try {
      payload = JSON.parse(raw.d);
    } catch {
      return;
    }
    if (typeof payload !== "object" || payload === null) return;
    for (const h of this.handlers.get(raw.e) ?? []) {
      try {
        h(payload, sender.id);
      } catch (err) {
        console.warn(`Dropped bad "${raw.e}" message from ${sender.name}`, err);
      }
    }
  }

  private verifyKeyFor(seat: Seat): Promise<CryptoKey | undefined> {
    let key = this.verifyKeys.get(seat.id);
    if (!key) {
      const bytes = fromBase64(seat.publicKey);
      if (!bytes) return Promise.resolve(undefined);
      key = crypto.subtle.importKey("raw", bytes, SIGNING, false, ["verify"]);
      this.verifyKeys.set(seat.id, key);
    }
    return key.catch(() => undefined);
  }

  private allow(key: string): boolean {
    const now = performance.now();
    const b = this.buckets.get(key) ?? { tokens: RATE_LIMIT, at: now };
    b.tokens = Math.min(RATE_LIMIT, b.tokens + ((now - b.at) / 1000) * RATE_LIMIT);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }

  private serverNow() {
    return Date.now() + this.serverOffset;
  }

  private requestRefresh() {
    if (this.refreshQueued || !this.me) return;
    this.refreshQueued = true;
    const wait = Math.max(0, this.lastRefresh + MIN_REFRESH_MS - performance.now());
    window.setTimeout(() => {
      this.refreshQueued = false;
      void this.heartbeat();
    }, wait);
  }

  private async heartbeat() {
    if (this.closed || this.lost) return;
    this.lastRefresh = performance.now();
    const { data, error } = await supabase.rpc("room_heartbeat", { p_room: this.code, p_id: this.me.id });
    if (this.closed) return;
    if (error) {
      // Anything else is likely a network blip; the next heartbeat retries.
      if (error.message === "seat_lost") {
        this.lost = true;
        for (const l of this.lostListeners) l();
      }
      return;
    }
    this.applySeats(data);
    this.updateMembers();
  }

  private applySeats(data: { now: number; seats: SeatRow[] }) {
    this.serverOffset = data.now - Date.now();
    this.seats = new Map(
      data.seats.map((row): [string, Seat] => [
        row.id,
        {
          id: row.id,
          userId: row.user_id,
          name: row.name,
          color: colorFor(row.user_id),
          joinedAt: row.joined_at,
          publicKey: row.public_key,
        },
      ]),
    );
    for (const map of [this.verifyKeys, this.lastSeq]) {
      for (const id of map.keys()) if (!this.seats.has(id)) map.delete(id);
    }
  }

  private updateMembers() {
    if (!this.me) return;
    const members = [...this.seats.values()]
      .filter((s) => s.id === this.me.id || this.present.has(s.id))
      .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))
      .slice(0, MAX_PLAYERS);
    const key = members.map((m) => m.id).join();
    if (key === this.membersKey) return;
    this.membersKey = key;
    this.members = members;
    for (const l of this.memberListeners) l(members);
  }
}

function isEnvelope(v: any): v is Envelope {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.e === "string" &&
    v.e.length <= 16 &&
    typeof v.f === "string" &&
    Number.isSafeInteger(v.n) &&
    Number.isFinite(v.t) &&
    typeof v.d === "string" &&
    v.d.length <= MAX_PAYLOAD_LENGTH &&
    typeof v.s === "string" &&
    v.s.length <= 128
  );
}

function signedBytes(room: string, m: Omit<Envelope, "s">) {
  return new TextEncoder().encode([room, m.e, m.f, m.n, m.t, m.d].join("\n"));
}

function toBase64(buf: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function colorFor(userId: string) {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PLAYER_COLORS[Math.abs(h) % PLAYER_COLORS.length];
}
