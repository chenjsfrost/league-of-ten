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

/**
 * A dungeon room over a private Supabase Realtime channel.
 * Presence tracks who is in the room; the earliest joiner is the host and runs the enemies.
 * Private channels need a signed-in user: RLS on realtime.messages (supabase/migrations) decides who may join.
 */
export class Room {
  members: Member[] = [];
  private channel: RealtimeChannel;
  private handlers = new Map<string, Handler[]>();
  private memberListeners: ((members: Member[]) => void)[] = [];

  constructor(
    readonly code: string,
    readonly me: Member,
  ) {
    this.channel = supabase.channel(`dungeon:${code}`, {
      config: { private: true, broadcast: { self: false }, presence: { key: me.id } },
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
          void this.leave();
          return;
        }
        this.members = all.slice(0, MAX_PLAYERS);
        settle("ok");
        for (const l of this.memberListeners) l(this.members);
      });

      // Private channels authorize with the user's JWT, so hand Realtime the current session token first.
      supabase.realtime.setAuth().then(
        () =>
          this.channel.subscribe(async (status) => {
            if (status === "SUBSCRIBED") {
              const res = await this.channel.track(this.me);
              if (res !== "ok") settle("error");
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              settle("error");
            }
          }),
        () => settle("error"),
      );
    });
  }

  async leave() {
    await supabase.removeChannel(this.channel);
  }
}
