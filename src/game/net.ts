import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../supabase";

export const MAX_PLAYERS = 10;

export interface Member {
  /** Per-session id, so one account can test in two tabs. */
  id: string;
  userId: string;
  name: string;
  color: number;
  joinedAt: number;
}

type Handler = (payload: any) => void;

/** "closed" is final: the channel is gone and will not rejoin. */
export type Connection = "connected" | "reconnecting" | "closed";

const RETRACK_DELAY_MS = 2000;

/**
 * A dungeon room over a Supabase Realtime channel.
 * Presence tracks who is in the room; the earliest joiner is the host and runs the enemies.
 */
export class Room {
  members: Member[] = [];
  private channel: RealtimeChannel;
  private handlers = new Map<string, Handler[]>();
  private memberListeners: ((members: Member[]) => void)[] = [];
  private connectionListeners: ((connection: Connection) => void)[] = [];
  private connection: Connection = "reconnecting";
  /** Set once we start leaving, so our own close isn't reported as a dropped connection. */
  private left = false;

  constructor(
    readonly code: string,
    readonly me: Member,
  ) {
    this.channel = supabase.channel(`dungeon:${code}`, {
      config: { broadcast: { self: false }, presence: { key: me.id } },
    });
  }

  get hostId(): string {
    return this.members[0]?.id ?? this.me.id;
  }

  get isHost(): boolean {
    return this.hostId === this.me.id;
  }

  on(event: string, handler: Handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
      this.channel.on("broadcast", { event }, ({ payload }) => {
        for (const h of this.handlers.get(event) ?? []) h(payload);
      });
    }
    this.handlers.get(event)!.push(handler);
  }

  onMembers(listener: (members: Member[]) => void) {
    this.memberListeners.push(listener);
  }

  /** Fires whenever the channel drops, comes back or closes, for the whole life of the room. */
  onConnection(listener: (connection: Connection) => void) {
    this.connectionListeners.push(listener);
  }

  private setConnection(connection: Connection) {
    if (connection === this.connection || this.connection === "closed" || this.left) return;
    this.connection = connection;
    for (const l of this.connectionListeners) l(connection);
  }

  send(event: string, payload: unknown) {
    void this.channel.send({ type: "broadcast", event, payload });
  }

  /** Register all handlers with on() before calling join(). */
  join(): Promise<"ok" | "full" | "error"> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: "ok" | "full" | "error") => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      this.channel.on("presence", { event: "sync" }, () => {
        const state = this.channel.presenceState<Member>();
        const all = Object.values(state)
          .map((metas) => metas[0])
          .filter(Boolean)
          .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
        // Only the first ten joiners count. Anyone later sees they're over the cap and leaves.
        const myIndex = all.findIndex((m) => m.id === this.me.id);
        if (myIndex === -1) return; // our own presence hasn't arrived yet
        if (myIndex >= MAX_PLAYERS) {
          settle("full");
          // Can also happen mid-game, if the room filled up while we were reconnecting.
          this.setConnection("closed");
          void this.leave();
          return;
        }
        this.members = all.slice(0, MAX_PLAYERS);
        settle("ok");
        for (const l of this.memberListeners) l(this.members);
      });

      const track = async () => {
        const res = await this.channel.track(this.me);
        if (res === "ok") this.setConnection("connected");
        else if (!settled) settle("error");
        else if (!this.left && this.channel.state === "joined") window.setTimeout(track, RETRACK_DELAY_MS);
      };

      // This callback keeps firing after the join: the client rejoins on its own after an error,
      // and we re-track presence each time so the others see us again. CLOSED never rejoins.
      this.channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          // Rejoin as the newest member. Keeping our old joinedAt would make a host that dropped
          // take the role back from whoever was promoted, and roll the dungeon back to its stale copy.
          if (settled) this.me.joinedAt = Date.now();
          void track();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          settle("error");
          this.setConnection("reconnecting");
        } else if (status === "CLOSED") {
          settle("error");
          this.setConnection("closed");
        }
      });
    });
  }

  async leave() {
    this.left = true;
    await supabase.removeChannel(this.channel);
  }
}
