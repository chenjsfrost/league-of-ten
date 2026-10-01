import * as THREE from "three";
import { disposeGroup } from "./dungeon";

export const SWORD_RANGE = 2.6;
/** Half-angle of the sword arc in radians. */
export const SWORD_ARC = Math.PI / 2.6;

const SWING_DURATION = 0.22;
const REST_ANGLE = -0.9;

export interface CharacterOptions {
  color: number;
  skin: number;
  scale?: number;
  weapon: "sword" | "club";
  shield?: boolean;
  glowingEyes?: boolean;
  name?: string;
  /** Show the white slash arc when swinging. */
  slashTrail?: boolean;
}

/**
 * A low-poly character built from primitives. Faces +z when body.rotation.y is 0.
 * root holds position; body holds facing so labels and bars never rotate.
 */
export class CharacterModel {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  private readonly weaponPivot = new THREE.Group();
  private readonly legs: THREE.Mesh[] = [];
  private readonly flashMats: THREE.MeshStandardMaterial[] = [];
  private readonly eyesMat?: THREE.MeshStandardMaterial;
  private readonly trail?: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly hpFg: THREE.Sprite;
  private readonly hpWidth: number;
  private swingT = -1;
  private flashT = 0;
  private walkPhase = 0;
  private windup = false;

