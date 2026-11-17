import { describe, expect, it } from 'vitest';
import type { VehicleSpec } from '../src/sim/specs';
import { MODEL_Y_2025 } from '../src/sim/specs';
import { bodyExtents, buildFootprint, cowlXOf } from '../src/sim/footprint';
import { eyeLocal } from '../src/sim/driver';
import { polyToWorld, type Pose, type Vec2 } from '../src/sim/geometry';
import { CUSTOM_ID, getSpec } from '../src/sim/vehicles';
import type { Scenario } from '../src/scenarios/types';
import { drawTopView } from '../src/render/minimap';
import { buildCar } from '../src/render/carMesh';
import { allCars, OVERSIZED_DIMS } from './helpers/specs';

// B필러 위치(Footprint.bPillarX)와 탑뷰 표시. 3D 차 모델(carMesh)과 탑뷰가 같은 값을 쓴다.

/** 눈이 B필러에 가장 가까운 차: 축거 최대·전고 최소라 눈 → 앞축 추정값이 상한(1.6 m)에 걸린다 */
const LONG_LOW = getSpec(CUSTOM_ID, { ...OVERSIZED_DIMS, heightMm: 1200 });
const CARS: { name: string; spec: VehicleSpec }[] = [...allCars(), { name: 'LONG_LOW', spec: LONG_LOW }];

describe('B필러 위치', () => {
  it('LONG_LOW는 유효한 직접 입력 차다 (모델 Y로 바뀌지 않음)', () => {
    expect(LONG_LOW.id).toBe(CUSTOM_ID);
    expect(LONG_LOW.wheelbase).toBe(3.8);
  });

  it('3D 차 모델의 예전 식과 같다: max(축거 − 0.45, 미러 뒤끝 + 0.25) − 1.25 (모델 Y 1.19 m)', () => {
    expect(buildFootprint(MODEL_Y_2025).bPillarX).toBeCloseTo(1.19, 9);
    for (const { name, spec } of CARS) {
      const old = Math.max(spec.wheelbase - 0.45, spec.mirror.xRear + 0.25) - 1.25;
      expect(buildFootprint(spec).bPillarX, name).toBeCloseTo(old, 9);
      expect(cowlXOf(spec) - 1.25, name).toBeCloseTo(old, 9);
    }
  });

  it('지붕 앞뒤 끝(3D 모델) 사이, 미러보다 뒤, 175 cm 운전자 눈보다 0.1~0.41 m 뒤', () => {
    for (const { name, spec } of CARS) {
      const b = buildFootprint(spec).bPillarX;
      const { xr } = bodyExtents(spec);
      expect(b, name).toBeGreaterThan(xr + 0.45); // carMesh roofRearX
      expect(b, name).toBeLessThan(cowlXOf(spec) - 0.72); // carMesh roofFrontX
      expect(b, name).toBeLessThan(spec.mirror.xRear);
      const behindEye = eyeLocal(spec, 175, 0, 0).x - b;
      expect(behindEye, name).toBeGreaterThanOrEqual(0.1 - 1e-9);
      expect(behindEye, name).toBeLessThanOrEqual(0.41 + 1e-9);
    }
    expect(eyeLocal(LONG_LOW, 175, 0, 0).x - buildFootprint(LONG_LOW).bPillarX).toBeCloseTo(0.1, 6);
  });

  it('3D 차 모델의 B필러 두 개가 탑뷰와 같은 x에 있다 (Three x = 차량 로컬 x)', () => {
    for (const { name, spec } of CARS) {
      const pillars = buildCar(spec).group.children.filter((o) => o.name === 'bPillar');
      expect(pillars, name).toHaveLength(2);
      for (const p of pillars) expect(p.position.x, name).toBeCloseTo(buildFootprint(spec).bPillarX, 9);
    }
  });
});

// ---- 탑뷰 그리기: 가짜 ctx로 선(stroke)을 모은다 ----

interface Stroke {
  style: string;
  lw: number;
  pts: [number, number][];
}

