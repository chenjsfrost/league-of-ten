import * as THREE from "three";
import type { Session } from "@supabase/supabase-js";
import { heroFromSession, setupAuthScreen, type Hero } from "./auth";
import { Game, type HudElements } from "./game/game";
import { PLAYER_COLORS } from "./game/models";
import { MAX_PLAYERS, Room } from "./game/net";
import { supabase } from "./supabase";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const authScreen = $("auth-screen");
const lobbyScreen = $("lobby-screen");
const hudEl = $("hud");
const roomInput = $<HTMLInputElement>("room-code");
const lobbyMessage = $("lobby-message");
const joinForm = $<HTMLFormElement>("join-form");

const renderer = new THREE.WebGLRenderer({ canvas: $<HTMLCanvasElement>("game"), antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const hud: HudElements = {
  floor: $("floor-label"),
  room: $("room-label"),
  enemies: $("enemies-label"),
  party: $("party"),
  hpFill: $("hp-fill"),
  hpText: $("hp-text"),
  dashFill: $("dash-fill"),
  kills: $("kills"),
  death: $("death-overlay"),
  toast: $("toast"),
  netBanner: $("net-banner"),
  netText: $("net-text"),
  netLeave: $<HTMLButtonElement>("net-leave"),
};

let hero: Hero | null = null;
let game: Game | null = null;

function show(screen: "auth" | "lobby" | "game") {
  authScreen.hidden = screen !== "auth";
  lobbyScreen.hidden = screen !== "lobby";
  hudEl.hidden = screen !== "game";
}

function onSignedIn(session: Session) {
  hero = heroFromSession(session);
  $("lobby-name").textContent = hero.name;
  if (!roomInput.value) roomInput.value = randomCode();
  show("lobby");
}

function randomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
}

function colorFor(userId: string) {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PLAYER_COLORS[Math.abs(h) % PLAYER_COLORS.length];
}

joinForm.onsubmit = async (e) => {
  e.preventDefault();
  if (!hero || game) return;
  const code = roomInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) {
    lobbyMessage.textContent = "Enter a dungeon code.";
    return;
  }
  const submit = joinForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
  submit.disabled = true;
  lobbyMessage.textContent = "";

  const room = new Room(code, {
    id: `${hero.id.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
    userId: hero.id,
    name: hero.name,
    color: colorFor(hero.id),
    joinedAt: Date.now(),
  });
  const g = new Game(renderer, room, hud, leaveGame);
  const result = await room.join();
  submit.disabled = false;

  if (result !== "ok") {
    g.dispose();
    lobbyMessage.textContent =
      result === "full" ? `That dungeon already has ${MAX_PLAYERS} heroes.` : "Could not connect. Try again.";
    return;
  }
  game = g;
  show("game");
  game.start();
};

function leaveGame() {
  game?.dispose();
  game = null;
  renderer.clear();
  show("lobby");
}

$("random-room").onclick = () => (roomInput.value = randomCode());

$("logout").onclick = async () => {
  await supabase.auth.signOut();
  hero = null;
  show("auth");
};

setupAuthScreen(onSignedIn);

void supabase.auth.getSession().then(({ data }) => {
  if (data.session) onSignedIn(data.session);
  else show("auth");
});

