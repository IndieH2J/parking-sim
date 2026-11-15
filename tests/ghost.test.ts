import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { toWorld, type Pose, type Vec2 } from '../src/sim/geometry';
import { eyeLocal } from '../src/sim/driver';
import { buildFootprint } from '../src/sim/footprint';
import { MODEL_Y_2025, type VehicleSpec } from '../src/sim/specs';
import { DEFAULT_GHOST_ID, listVehicles, type GhostAlign } from '../src/sim/vehicles';
import { ghostOffset, ghostPose } from '../src/sim/ghost';
import { GhostView } from '../src/render/ghost';

// 계약서 §4

const SPECS = listVehicles().map((v) => v.spec); // 모델 Y + 프리셋 전부
const ALIGNS: GhostAlign[] = ['driver', 'rearAxle'];
const AVANTE = listVehicles().find((v) => v.id === DEFAULT_GHOST_ID)!.spec;

/** 재현 가능한 의사 난수 (Park–Miller), 0..1 */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const rnd = rng(12345);
const POSES: Pose[] = Array.from({ length: 20 }, () => ({
  x: (rnd() - 0.5) * 100,
  y: (rnd() - 0.5) * 100,
  heading: (rnd() * 2 - 1) * Math.PI,
}));

/** 평면도 눈 위치 (월드) */
function eyeWorld(spec: VehicleSpec, pose: Pose, heightCm = 175, seatH = 0, seatFore = 0): Vec2 {
  const e = eyeLocal(spec, heightCm, seatH, seatFore);
  return toWorld({ x: e.x, y: e.y }, pose);
}

describe('ghostOffset / ghostPose', () => {
  it("'rearAxle' alignment is the identity", () => {
    for (const main of SPECS) {
      for (const ghost of SPECS) {
        expect(ghostOffset(main, ghost, 'rearAxle')).toEqual({ x: 0, y: 0 });
        for (const pose of POSES) expect(ghostPose(main, ghost, pose, 'rearAxle')).toEqual(pose);
      }
    }
  });

  it("'driver' alignment puts both eye points on the same spot (every pair, random poses)", () => {
    for (const main of SPECS) {
      for (const ghost of SPECS) {
        for (const pose of POSES) {
          const a = eyeWorld(main, pose);
          const b = eyeWorld(ghost, ghostPose(main, ghost, pose, 'driver'));
          expect(Math.hypot(a.x - b.x, a.y - b.y), `${main.id} / ${ghost.id}`).toBeLessThan(1e-9);
        }
      }
    }
  });

  it("'driver' alignment still holds for other driver heights and seat settings", () => {
    const r = rng(777);
    for (const main of SPECS) {
      for (const ghost of SPECS) {
        const pose = POSES[Math.floor(r() * POSES.length)];
        const cm = 150 + r() * 45;
        const seatH = -6 + r() * 12;
        const seatFore = -12 + r() * 24;
        const a = eyeWorld(main, pose, cm, seatH, seatFore);
        const b = eyeWorld(ghost, ghostPose(main, ghost, pose, 'driver'), cm, seatH, seatFore);
        expect(Math.hypot(a.x - b.x, a.y - b.y), `${main.id} / ${ghost.id}`).toBeLessThan(1e-9);
      }
    }
  });

  it('keeps the heading', () => {
    for (const align of ALIGNS) {
      for (const main of SPECS) {
        for (const ghost of SPECS) {
          for (const pose of POSES) expect(ghostPose(main, ghost, pose, align).heading).toBe(pose.heading);
        }
      }
    }
  });

  it('same spec for ghost and main gives offset (0, 0)', () => {
    for (const align of ALIGNS) {
      for (const spec of SPECS) expect(ghostOffset(spec, spec, align), `${spec.id} ${align}`).toEqual({ x: 0, y: 0 });
    }
  });
});

