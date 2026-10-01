import * as THREE from "three";
import {
  buildDungeonMesh,
  canStand,
  disposeGroup,
  generateDungeon,
  isFloorTile,
  moveWithCollision,
  roomCenter,
  TILE,
  tileToWorld,
  type DungeonData,
} from "./dungeon";
import { CharacterModel, createEnemy, createHero, SWORD_ARC, SWORD_RANGE, type EnemyType } from "./models";
import { MAX_PLAYERS, type Connection, type Member, type Room } from "./net";
import { mulberry32, randomSeed } from "./rng";
import { workerInterval } from "./ticker";

const PLAYER_RADIUS = 0.45;
const PLAYER_SPEED = 7;
const MAX_HP = 100;
const ATTACK_COOLDOWN = 0.38;
const HIT_DELAY = 0.08;
const SWORD_DAMAGE = 25;
const CRIT_CHANCE = 0.15;
const KNOCKBACK = 9;
const DASH_DURATION = 0.18;
const DASH_SPEED = 22;
const DASH_COOLDOWN = 1.5;
const RESPAWN_TIME = 5;
const NEXT_FLOOR_DELAY = 4;
const MAX_ENEMIES = 70;

// Network pacing. Supabase Realtime bills and rate-limits per message, so keep these modest.
const NET_INTERVAL = 0.1;
const IDLE_NET_INTERVAL = 1;
/** Clients warn once the host has been silent this long (it sends enemies at least every IDLE_NET_INTERVAL). */
const HOST_STALL_MS = 3000;
/** After this long disconnected or with a silent host, offer a way back to the lobby. */
const OFFER_LEAVE_MS = 15000;
const FLOOR_ANNOUNCE_INTERVAL = 3;

// Bounds for validating incoming payloads.
const WORLD_LIMIT = 1000;
const MAX_FLOOR = 10_000;
const MAX_MESSAGE_LENGTH = 80;

const ENEMY_TYPES: EnemyType[] = ["skeleton", "brute"];
const ENEMY_STATS: Record<
  EnemyType,
  { hp: number; speed: number; damage: number; reach: number; radius: number; windup: number; cooldown: number; knockback: number }
> = {
  skeleton: { hp: 60, speed: 4.4, damage: 9, reach: 1.7, radius: 0.45, windup: 0.45, cooldown: 1.1, knockback: 1 },
  brute: { hp: 240, speed: 2.7, damage: 24, reach: 2.6, radius: 0.85, windup: 0.85, cooldown: 1.9, knockback: 0.25 },
};
/** Enemies notice players within this many tiles of walking distance, and give up past LEASH. */
const AGGRO_TILES = 9;
const LEASH_TILES = 22;

interface EnemyState {
  id: number;
  type: EnemyType;
  x: number;
  z: number;
  r: number;
  hp: number;
  maxHp: number;
  /** Seconds into the attack windup, or -1 when not attacking. */
  windup: number;
  cooldown: number;
  kx: number;
  kz: number;
  aggro: boolean;
}

interface EnemyView {
  model: CharacterModel;
  lastHp: number;
  /** Seconds since death, or -1 while alive. */
  dying: number;
}

interface RemotePlayer {
  model: CharacterModel;
  x: number;
  z: number;
  r: number;
  hp: number;
  swing: number;
  lastSeen: number;
}

/** [id, typeIndex, x, z, r, hp, maxHp, windingUp] */
type EnemySnapshot = [number, number, number, number, number, number, number, 0 | 1];

export interface HudElements {
  floor: HTMLElement;
  room: HTMLElement;
  enemies: HTMLElement;
  party: HTMLElement;
  hpFill: HTMLElement;
  hpText: HTMLElement;
  dashFill: HTMLElement;
  kills: HTMLElement;
  death: HTMLElement;
  toast: HTMLElement;
  netBanner: HTMLElement;
  netText: HTMLElement;
  netLeave: HTMLButtonElement;
}

export class Game {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly mouse = new THREE.Vector2();
  private readonly aim = new THREE.Vector3();
  private readonly keys = new Set<string>();
  private readonly playerLight = new THREE.PointLight(0xffe2c0, 30, 16, 1.4);
  private readonly model: CharacterModel;

  private dungeon?: DungeonData;
  private dungeonMesh?: THREE.Group;
  private floor = 0;
  private seed = 0;

  private me = {
    x: 0,
    z: 0,
    r: 0,
    hp: MAX_HP,
    attackCd: 0,
    hitPending: -1,
    swingCount: 0,
    dashT: 0,
    dashCd: 0,
    dashX: 0,
    dashZ: 0,
    deadT: 0,
    kills: 0,
    moving: false,
  };
  private mouseDown = false;
  private shake = 0;