  constructor(opts: CharacterOptions) {
    const scale = opts.scale ?? 1;
    const mat = (color: number) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
      this.flashMats.push(m);
      return m;
    };
    const bodyMat = mat(opts.color);
    const legMat = mat(new THREE.Color(opts.color).multiplyScalar(0.55).getHex());
    const skinMat = mat(opts.skin);

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.43, 0.9, 10), bodyMat);
    torso.position.y = 0.95;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), skinMat);
    head.position.y = 1.66;
    this.body.add(torso, head);

    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.55, 0.2), legMat);
      leg.geometry.translate(0, -0.27, 0); // pivot at the hip
      leg.position.set(side * 0.16, 0.55, 0);
      this.legs.push(leg);
      this.body.add(leg);
    }

    if (opts.glowingEyes) {
      this.eyesMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff2010, emissiveIntensity: 2 });
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), this.eyesMat);
        eye.position.set(side * 0.1, 1.7, 0.24);
        this.body.add(eye);
      }
    }

    if (opts.shield) {
      const shield = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.6, 0.45),
        new THREE.MeshStandardMaterial({ color: 0x6b4a2b, metalness: 0.3, roughness: 0.6 }),
      );
      shield.position.set(0.48, 1.0, 0.12);
      this.body.add(shield);
    }

    // The weapon hand is on the character's right, which is -x when facing +z.
    this.weaponPivot.position.set(-0.45, 1.1, 0);
    this.weaponPivot.rotation.y = REST_ANGLE;
    if (opts.weapon === "sword") {
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.07, 0.04, 1.15),
        new THREE.MeshStandardMaterial({ color: 0xd8dde6, metalness: 0.9, roughness: 0.25 }),
      );
      blade.position.z = 0.7;
      const guard = new THREE.Mesh(
        new THREE.BoxGeometry(0.35, 0.06, 0.06),
        new THREE.MeshStandardMaterial({ color: 0xc9a640, metalness: 0.8, roughness: 0.3 }),
      );
      guard.position.z = 0.12;
      this.weaponPivot.add(blade, guard);
    } else {
      const club = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.07, 1.2, 8),
        new THREE.MeshStandardMaterial({ color: 0x4a3622, roughness: 0.9 }),
      );
      club.rotation.x = Math.PI / 2;
      club.position.z = 0.65;
      this.weaponPivot.add(club);
    }
    this.body.add(this.weaponPivot);

    if (opts.slashTrail) {
      this.trail = new THREE.Mesh(
        new THREE.RingGeometry(0.9, SWORD_RANGE / scale, 24, 1, -Math.PI / 2 - SWORD_ARC, SWORD_ARC * 2),
        new THREE.MeshBasicMaterial({
          color: 0xfff2d0,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      this.trail.rotation.x = -Math.PI / 2;
      this.trail.position.y = 1.0;
      this.body.add(this.trail);
    }

    this.body.scale.setScalar(scale);
    this.root.add(this.body);

    const height = 2.1 * scale;
    this.hpWidth = 1.1 * scale;
    const barMat = (color: number) => new THREE.SpriteMaterial({ color, depthTest: false });
    const hpBg = new THREE.Sprite(barMat(0x111111));
    this.hpFg = new THREE.Sprite(barMat(0xd23b3b));
    for (const s of [hpBg, this.hpFg]) {
      s.center.set(0, 0.5);
      s.position.set(-this.hpWidth / 2, height + 0.2, 0);
      s.scale.set(this.hpWidth, 0.1, 1);
      s.renderOrder = 10;
      this.root.add(s);
    }
    this.hpFg.renderOrder = 11;

    if (opts.name) {
      const label = makeLabel(opts.name, opts.color);
      label.position.y = height + 0.55;
      this.root.add(label);
    }
  }

  setHp(ratio: number) {
    this.hpFg.scale.x = Math.max(0.0001, this.hpWidth * Math.min(1, ratio));
  }

  swing() {
    this.swingT = 0;
  }

  /** Enemy attack telegraph: weapon raised and eyes blaze until the swing lands. */
  setWindup(on: boolean) {
    if (this.windup && !on) this.swing();
    this.windup = on;
  }

  flash() {
    this.flashT = 0.12;
  }

  update(dt: number, moving: boolean) {
    // Walk cycle
    if (moving) this.walkPhase += dt * 12;
    else this.walkPhase *= 0.8;
    const stride = Math.sin(this.walkPhase) * (moving ? 0.6 : 0);
    this.legs[0].rotation.x = stride;
    this.legs[1].rotation.x = -stride;
    this.body.position.y = moving ? Math.abs(Math.sin(this.walkPhase)) * 0.06 : 0;

    // Weapon swing: sweep from the right side across to the left.
    if (this.swingT >= 0) {
      this.swingT += dt;
      const t = Math.min(1, this.swingT / SWING_DURATION);
      const eased = 1 - (1 - t) * (1 - t);
      this.weaponPivot.rotation.y = -1.7 + eased * 3.4;
      this.weaponPivot.rotation.x = 0;
      if (this.trail) this.trail.material.opacity = Math.sin(t * Math.PI) * 0.55;
      if (t >= 1) this.swingT = -1;
    } else {
      const target = this.windup ? -1.9 : REST_ANGLE;
      this.weaponPivot.rotation.y += (target - this.weaponPivot.rotation.y) * Math.min(1, dt * 10);
      this.weaponPivot.rotation.x += ((this.windup ? -0.9 : 0) - this.weaponPivot.rotation.x) * Math.min(1, dt * 10);
      if (this.trail) this.trail.material.opacity = 0;
    }
    if (this.eyesMat) this.eyesMat.emissiveIntensity = this.windup ? 6 : 2;

    // Hit flash
    this.flashT = Math.max(0, this.flashT - dt);
    const glow = this.flashT > 0 ? 0.9 : 0;
    for (const m of this.flashMats) m.emissive.setRGB(glow, glow * 0.15, glow * 0.1);
  }

  dispose() {
    disposeGroup(this.root);
  }
}

function makeLabel(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 30px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, 128, 32);
  ctx.fillStyle = "#" + new THREE.Color(color).getHexString();
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.renderOrder = 12;
  return sprite;
}

export const PLAYER_COLORS = [
  0xe0563b, 0x3ba7d2, 0x6fcf7a, 0xf2c94c, 0xbb6bd9, 0xf2994a, 0x56ccf2, 0xeb5794, 0x9bdb4d, 0xe8e8e8,
];

export function createHero(name: string, color: number) {
  return new CharacterModel({ color, skin: 0xf0c8a0, weapon: "sword", shield: true, name, slashTrail: true });
}

export type EnemyType = "skeleton" | "brute";

export function createEnemy(type: EnemyType) {
  return type === "skeleton"
    ? new CharacterModel({ color: 0xcfc6b0, skin: 0xe8e0cc, weapon: "sword", glowingEyes: true })
    : new CharacterModel({ color: 0x4f6b3a, skin: 0x6f8a52, weapon: "club", glowingEyes: true, scale: 1.6 });
}
