import * as THREE from "three";
import { mulberry32 } from "./rng";

/** World units per grid tile. */
export const TILE = 2;
const SIZE = 60;
const WALL_HEIGHT = 3.2;
const CORRIDOR_HALF_WIDTH = 1; // corridors are 3 tiles wide so a party of ten can fit

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DungeonData {
  seed: number;
  size: number;
  /** 1 = floor, 0 = wall. Indexed [ty * size + tx]. */
  grid: Uint8Array;
  /** rooms[0] is where the party spawns. */
  rooms: Room[];
}

export function generateDungeon(seed: number): DungeonData {
  const rand = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const grid = new Uint8Array(SIZE * SIZE);
  const carve = (tx: number, ty: number) => {
    if (tx > 0 && ty > 0 && tx < SIZE - 1 && ty < SIZE - 1) grid[ty * SIZE + tx] = 1;
  };

  const rooms: Room[] = [];
  for (let tries = 0; tries < 400 && rooms.length < 11; tries++) {
    const w = int(7, 12);
    const h = int(7, 12);
    const x = int(2, SIZE - w - 3);
    const y = int(2, SIZE - h - 3);
    const overlaps = rooms.some(
      (r) => x < r.x + r.w + 3 && x + w + 3 > r.x && y < r.y + r.h + 3 && y + h + 3 > r.y,
    );
    if (!overlaps) rooms.push({ x, y, w, h });
  }

  for (const r of rooms) {
    for (let ty = r.y; ty < r.y + r.h; ty++) for (let tx = r.x; tx < r.x + r.w; tx++) carve(tx, ty);
  }

  // Connect each room to its nearest earlier room with an L-shaped corridor.
  const center = (r: Room) => [r.x + (r.w >> 1), r.y + (r.h >> 1)] as const;
  for (let i = 1; i < rooms.length; i++) {
    const [ax, ay] = center(rooms[i]);
    let best = 0;
    let bestDist = Infinity;
    for (let j = 0; j < i; j++) {
      const [bx, by] = center(rooms[j]);
      const d = Math.abs(ax - bx) + Math.abs(ay - by);
      if (d < bestDist) {
        bestDist = d;
        best = j;
      }
    }
    const [bx, by] = center(rooms[best]);
    const horizontalFirst = rand() < 0.5;
    const cornerX = horizontalFirst ? bx : ax;
    const cornerY = horizontalFirst ? ay : by;
    carveLine(ax, ay, cornerX, cornerY, carve);
    carveLine(cornerX, cornerY, bx, by, carve);
  }

  return { seed, size: SIZE, grid, rooms };
}

function carveLine(x0: number, y0: number, x1: number, y1: number, carve: (x: number, y: number) => void) {
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  let x = x0;
  let y = y0;
  while (true) {
    for (let o = -CORRIDOR_HALF_WIDTH; o <= CORRIDOR_HALF_WIDTH; o++) {
      if (dx !== 0) carve(x, y + o);
      else carve(x + o, y);
    }
    if (x === x1 && y === y1) break;
    x += dx;
    y += dy;
  }
}

export function isFloorTile(d: DungeonData, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= d.size || ty >= d.size) return false;
  return d.grid[ty * d.size + tx] === 1;
}

/** True if a circle of radius r centred at world (x, z) touches only floor tiles. */
export function canStand(d: DungeonData, x: number, z: number, r: number): boolean {
  const minX = Math.floor((x - r) / TILE);
  const maxX = Math.floor((x + r) / TILE);
  const minY = Math.floor((z - r) / TILE);
  const maxY = Math.floor((z + r) / TILE);
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) if (!isFloorTile(d, tx, ty)) return false;
  }
  return true;
}

/** Moves pos by (dx, dz), sliding along walls. Mutates and returns pos. */
export function moveWithCollision(d: DungeonData, pos: { x: number; z: number }, dx: number, dz: number, r: number) {
  if (canStand(d, pos.x + dx, pos.z, r)) pos.x += dx;
  if (canStand(d, pos.x, pos.z + dz, r)) pos.z += dz;
  return pos;
}

export function tileToWorld(tx: number, ty: number) {
  return { x: tx * TILE + TILE / 2, z: ty * TILE + TILE / 2 };
}

export function roomCenter(room: Room) {
  return tileToWorld(room.x + room.w / 2 - 0.5, room.y + room.h / 2 - 0.5);
}

/** Builds the dungeon meshes and lights. Call disposeGroup on the result when leaving the floor. */
export function buildDungeonMesh(d: DungeonData, floorNumber: number): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(d.seed ^ 0x51ed);

  const floorCells: [number, number][] = [];
  const wallCells: [number, number][] = [];
  for (let ty = 0; ty < d.size; ty++) {
    for (let tx = 0; tx < d.size; tx++) {
      if (isFloorTile(d, tx, ty)) {
        floorCells.push([tx, ty]);
        continue;
      }
      // Only build walls that border a floor tile.
      let borders = false;
      for (let oy = -1; oy <= 1 && !borders; oy++)
        for (let ox = -1; ox <= 1 && !borders; ox++) borders = isFloorTile(d, tx + ox, ty + oy);
      if (borders) wallCells.push([tx, ty]);
    }
  }

  // Each floor deeper shifts the stone hue a little.
  const hue = (0.07 + floorNumber * 0.11) % 1;
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();

  const floorMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(TILE, 0.2, TILE),
    new THREE.MeshStandardMaterial({ roughness: 0.95 }),
    floorCells.length,
  );
  floorCells.forEach(([tx, ty], i) => {
    const { x, z } = tileToWorld(tx, ty);
    matrix.makeTranslation(x, -0.1, z);
    floorMesh.setMatrixAt(i, matrix);
    floorMesh.setColorAt(i, color.setHSL(hue, 0.12, 0.16 + rand() * 0.06));
  });
  group.add(floorMesh);

  const wallMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(TILE, WALL_HEIGHT, TILE),
    new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    wallCells.length,
  );
  wallCells.forEach(([tx, ty], i) => {
    const { x, z } = tileToWorld(tx, ty);
    matrix.makeTranslation(x, WALL_HEIGHT / 2, z);
    wallMesh.setMatrixAt(i, matrix);
    wallMesh.setColorAt(i, color.setHSL(hue, 0.1, 0.22 + rand() * 0.08));
  });
  group.add(wallMesh);

  // A brazier with a warm light in the middle of every room.
  const brazierGeo = new THREE.CylinderGeometry(0.35, 0.25, 0.8, 8);
  const brazierMat = new THREE.MeshStandardMaterial({ color: 0x2a2420, metalness: 0.6, roughness: 0.4 });
  const flameGeo = new THREE.ConeGeometry(0.3, 0.7, 8);
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa040 });
  for (const room of d.rooms) {
    const { x, z } = roomCenter(room);
    const brazier = new THREE.Mesh(brazierGeo, brazierMat);
    brazier.position.set(x, 0.4, z);
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(x, 1.1, z);
    flame.name = "flame";
    const light = new THREE.PointLight(0xff9a50, 40, 22, 1.6);
    light.position.set(x, 2.5, z);
    group.add(brazier, flame, light);
  }

  return group;
}

export function disposeGroup(group: THREE.Object3D) {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) geos.add(mesh.geometry);
    if (mesh.material) {
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mats.add(m);
    }
  });
  geos.forEach((g) => g.dispose());
  mats.forEach((m) => {
    const tex = (m as THREE.SpriteMaterial).map;
    tex?.dispose();
    m.dispose();
  });
  group.removeFromParent();
}