function recordingCtx() {
  const strokes: Stroke[] = [];
  let path: [number, number][] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect() {},
    beginPath() {
      path = [];
    },
    moveTo(x: number, y: number) {
      path.push([x, y]);
    },
    lineTo(x: number, y: number) {
      path.push([x, y]);
    },
    closePath() {},
    fill() {},
    arc() {},
    setLineDash() {},
    stroke() {
      strokes.push({ style: ctx.strokeStyle, lw: ctx.lineWidth, pts: [...path] });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}

const EMPTY_SC = {
  floor: [],
  elements: [],
  goal: { rect: { cx: 0, cy: 0, angle: 0, halfL: 1, halfW: 1 } },
} as unknown as Scenario;
const PURPLE = '#bf5af2';
const W = 200;

/** 북쪽(+y)을 향한 차: 왼쪽 = 서쪽(−x). 차 로컬 x·y가 화면에서 서로 바뀌므로 축을 헷갈리면 틀린다 */
const POSE: Pose = { x: 2, y: -1, heading: Math.PI / 2 };

function ticks(spec: VehicleSpec, pxPerM: number, layers: { car?: boolean; ghost?: boolean }) {
  const fp = buildFootprint(spec);
  const { ctx, strokes } = recordingCtx();
  const cam = { cx: 0, cy: 0, pxPerM };
  drawTopView(ctx, W, W, cam, {
    sc: EMPTY_SC,
    car: layers.car ? { fp, pose: POSE } : null,
    ghost: layers.ghost ? { fp, pose: POSE } : null,
  });
  const toPx = (p: Vec2): [number, number] => [W / 2 + (p.x - cam.cx) * pxPerM, W / 2 - (p.y - cam.cy) * pxPerM];
  return { fp, toPx, purple: strokes.filter((s) => s.style === PURPLE) };
}

describe('탑뷰 B필러 표시', () => {
  it('양쪽 옆면에 하나씩, B필러 x에서 차체 옆면을 직각으로 가로지른다 (미니맵 축척)', () => {
    const s = W / 18; // 미니맵: 짧은 변 18 m
    const { fp, toPx, purple } = ticks(MODEL_Y_2025, s, { car: true });
    expect(purple).toHaveLength(2);
    const hw = MODEL_Y_2025.width / 2;
    for (const side of [1, -1]) {
      // 차체 옆면 위의 B필러 점 (화면 px)
      const [ex, ey] = toPx(polyToWorld([{ x: fp.bPillarX, y: side * hw }], POSE)[0]);
      // 북쪽을 향하므로 왼쪽(side 1) 표시는 차 중심보다 서쪽(px x가 작음)
      const [cx] = toPx(POSE);
      const tick = purple.find((t) => Math.sign(t.pts[0][0] - cx) === -side)!;
      expect(tick, `side ${side}`).toBeDefined();
      expect(tick.pts).toHaveLength(2);
      // 가로선(차 진행 방향에 직각), B필러 높이(px y)에 있다
      for (const [, y] of tick.pts) expect(y).toBeCloseTo(ey, 6);
      // 옆면을 가로지른다: 안쪽 4 px 이상, 바깥은 미러가 튀어나온 만큼, 굵기 2 px 이상
      const ins = tick.pts.map(([x]) => (x - ex) * side); // + = 차 안쪽 (side 1은 서쪽이 바깥)
      expect(Math.max(...ins)).toBeGreaterThanOrEqual(4 - 1e-6);
      expect(Math.min(...ins)).toBeCloseTo(-(MODEL_Y_2025.widthMirrors / 2 - hw) * s, 6);
      expect(tick.lw).toBeGreaterThanOrEqual(2);
    }
  });

  it('미러 포함 폭보다 바깥으로 나가지 않는다 (차체·미러가 칸 안이면 표시도 칸 선에 닿지 않는다): 모든 차, 폰 미니맵 ~ 리플레이 축척', () => {
    for (const { name, spec } of CARS) {
      for (const s of [6, W / 18, 19, 37, 60]) {
        const { toPx, purple } = ticks(spec, s, { car: true });
        expect(purple, name).toHaveLength(2);
        // 북쪽을 향한 차: 옆 방향 = 화면 x. 미러 포함 폭의 바깥 끝(px x)
        const west = toPx({ x: POSE.x - spec.widthMirrors / 2, y: 0 })[0];
        const east = toPx({ x: POSE.x + spec.widthMirrors / 2, y: 0 })[0];
        for (const t of purple) {
          for (const [x] of t.pts) {
            expect(x, `${name} @${s}`).toBeGreaterThanOrEqual(west - 1e-6);
            expect(x, `${name} @${s}`).toBeLessThanOrEqual(east + 1e-6);
          }
        }
      }
    }
  });

  it('확대하면 실제 크기를 따른다: 안쪽 0.35 m, 바깥 = 미러 돌출(모델 Y 0.1045 m), 굵기 0.1 m', () => {
    const s = 60;
    const { fp, toPx, purple } = ticks(MODEL_Y_2025, s, { car: true });
    expect(purple).toHaveLength(2);
    const hw = MODEL_Y_2025.width / 2;
    for (const side of [1, -1]) {
      const [ex] = toPx(polyToWorld([{ x: fp.bPillarX, y: side * hw }], POSE)[0]);
      const [cx] = toPx(POSE);
      const tick = purple.find((t) => Math.sign(t.pts[0][0] - cx) === -side)!;
      const ins = tick.pts.map(([x]) => (x - ex) * side).sort((a, b) => a - b);
      expect(ins[0]).toBeCloseTo(-0.1045 * s, 6);
      expect(ins[1]).toBeCloseTo(0.35 * s, 6);
      expect(tick.lw).toBeCloseTo(0.1 * s, 9);
    }
  });

  it('고스트(이전 기록의 차)에는 그리지 않는다', () => {
    expect(ticks(MODEL_Y_2025, W / 18, { ghost: true }).purple).toHaveLength(0);
    expect(ticks(MODEL_Y_2025, W / 18, { car: true, ghost: true }).purple).toHaveLength(2);
  });
});