// 스크린샷 대신: three의 기하·재질은 WebGL 없이 만들어지므로 GhostView를 직접 검사한다.
describe('GhostView', () => {
  const meshes = (v: GhostView) => v.group.children as THREE.Mesh[];
  const isPost = (m: THREE.Mesh) => m.geometry instanceof THREE.BoxGeometry;
  /** Three (x, h, −y) → 시뮬레이션 평면 (x, y) */
  const plan = (v: THREE.Vector3): Vec2 => ({ x: v.x, y: -v.z });

  it('starts empty and hidden; setSpec never changes the setVisible choice; null empties and hides', () => {
    const v = new GhostView();
    expect(v.group.children).toHaveLength(0);
    expect(v.group.visible).toBe(false);
    v.setSpec(AVANTE);
    expect(v.group.children).toHaveLength(5); // 윤곽 1 + 기둥 4
    expect(v.group.visible).toBe(true);
    v.setVisible(false);
    v.setSpec(MODEL_Y_2025);
    expect(v.group.visible).toBe(false);
    v.setVisible(true);
    expect(v.group.visible).toBe(true);
    v.setSpec(null);
    expect(v.group.children).toHaveLength(0);
    expect(v.group.visible).toBe(false);
    v.setVisible(true);
    expect(v.group.visible).toBe(false);
  });

  it('update sets group.position = L(x, y, 0) and rotation.y = heading', () => {
    const v = new GhostView();
    v.update({ x: 3, y: -2, heading: 0.7 });
    expect(v.group.position.toArray()).toEqual([3, 0, 2]);
    expect(v.group.rotation.y).toBe(0.7);
  });

  it('floor outline spans body + mirrors with a 0.04 m ribbon; posts rise from 0 to the ghost height', () => {
    for (const spec of [MODEL_Y_2025, AVANTE]) {
      for (const heading of [0, Math.PI / 2]) {
        const pose = { x: 4, y: -3, heading };
        const v = new GhostView();
        v.setSpec(spec);
        v.update(pose);
        const box = new THREE.Box3().setFromObject(v.group);
        const fp = buildFootprint(spec);
        const pts = [...fp.body.poly, ...fp.mirrorLeft.poly, ...fp.mirrorRight.poly];
        const g = 0.02; // 띠 폭의 절반
        const x0 = Math.min(...pts.map((p) => p.x)) - g;
        const x1 = Math.max(...pts.map((p) => p.x)) + g;
        const y0 = Math.min(...pts.map((p) => p.y)) - g;
        const y1 = Math.max(...pts.map((p) => p.y)) + g;
        const w = [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ].map((p) => toWorld(p, pose));
        const tag = `${spec.id} heading ${heading}`;
        expect(box.min.x, tag).toBeCloseTo(Math.min(...w.map((p) => p.x)), 4);
        expect(box.max.x, tag).toBeCloseTo(Math.max(...w.map((p) => p.x)), 4);
        expect(-box.max.z, tag).toBeCloseTo(Math.min(...w.map((p) => p.y)), 4);
        expect(-box.min.z, tag).toBeCloseTo(Math.max(...w.map((p) => p.y)), 4);
        expect(box.min.y, tag).toBeCloseTo(0, 6);
        expect(box.max.y, tag).toBeCloseTo(spec.height, 6);
      }
    }
  });

  it('the mitred ribbon has no twisted pieces: total |area| = 0.04 × outline perimeter', () => {
    for (const spec of [MODEL_Y_2025, AVANTE]) {
      const v = new GhostView();
      v.setSpec(spec);
      const pos = meshes(v).find((m) => !isPost(m))!.geometry.getAttribute('position');
      let area = 0;
      for (let i = 0; i < pos.count; i += 3) {
        const [ax, az, bx, bz, cx, cz] = [pos.getX(i), pos.getZ(i), pos.getX(i + 1), pos.getZ(i + 1), pos.getX(i + 2), pos.getZ(i + 2)];
        area += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
      }
      // 차체 둘레 + 미러 돌출부의 다리 4개 (돌출부 윗변은 옆변의 같은 길이를 대신한다)
      const body = buildFootprint(spec).body.poly;
      const bodyPerim = body.reduce((s, p, i) => s + Math.hypot(body[(i + 1) % body.length].x - p.x, body[(i + 1) % body.length].y - p.y), 0);
      const perim = bodyPerim + 4 * (spec.widthMirrors / 2 - spec.width / 2);
      expect(area, spec.id).toBeCloseTo(0.04 * perim, 4);
    }
  });

  it('posts stand at the four chamfer mid-points of the ghost body', () => {
    const pose = { x: -7, y: 5, heading: 2.3 };
    for (const spec of [MODEL_Y_2025, AVANTE]) {
      const v = new GhostView();
      v.setSpec(spec);
      v.update(pose);
      const got = meshes(v)
        .filter(isPost)
        .map((m) => plan(m.getWorldPosition(new THREE.Vector3())));
      // 사분면마다 차체 꼭짓점 2개(모따기 양 끝)의 중점
      const body = buildFootprint(spec).body.poly;
      const cx = (Math.min(...body.map((p) => p.x)) + Math.max(...body.map((p) => p.x))) / 2;
      const want = [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ].map(([sx, sy]) => {
        const q = body.filter((p) => Math.sign(p.x - cx) === sx && Math.sign(p.y) === sy);
        expect(q).toHaveLength(2);
        return toWorld({ x: (q[0].x + q[1].x) / 2, y: (q[0].y + q[1].y) / 2 }, pose);
      });
      expect(got).toHaveLength(4);
      for (const m of meshes(v).filter(isPost)) {
        const { width, height, depth } = (m.geometry as THREE.BoxGeometry).parameters;
        expect([width, height, depth]).toEqual([0.05, spec.height, 0.05]);
      }
      for (const p of want) {
        expect(
          got.some((g) => Math.hypot(g.x - p.x, g.y - p.y) < 1e-9),
          `${spec.id} post at ${p.x.toFixed(3)}, ${p.y.toFixed(3)}`,
        ).toBe(true);
      }
    }
  });

  it('materials: orange, transparent, no depth write (outline 0.75, posts 0.5); default layer; ribbon between goal and guide heights', () => {
    const v = new GhostView();
    v.setSpec(AVANTE);
    for (const m of meshes(v)) {
      const mat = m.material as THREE.MeshBasicMaterial;
      expect(mat).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect(mat.color.getHex()).toBe(0xff9f0a);
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
      expect(mat.opacity).toBe(isPost(m) ? 0.5 : 0.75);
      expect(m.layers.mask).toBe(1);
    }
    const ribbon = meshes(v).find((m) => !isPost(m))!;
    const pos = ribbon.geometry.getAttribute('position');
    const hs = new Set(Array.from({ length: pos.count }, (_, i) => pos.getY(i)));
    expect(hs.size).toBe(1);
    const [h] = hs;
    expect(h).toBeGreaterThan(0.005); // 목표 칸 (scene.ts)
    expect(h).toBeLessThanOrEqual(0.012); // 계약값. 후방카메라 가이드 리본(guideLines.ts)과 같은 높이
  });

  it('setSpec frees the old geometries; dispose frees geometries and materials', () => {
    const v = new GhostView();
    v.setSpec(AVANTE);
    const disposed = new Set<object>();
    const watch = (o: THREE.EventDispatcher<{ dispose: object }>) => o.addEventListener('dispose', () => disposed.add(o));
    const old = new Set(meshes(v).map((m) => m.geometry));
    old.forEach(watch);
    v.setSpec(MODEL_Y_2025);
    for (const g of old) expect(disposed.has(g)).toBe(true);
    const geoms = new Set(meshes(v).map((m) => m.geometry));
    const mats = new Set(meshes(v).map((m) => m.material as THREE.Material));
    for (const g of geoms) expect(old.has(g)).toBe(false);
    geoms.forEach(watch);
    mats.forEach(watch);
    v.dispose();
    expect(v.group.children).toHaveLength(0);
    for (const o of [...geoms, ...mats]) expect(disposed.has(o)).toBe(true);
  });
});