  private readonly remotes = new Map<string, RemotePlayer>();
  private readonly enemies = new Map<number, EnemyState>();
  private readonly enemyViews = new Map<number, EnemyView>();
  private nextEnemyId = 1;
  private flowField = new Int16Array(0);
  private flowT = 0;
  private clearedT = -1;
  private wasHost = false;
  private connection: Connection = "connected";
  /** performance.now() when the channel last stopped being connected. */
  private disconnectedAt = 0;
  /** performance.now() of the last floor or enemy snapshot from the host. */
  private lastHostMsgAt = 0;
  /** Host only: when each `${player}:${enemy}` pair last landed a hit. */
  private readonly lastHitAt = new Map<string, number>();

  private netT = 0;
  private idleT = 0;
  private lastSentKey = "";
  private enemyNetT = 0;
  private floorAnnounceT = 0;
  private hudT = 0;
  private toastTimer = 0;
  private raf = 0;
  private disposed = false;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly room: Room,
    private readonly hud: HudElements,
    private readonly onExit: () => void,
  ) {
    this.scene.background = new THREE.Color(0x050407);
    this.scene.fog = new THREE.Fog(0x050407, 22, 48);
    this.scene.add(new THREE.HemisphereLight(0x8a96c0, 0x1a0c0c, 0.9));
    this.scene.add(this.playerLight);

    this.model = createHero(room.me.name, room.me.color);
    this.scene.add(this.model.root);

    this.registerNetHandlers();
    this.bindInput();
  }

  /** Call after room.join() resolves "ok". */
  start() {
    this.wasHost = this.room.isHost;
    this.markHostAlive();
    if (this.room.isHost) this.startFloor(1, randomSeed());
    else {
      this.requestFloor();
      this.toast("Joining the party…");
    }
    this.clock.start();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.update(Math.min(0.1, this.clock.getDelta()));
    };
    loop();

    // Browsers pause requestAnimationFrame in background tabs. Keep simulating (and, for the host,
    // running the enemies) from a worker timer, which is not throttled like page timers are.
    this.cleanup.push(
      workerInterval(() => {
        if (document.hidden && !this.disposed) this.update(Math.min(0.1, this.clock.getDelta()), false);
      }, 50),
    );
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach((fn) => fn());
    void this.room.leave();
    for (const v of this.enemyViews.values()) v.model.dispose();
    for (const p of this.remotes.values()) p.model.dispose();
    this.model.dispose();
    if (this.dungeonMesh) disposeGroup(this.dungeonMesh);
    window.clearTimeout(this.toastTimer);
    this.hud.netBanner.hidden = true;
  }

  // ---------------------------------------------------------------- networking

  private registerNetHandlers() {
    const room = this.room;
    // `from` is the sender's seat id, which Room has checked against the message signature.
    // Payload fields are still untrusted, so check their shape and range before using them.
    const fromHost = (from: string) => from === room.hostId && !room.isHost;

    room.on("p", (p, from) => {
      if (!isNum(p.x, WORLD_LIMIT) || !isNum(p.z, WORLD_LIMIT) || !isNum(p.r, 10) || !isNum(p.hp, MAX_HP) || !Number.isInteger(p.sw)) return;
      const member = room.members.find((m) => m.id === from);
      if (!member) return;
      let remote = this.remotes.get(from);
      if (!remote) {
        const model = createHero(member.name, member.color);
        model.root.position.set(p.x, 0, p.z);
        this.scene.add(model.root);
        remote = { model, x: p.x, z: p.z, r: p.r, hp: p.hp, swing: p.sw, lastSeen: 0 };
        this.remotes.set(from, remote);
      }
      if (p.sw !== remote.swing) remote.model.swing();
      Object.assign(remote, { x: p.x, z: p.z, r: p.r, hp: Math.max(0, p.hp), swing: p.sw, lastSeen: performance.now() });
    });

    room.on("floor", (p, from) => {
      if (!fromHost(from) || !isInt(p.f, 1, MAX_FLOOR) || !isInt(p.s, 0, 0xffffffff)) return;
      this.markHostAlive();
      if (p.f !== this.floor || p.s !== this.seed) this.startFloor(p.f, p.s);
    });

    room.on("need-floor", () => {
      if (room.isHost && this.floor > 0) this.announceFloor();
    });

    room.on("e", (p, from) => {
      if (!fromHost(from)) return;
      this.markHostAlive();
      if (p.f !== this.floor || p.s !== this.seed) return;
      if (!Array.isArray(p.l) || p.l.length > MAX_ENEMIES || !p.l.every(isEnemySnapshot)) return;
      const seen = new Set<number>();
      for (const [id, typeIndex, x, z, r, hp, maxHp, windup] of p.l as EnemySnapshot[]) {
        seen.add(id);
        const e = this.enemies.get(id);
        const type = ENEMY_TYPES[typeIndex];
        if (e) Object.assign(e, { x, z, r, hp, maxHp, windup: windup ? 0 : -1 });
        else this.enemies.set(id, { id, type, x, z, r, hp, maxHp, windup: windup ? 0 : -1, cooldown: 0, kx: 0, kz: 0, aggro: true });
      }
      for (const id of this.enemies.keys()) if (!seen.has(id)) this.enemies.delete(id);
    });

    room.on("hit", (p, from) => {
      if (!room.isHost || !Number.isInteger(p.e) || !isNum(p.d, SWORD_DAMAGE * 2) || p.d < 0) return;
      if (!isNum(p.kx, KNOCKBACK + 0.01) || !isNum(p.kz, KNOCKBACK + 0.01)) return;
      // A swing hits each enemy at most once, so ignore hits faster than the attack cooldown (with some
      // slack for network jitter).
      const key = `${from}:${p.e}`;
      const now = performance.now();
      if (now - (this.lastHitAt.get(key) ?? -Infinity) < ATTACK_COOLDOWN * 750) return;
      this.lastHitAt.set(key, now);
      this.applyHit(p.e, p.d, p.kx, p.kz, from);
    });

    room.on("ph", (p, from) => {
      if (fromHost(from) && p.t === room.me.id && isNum(p.d, MAX_HP) && p.d > 0) this.takeDamage(p.d);
    });

    room.on("kill", (p, from) => {
      if (fromHost(from) && p.by === room.me.id) this.me.kills++;
    });

    room.on("msg", (p, from) => {
      if (fromHost(from) && typeof p.text === "string") this.toast(p.text.slice(0, MAX_MESSAGE_LENGTH));
    });

    room.onMembers((members) => this.onMembersChanged(members));

    room.onConnection((connection) => {
      const was = this.connection;
      this.connection = connection;
      if (connection !== "connected") {
        if (was === "connected") this.disconnectedAt = performance.now();
      } else if (was !== "connected") {
        this.toast("Reconnected");
        // Snapshots couldn't reach us while we were away; give the host a fresh grace period.
        // If we were the host, the presence sync that follows demotes us and fetches the live floor.
        this.markHostAlive();
        if (!room.isHost) this.requestFloor();
      }
    });
  }

  private onMembersChanged(members: Member[]) {
    const ids = new Set(members.map((m) => m.id));
    for (const [id, remote] of this.remotes) {
      if (!ids.has(id)) {
        remote.model.dispose();
        this.remotes.delete(id);
      }
    }

    const isHost = this.room.isHost;
    if (isHost && !this.wasHost && this.floor > 0) {
      // Host migration: the previous host left, so we take over simulating the enemies we last saw.
      this.nextEnemyId = Math.max(0, ...this.enemies.keys()) + 1;
      for (const e of this.enemies.values()) e.windup = -1;
      this.toast("You are now the host");
      if (this.enemies.size === 0) this.clearedT = NEXT_FLOOR_DELAY;
    } else if (!isHost && this.wasHost) {
      this.markHostAlive();
      // Two players joined an empty room at once and the other one won, or we rejoined after a
      // drop and someone else took over; adopt their floor.
      this.requestFloor();
    }
    this.wasHost = isHost;
  }

  private requestFloor() {
    this.room.send("need-floor", {});
  }

  private markHostAlive() {
    this.lastHostMsgAt = performance.now();
  }

  private announceFloor() {
    this.room.send("floor", { f: this.floor, s: this.seed });
  }

  private announce(text: string) {
    this.toast(text);
    this.room.send("msg", { text });
  }

  // ---------------------------------------------------------------- floors

  private startFloor(floor: number, seed: number) {
    this.floor = floor;
    this.seed = seed;
    this.clearedT = -1;
    this.enemies.clear();
    for (const v of this.enemyViews.values()) v.model.dispose();
    this.enemyViews.clear();
    if (this.dungeonMesh) disposeGroup(this.dungeonMesh);

    this.dungeon = generateDungeon(seed);
    this.dungeonMesh = buildDungeonMesh(this.dungeon, floor);
    this.scene.add(this.dungeonMesh);
    this.flowField = new Int16Array(this.dungeon.size * this.dungeon.size);

    this.respawn();
    this.snapCamera();

    if (this.room.isHost) {
      this.spawnEnemies();
      this.announceFloor();
    }
    this.toast(`Floor ${floor}`);
  }

  private spawnEnemies() {
    const d = this.dungeon!;
    const rand = mulberry32(this.seed ^ 0xbeef);
    const party = Math.max(1, this.room.members.length);
    const hpScale = 1 + (this.floor - 1) * 0.2;
    const bruteChance = Math.min(0.45, 0.08 + this.floor * 0.06);
    for (const room of d.rooms.slice(1)) {
      const count = 2 + Math.floor(this.floor / 2) + Math.floor(party / 2) + (rand() < 0.5 ? 1 : 0);
      for (let i = 0; i < count && this.enemies.size < MAX_ENEMIES; i++) {
        const type: EnemyType = rand() < bruteChance ? "brute" : "skeleton";
        const tx = room.x + 1 + Math.floor(rand() * (room.w - 2));
        const ty = room.y + 1 + Math.floor(rand() * (room.h - 2));
        const { x, z } = tileToWorld(tx, ty);
        const maxHp = Math.round(ENEMY_STATS[type].hp * hpScale);
        const id = this.nextEnemyId++;
        this.enemies.set(id, { id, type, x, z, r: rand() * Math.PI * 2, hp: maxHp, maxHp, windup: -1, cooldown: 0, kx: 0, kz: 0, aggro: false });
      }
    }
  }

  private respawn() {
    const d = this.dungeon;
    if (!d) return;
    const spawn = d.rooms[0];
    const index = Math.max(0, this.room.members.findIndex((m) => m.id === this.room.me.id));
    const c = roomCenter(spawn);
    const angle = (index / MAX_PLAYERS) * Math.PI * 2;
    let x = c.x + Math.cos(angle) * 2.5;
    let z = c.z + Math.sin(angle) * 2.5;
    if (!canStand(d, x, z, PLAYER_RADIUS)) ({ x, z } = c);
    Object.assign(this.me, { x, z, hp: MAX_HP, deadT: 0, dashT: 0 });
    this.hud.death.hidden = true;
  }

  // ---------------------------------------------------------------- input

  private bindInput() {
    const canvas = this.renderer.domElement;
    const listen = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void) => {
      target.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener));
    };
    listen(window, "keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Space") {
        e.preventDefault();
        this.tryDash();
      }
      if (e.code === "Escape") this.onExit();
    });
    listen(window, "keyup", (e) => this.keys.delete(e.code));
    listen(this.hud.netLeave, "click", () => this.onExit());
    listen(window, "blur", () => {
      this.keys.clear();
      this.mouseDown = false;
    });
    listen(window, "mousemove", (e) => {
      this.mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    });
    listen(canvas, "mousedown", (e) => {
      if (e.button === 0) this.mouseDown = true;
      if (e.button === 2) this.tryDash();
    });
    listen(window, "mouseup", (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    listen(canvas, "contextmenu", (e) => e.preventDefault());
    listen(window, "resize", () => this.resize());
    this.resize();
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private moveInput() {
    const k = this.keys;
    let x = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    let z = (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0) - (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0);
    const len = Math.hypot(x, z);
    if (len > 0) {
      x /= len;
      z /= len;
    }
    return { x, z };
  }

  private tryDash() {
    const me = this.me;
    if (me.dashCd > 0 || me.hp <= 0 || !this.dungeon) return;
    let { x, z } = this.moveInput();
    if (x === 0 && z === 0) {
      x = Math.sin(me.r);
      z = Math.cos(me.r);
    }
    Object.assign(me, { dashT: DASH_DURATION, dashCd: DASH_COOLDOWN, dashX: x, dashZ: z });
  }

  // ---------------------------------------------------------------- main loop

  private update(dt: number, render = true) {
    const now = performance.now();
    if (this.dungeon) {
      this.updateLocalPlayer(dt);
      if (this.room.isHost) this.updateHost(dt);
      this.sendNet(dt);
    }
    this.updateRemotes(dt, now);
    this.updateEnemyViews(dt);
    this.updateCamera(dt);
    this.animateDungeon(now);

    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = 0.2;
      this.updateHud();
    }
    if (render) this.renderer.render(this.scene, this.camera);
  }

  private updateLocalPlayer(dt: number) {
    const me = this.me;
    const d = this.dungeon!;
    me.attackCd -= dt;
    me.dashCd = Math.max(0, me.dashCd - dt);

    if (me.hp <= 0) {
      me.deadT -= dt;
      if (me.deadT <= 0) this.respawn();
      me.moving = false;
    } else {
      // Face the mouse cursor.
      this.raycaster.setFromCamera(this.mouse, this.camera);
      if (this.raycaster.ray.intersectPlane(this.groundPlane, this.aim)) {
        me.r = Math.atan2(this.aim.x - me.x, this.aim.z - me.z);
      }

      if (me.dashT > 0) {
        me.dashT -= dt;
        moveWithCollision(d, me, me.dashX * DASH_SPEED * dt, me.dashZ * DASH_SPEED * dt, PLAYER_RADIUS);
        me.moving = true;
      } else {
        const input = this.moveInput();
        const slow = me.attackCd > 0 ? 0.6 : 1;
        moveWithCollision(d, me, input.x * PLAYER_SPEED * slow * dt, input.z * PLAYER_SPEED * slow * dt, PLAYER_RADIUS);
        me.moving = input.x !== 0 || input.z !== 0;
      }

      if (this.mouseDown && me.attackCd <= 0 && me.dashT <= 0) {
        me.attackCd = ATTACK_COOLDOWN;
        me.swingCount++;
        me.hitPending = HIT_DELAY;
        this.model.swing();
      }
    }

    if (me.hitPending >= 0) {
      me.hitPending -= dt;
      if (me.hitPending < 0) this.resolveSwing();
    }

    this.model.root.position.set(me.x, 0, me.z);
    this.model.body.rotation.y = me.r;
    this.model.body.rotation.z = lerp(this.model.body.rotation.z, me.hp <= 0 ? Math.PI / 2 : 0, dt * 8);
    this.model.setHp(me.hp / MAX_HP);
    this.model.update(dt, me.moving);
    this.playerLight.position.set(me.x, 3.5, me.z);
  }

  private resolveSwing() {
    const me = this.me;
    const fx = Math.sin(me.r);
    const fz = Math.cos(me.r);
    const minDot = Math.cos(SWORD_ARC);
    for (const e of this.enemies.values()) {
      const radius = ENEMY_STATS[e.type].radius;
      const dx = e.x - me.x;
      const dz = e.z - me.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SWORD_RANGE + radius) continue;
      if (dist > radius + 0.3 && (dx * fx + dz * fz) / dist < minDot) continue;

      const damage = Math.random() < CRIT_CHANCE ? SWORD_DAMAGE * 2 : SWORD_DAMAGE;
      const kx = (dx / (dist || 1)) * KNOCKBACK;
      const kz = (dz / (dist || 1)) * KNOCKBACK;
      this.enemyViews.get(e.id)?.model.flash();
      if (this.room.isHost) this.applyHit(e.id, damage, kx, kz, this.room.me.id);
      else this.room.send("hit", { e: e.id, d: damage, kx, kz });
    }
  }

  private takeDamage(amount: number) {
    const me = this.me;
    if (me.hp <= 0 || me.dashT > 0) return;
    me.hp = Math.max(0, me.hp - amount);
    this.model.flash();
    this.shake = 0.25;
    if (me.hp <= 0) {
      me.deadT = RESPAWN_TIME;
      this.hud.death.hidden = false;
    }
  }

  /** Host only: apply a sword hit from any player. */
  private applyHit(id: number, damage: number, kx: number, kz: number, by: string) {
    const e = this.enemies.get(id);
    if (!e) return;
    const k = ENEMY_STATS[e.type].knockback;
    e.hp -= damage;
    e.kx += kx * k;
    e.kz += kz * k;
    e.aggro = true;
    if (e.hp > 0) return;

    this.enemies.delete(id);
    if (by === this.room.me.id) this.me.kills++;
    else this.room.send("kill", { by });
    if (this.enemies.size === 0 && this.clearedT < 0) {
      this.clearedT = NEXT_FLOOR_DELAY;
      this.announce(`Floor ${this.floor} cleared! Descending…`);
    }
  }

  /** Host only: run enemy AI, floor progression and broadcast enemy state. */
  private updateHost(dt: number) {
    const d = this.dungeon!;

    if (this.clearedT >= 0) {
      this.clearedT -= dt;
      if (this.clearedT < 0) {
        this.startFloor(this.floor + 1, randomSeed());
        return;
      }
    }

    const targets: { id: string; x: number; z: number }[] = [];
    if (this.me.hp > 0) targets.push({ id: this.room.me.id, x: this.me.x, z: this.me.z });
    const stale = performance.now() - 5000;
    for (const [id, p] of this.remotes) if (p.hp > 0 && p.lastSeen > stale) targets.push({ id, x: p.x, z: p.z });

    this.flowT -= dt;
    if (this.flowT <= 0) {
      this.flowT = 0.25;
      this.buildFlowField(targets);
    }

    for (const e of this.enemies.values()) {
      const st = ENEMY_STATS[e.type];
      e.cooldown -= dt;

      if (e.kx !== 0 || e.kz !== 0) {
        moveWithCollision(d, e, e.kx * dt, e.kz * dt, st.radius);
        const decay = Math.exp(-10 * dt);
        e.kx *= decay;
        e.kz *= decay;
        if (Math.hypot(e.kx, e.kz) < 0.1) e.kx = e.kz = 0;
      }

      const tilesAway = this.flowAt(e.x, e.z);
      if (tilesAway < 0 || tilesAway > LEASH_TILES) e.aggro = false;
      else if (tilesAway <= AGGRO_TILES) e.aggro = true;
      if (!e.aggro || targets.length === 0) {
        e.windup = -1;
        continue;
      }

      let target = targets[0];
      let best = Infinity;
      for (const t of targets) {
        const dist2 = (t.x - e.x) ** 2 + (t.z - e.z) ** 2;
        if (dist2 < best) {
          best = dist2;
          target = t;
        }
      }
      const dist = Math.sqrt(best);
      const dx = target.x - e.x;
      const dz = target.z - e.z;
      e.r = turnToward(e.r, Math.atan2(dx, dz), dt * 7);

      if (e.windup >= 0) {
        e.windup += dt;
        if (e.windup >= st.windup) {
          e.windup = -1;
          e.cooldown = st.cooldown;
          // The swing hits everyone in front of the enemy, so brutes cleave through crowds.
          const fx = Math.sin(e.r);
          const fz = Math.cos(e.r);
          for (const t of targets) {
            const tx = t.x - e.x;
            const tz = t.z - e.z;
            const td = Math.hypot(tx, tz);
            if (td <= st.reach + PLAYER_RADIUS && (td < 0.5 || (tx * fx + tz * fz) / td > 0.3)) this.damagePlayer(t.id, st.damage);
          }
        }
      } else if (dist <= st.reach * 0.85 && e.cooldown <= 0) {
        e.windup = 0;
      } else if (dist > st.reach * 0.7) {
        const step = st.speed * dt;
        const dir = dist < 3 * TILE ? { x: dx / dist, z: dz / dist } : this.flowDirection(e.x, e.z);
        if (dir) moveWithCollision(d, e, dir.x * step, dir.z * step, st.radius);
      }
    }

    // Keep enemies from stacking on top of each other.
    const list = [...this.enemies.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const min = ENEMY_STATS[a.type].radius + ENEMY_STATS[b.type].radius;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-6) continue;
        const dist = Math.sqrt(d2);
        const push = (min - dist) / 2;
        moveWithCollision(d, a, (-dx / dist) * push, (-dz / dist) * push, ENEMY_STATS[a.type].radius);
        moveWithCollision(d, b, (dx / dist) * push, (dz / dist) * push, ENEMY_STATS[b.type].radius);
      }
    }

    this.enemyNetT -= dt;
    if (this.enemyNetT <= 0) {
      this.enemyNetT = this.enemies.size > 0 ? NET_INTERVAL : IDLE_NET_INTERVAL;
      const l: EnemySnapshot[] = [...this.enemies.values()].map((e) => [
        e.id,
        ENEMY_TYPES.indexOf(e.type),
        round2(e.x),
        round2(e.z),
        round2(e.r),
        Math.ceil(e.hp),
        e.maxHp,
        e.windup >= 0 ? 1 : 0,
      ]);
      this.room.send("e", { f: this.floor, s: this.seed, l });
    }

    this.floorAnnounceT -= dt;
    if (this.floorAnnounceT <= 0) {
      this.floorAnnounceT = FLOOR_ANNOUNCE_INTERVAL;
      this.announceFloor();
    }
  }

  private damagePlayer(id: string, amount: number) {
    if (id === this.room.me.id) this.takeDamage(amount);
    else this.room.send("ph", { t: id, d: amount });
  }

  /** Breadth-first walking distance (in tiles) from every tile to the nearest player. */
  private buildFlowField(targets: { x: number; z: number }[]) {
    const d = this.dungeon!;
    const field = this.flowField;
    field.fill(-1);
    const queue: number[] = [];
    for (const t of targets) {
      const idx = Math.floor(t.z / TILE) * d.size + Math.floor(t.x / TILE);
      if (field[idx] !== 0 && d.grid[idx] === 1) {
        field[idx] = 0;
        queue.push(idx);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const idx = queue[head];
      const tx = idx % d.size;
      const ty = (idx - tx) / d.size;
      for (const [ox, oy] of NEIGHBORS4) {
        const n = (ty + oy) * d.size + tx + ox;
        if (field[n] === -1 && isFloorTile(d, tx + ox, ty + oy)) {
          field[n] = field[idx] + 1;
          queue.push(n);
        }
      }
    }
  }

  private flowAt(x: number, z: number) {
    const d = this.dungeon!;
    return this.flowField[Math.floor(z / TILE) * d.size + Math.floor(x / TILE)] ?? -1;
  }

  /** Unit vector toward the neighbouring tile that is closest to a player. */
  private flowDirection(x: number, z: number) {
    const d = this.dungeon!;
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(z / TILE);
    let best = this.flowAt(x, z);
    let bestTile: [number, number] | null = null;
    for (const [ox, oy] of NEIGHBORS8) {
      if (!isFloorTile(d, tx + ox, ty + oy)) continue;
      // No cutting diagonally through wall corners.
      if (ox !== 0 && oy !== 0 && (!isFloorTile(d, tx + ox, ty) || !isFloorTile(d, tx, ty + oy))) continue;
      const v = this.flowField[(ty + oy) * d.size + tx + ox];
      if (v >= 0 && v < best) {
        best = v;
        bestTile = [tx + ox, ty + oy];
      }
    }
    if (!bestTile) return null;
    const c = tileToWorld(bestTile[0], bestTile[1]);
    const len = Math.hypot(c.x - x, c.z - z) || 1;
    return { x: (c.x - x) / len, z: (c.z - z) / len };
  }

  private sendNet(dt: number) {
    this.netT -= dt;
    this.idleT -= dt;
    if (this.netT > 0) return;
    this.netT = NET_INTERVAL;
    const me = this.me;
    const p = { x: round2(me.x), z: round2(me.z), r: round2(me.r), hp: me.hp, sw: me.swingCount };
    const key = `${p.x}|${p.z}|${p.r}|${p.hp}|${p.sw}`;
    if (key === this.lastSentKey && this.idleT > 0) return;
    this.lastSentKey = key;
    this.idleT = IDLE_NET_INTERVAL;
    this.room.send("p", p);
  }

  private updateRemotes(dt: number, now: number) {
    const t = 1 - Math.exp(-12 * dt);
    for (const [id, p] of this.remotes) {
      if (now - p.lastSeen > 15000) {
        p.model.dispose();
        this.remotes.delete(id);
        continue;
      }
      const pos = p.model.root.position;
      const moving = Math.hypot(p.x - pos.x, p.z - pos.z) > 0.05;
      pos.x = lerp(pos.x, p.x, t);
      pos.z = lerp(pos.z, p.z, t);
      p.model.body.rotation.y = angleLerp(p.model.body.rotation.y, p.r, t);
      p.model.body.rotation.z = lerp(p.model.body.rotation.z, p.hp <= 0 ? Math.PI / 2 : 0, dt * 8);
      p.model.setHp(p.hp / MAX_HP);
      p.model.update(dt, moving && p.hp > 0);
    }
  }

  private updateEnemyViews(dt: number) {
    const t = 1 - Math.exp(-(this.room.isHost ? 30 : 12) * dt);
    for (const e of this.enemies.values()) {
      let view = this.enemyViews.get(e.id);
      if (!view) {
        const model = createEnemy(e.type);
        model.root.position.set(e.x, 0, e.z);
        model.body.rotation.y = e.r;
        this.scene.add(model.root);
        view = { model, lastHp: e.hp, dying: -1 };
        this.enemyViews.set(e.id, view);
      }
      const pos = view.model.root.position;
      const moving = Math.hypot(e.x - pos.x, e.z - pos.z) > 0.03;
      pos.x = lerp(pos.x, e.x, t);
      pos.z = lerp(pos.z, e.z, t);
      view.model.body.rotation.y = angleLerp(view.model.body.rotation.y, e.r, t);
      if (e.hp < view.lastHp) view.model.flash();
      view.lastHp = e.hp;
      view.model.setHp(e.hp / e.maxHp);
      view.model.setWindup(e.windup >= 0);
      view.model.update(dt, moving);
    }

    for (const [id, view] of this.enemyViews) {
      if (this.enemies.has(id)) continue;
      if (view.dying < 0) {
        view.dying = 0;
        view.model.setHp(0);
        view.model.flash();
      }
      view.dying += dt;
      const k = Math.min(1, view.dying / 0.6);
      view.model.body.rotation.z = (Math.PI / 2) * k;
      view.model.root.scale.setScalar(1 - k * 0.9);
      view.model.update(dt, false);
      if (k >= 1) {
        view.model.dispose();
        this.enemyViews.delete(id);
      }
    }
  }

  private updateCamera(dt: number) {
    const target = new THREE.Vector3(this.me.x, 0, this.me.z);
    const desired = target.clone().add(new THREE.Vector3(0, 15, 10.5));
    this.camera.position.lerp(desired, 1 - Math.exp(-6 * dt));
    if (this.shake > 0) {
      this.shake -= dt;
      this.camera.position.x += (Math.random() - 0.5) * 0.3;
      this.camera.position.z += (Math.random() - 0.5) * 0.3;
    }
    this.camera.lookAt(this.camera.position.x, 0, this.camera.position.z - 10.5);
  }

  private snapCamera() {
    this.camera.position.set(this.me.x, 15, this.me.z + 10.5);
    this.camera.lookAt(this.me.x, 0, this.me.z);
  }

  private animateDungeon(now: number) {
    if (!this.dungeonMesh) return;
    let i = 0;
    for (const child of this.dungeonMesh.children) {
      i++;
      const flicker = Math.sin(now * 0.011 + i * 1.7) * 0.5 + Math.sin(now * 0.023 + i) * 0.5;
      if (child.name === "flame") child.scale.set(1, 1 + flicker * 0.2, 1);
      else if ((child as THREE.PointLight).isPointLight) (child as THREE.PointLight).intensity = 40 + flicker * 8;
    }
  }

  // ---------------------------------------------------------------- HUD

  private updateHud() {
    const h = this.hud;
    const me = this.me;
    h.hpFill.style.width = `${(me.hp / MAX_HP) * 100}%`;
    h.hpText.textContent = `${Math.ceil(me.hp)} / ${MAX_HP}`;
    h.dashFill.style.width = `${(1 - me.dashCd / DASH_COOLDOWN) * 100}%`;
    h.kills.textContent = `Kills: ${me.kills}`;
    h.floor.textContent = this.floor > 0 ? `Floor ${this.floor}` : "Waiting for host…";
    h.room.textContent = `Room ${this.room.code} · ${this.room.members.length}/${MAX_PLAYERS}`;
    h.enemies.textContent = `Enemies: ${this.enemies.size}`;
    if (me.hp <= 0) h.death.textContent = `You have fallen… respawning in ${Math.ceil(me.deadT)}`;
    this.updateNetBanner();

    h.party.replaceChildren(
      ...this.room.members.map((m) => {
        const hp = m.id === this.room.me.id ? me.hp : (this.remotes.get(m.id)?.hp ?? MAX_HP);
        const row = document.createElement("div");
        row.className = "member" + (hp <= 0 ? " dead" : "");
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = `#${m.color.toString(16).padStart(6, "0")}`;
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = (m.id === this.room.hostId ? "★ " : "") + m.name;
        const mini = document.createElement("span");
        mini.className = "mini";
        const fill = document.createElement("div");
        fill.style.width = `${(hp / MAX_HP) * 100}%`;
        mini.append(fill);
        row.append(dot, name, mini);
        return row;
      }),
    );
  }

  private updateNetBanner() {
    const problem = this.netProblem(performance.now());
    const h = this.hud;
    h.netBanner.hidden = !problem;
    h.netText.textContent = problem?.text ?? "";
    h.netLeave.hidden = !problem?.offerLeave;
  }

  private netProblem(now: number): { text: string; offerLeave: boolean } | null {
    if (this.connection === "closed") return { text: "Disconnected", offerLeave: true };
    if (this.connection === "reconnecting") {
      return { text: "Connection lost, reconnecting…", offerLeave: now - this.disconnectedAt >= OFFER_LEAVE_MS };
    }
    if (!this.room.isHost && now - this.lastHostMsgAt > HOST_STALL_MS) {
      return { text: "Host not responding…", offerLeave: now - this.lastHostMsgAt >= OFFER_LEAVE_MS };
    }
    return null;
  }

  private toast(text: string) {
    const el = this.hud.toast;
    el.textContent = text;
    el.classList.add("show");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove("show"), 2500);
  }
}

const NEIGHBORS4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const NEIGHBORS8 = [...NEIGHBORS4, [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function wrapAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function angleLerp(a: number, b: number, t: number) {
  return a + wrapAngle(b - a) * t;
}

function turnToward(current: number, target: number, maxStep: number) {
  const diff = wrapAngle(target - current);
  return current + Math.max(-maxStep, Math.min(maxStep, diff));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** A finite number no further than `limit` from zero. */
function isNum(v: unknown, limit: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit;
}

function isInt(v: unknown, min: number, max: number): v is number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
}

function isEnemySnapshot(v: unknown): v is EnemySnapshot {
  if (!Array.isArray(v) || v.length !== 8) return false;
  const [id, typeIndex, x, z, r, hp, maxHp, windup] = v;
  return (
    Number.isInteger(id) &&
    isInt(typeIndex, 0, ENEMY_TYPES.length - 1) &&
    isNum(x, WORLD_LIMIT) &&
    isNum(z, WORLD_LIMIT) &&
    isNum(r, Number.MAX_VALUE) &&
    isNum(hp, Number.MAX_VALUE) &&
    isNum(maxHp, Number.MAX_VALUE) &&
    maxHp > 0 &&
    (windup === 0 || windup === 1)
  );
}
