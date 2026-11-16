import { describe, expect, it } from 'vitest';
import { MODEL_Y_2025, type VehicleSpec } from '../src/sim/specs';
import { buildFootprint } from '../src/sim/footprint';
import { polyToWorld, type Pose, type Vec2 } from '../src/sim/geometry';
import { rectCorners } from '../src/sim/goal';
import { CUSTOM_ID, getSpec } from '../src/sim/vehicles';
import { buildRearPerpendicular } from '../src/scenarios/rearPerpendicular';
import { buildFrontPerpendicular } from '../src/scenarios/frontPerpendicular';
import { buildParallel } from '../src/scenarios/parallel';
import { buildNarrowRamp } from '../src/scenarios/narrowRamp';
import {
  PARALLEL_LENGTH_PRESETS,
  PARALLEL_LENGTH_RANGE,
  PERP_SLOT_PRESETS,
  PERP_SLOT_RANGE,
  RAMP_RADIUS_OPTIONS,
  type Scenario,
  type TargetKind,
} from '../src/scenarios/types';
import { DEFAULT_SETTINGS } from '../src/ui/settings';
import { fitLot, type TopViewCamera } from '../src/render/minimap';

// 운전 중 탑뷰의 맞춤 (계약서 개정 2026-11-16 top-view): 주차장 전체(바닥·요소·목표·차)가 상태 표시줄 아래 보이는 영역에
// 들어오고, 한 축은 꽉 차며, 그 영역 가운데에 놓인다. 빌더를 직접 import한다 (§A.5).

/** 위쪽 inset = #topbar 아래 끝 + 6 px (main.ts TOPBAR_GAP). 실제 화면에서 잰 값: 데스크톱 51 px, 폰 48 px */
const SIZES = [
  { name: '1280×720', w: 1280, h: 720, inset: 57 },
  { name: '844×390', w: 844, h: 390, inset: 54 },
  { name: '667×375', w: 667, h: 375, inset: 54 },
];

/** 직접 입력 최대급 차 (tests/narrowRamp.test.ts OVERSIZED_DIMS와 같음): 램프 차로가 가장 넓어진다 */
const OVERSIZED = getSpec(CUSTOM_ID, {
  lengthMm: 6000,
  widthMm: 2200,
  widthMirrorsMm: 2600,
  heightMm: 2000,
  wheelbaseMm: 3800,
  frontOverhangMm: 1300,
  trackMm: 1900,
  turningDiameterM: 15.0,
});

interface Case {
  name: string;
  sc: Scenario;
  spec: VehicleSpec;
}

const D = DEFAULT_SETTINGS;
const perpWidths = [D.perp.slotWidth, Math.max(...PERP_SLOT_PRESETS), PERP_SLOT_RANGE.max];
const parallelLengths = [D.parallel.slotLength, Math.max(...PARALLEL_LENGTH_PRESETS), PARALLEL_LENGTH_RANGE.max];
const targets: TargetKind[] = ['between', 'pillar'];

const CASES: Case[] = [
  ...perpWidths.flatMap((slotWidth) =>
    targets.flatMap((target) => [
      { name: `rearPerp ${slotWidth} m ${target}`, sc: buildRearPerpendicular({ slotWidth, target }), spec: MODEL_Y_2025 },
      { name: `frontPerp ${slotWidth} m ${target}`, sc: buildFrontPerpendicular({ slotWidth, target }), spec: MODEL_Y_2025 },
    ]),
  ),
  ...parallelLengths.map((slotLength) => ({ name: `parallel ${slotLength} m`, sc: buildParallel({ slotLength }), spec: MODEL_Y_2025 })),
  ...RAMP_RADIUS_OPTIONS.flatMap((innerRadius) =>
    [MODEL_Y_2025, OVERSIZED].map((spec) => ({
      name: `ramp R${innerRadius} ${spec.id}`,
      sc: buildNarrowRamp({ innerRadius }, spec),
      spec,
    })),
  ),
];

/** 차(차체·미러)의 월드 꼭짓점 */
function carVerts(spec: VehicleSpec, pose: Pose): Vec2[] {
  const fp = buildFootprint(spec);
  return [fp.body, fp.mirrorLeft, fp.mirrorRight].flatMap((part) => polyToWorld(part.poly, pose));
}

/** 계약의 범위: 모든 바닥 구역·요소 다각형 + 목표 꼭짓점 + 차 */
function lotVerts(sc: Scenario, spec: VehicleSpec, pose: Pose): Vec2[] {
  return [...sc.floor.flatMap((f) => f.poly), ...sc.elements.flatMap((el) => el.poly), ...rectCorners(sc.goal.rect), ...carVerts(spec, pose)];
}

/** drawTopView의 toPx와 같은 투영 (북쪽 +y가 위) */
const toPx = (cam: TopViewCamera, w: number, h: number, p: Vec2) => ({
  x: w / 2 + (p.x - cam.cx) * cam.pxPerM,
  y: h / 2 - (p.y - cam.cy) * cam.pxPerM,
});

const EPS = 1e-6;

/** 꼭짓점들이 화면에서 차지하는 범위 (px) */
function pxBox(cam: TopViewCamera, w: number, h: number, verts: Vec2[]) {
  const ps = verts.map((p) => toPx(cam, w, h, p));
  return {
    x0: Math.min(...ps.map((p) => p.x)),
    x1: Math.max(...ps.map((p) => p.x)),
    y0: Math.min(...ps.map((p) => p.y)),
    y1: Math.max(...ps.map((p) => p.y)),
  };
}

describe('fitLot: 운전 중 탑뷰 맞춤 (계약서 개정 2026-11-16 top-view)', () => {
  for (const c of CASES) {
    for (const s of SIZES) {
      it(`${c.name} @ ${s.name}: 범위의 모든 꼭짓점이 상태 표시줄 아래 캔버스 안, 한 축은 꽉 참, 가운데`, () => {
        const fp = buildFootprint(c.spec);
        const pose = c.sc.start;
        const cam = fitLot(c.sc, { fp, pose }, s.w, s.h, s.inset);
        const b = pxBox(cam, s.w, s.h, lotVerts(c.sc, c.spec, pose));
        // 보이는 영역: 가로 0..w, 세로 inset..h
        expect(b.x0).toBeGreaterThanOrEqual(-EPS);
        expect(b.x1).toBeLessThanOrEqual(s.w + EPS);
        expect(b.y0).toBeGreaterThanOrEqual(s.inset - EPS);
        expect(b.y1).toBeLessThanOrEqual(s.h + EPS);
        // 한 축은 꽉 찬다 (여유 없음)
        const tightX = Math.abs(b.x0) < EPS && Math.abs(b.x1 - s.w) < EPS;
        const tightY = Math.abs(b.y0 - s.inset) < EPS && Math.abs(b.y1 - s.h) < EPS;
        expect(tightX || tightY).toBe(true);
        // 보이는 영역의 가운데
        expect((b.x0 + b.x1) / 2).toBeCloseTo(s.w / 2, 6);
        expect((b.y0 + b.y1) / 2).toBeCloseTo((s.inset + s.h) / 2, 6);
      });
    }
  }

  it('주차장 밖의 차(디버그 순간이동)도 범위에 넣는다', () => {
    const sc = buildRearPerpendicular({ slotWidth: D.perp.slotWidth, target: D.perp.target });
    const fp = buildFootprint(MODEL_Y_2025);
    const outside: Pose = { x: sc.bounds.x1 + 5, y: sc.bounds.y1 + 3, heading: 0.4 };
    const { w, h, inset } = SIZES[0];
    const cam = fitLot(sc, { fp, pose: outside }, w, h, inset);
    const b = pxBox(cam, w, h, carVerts(MODEL_Y_2025, outside));
    expect(b.x1).toBeLessThanOrEqual(w + EPS);
    expect(b.y0).toBeGreaterThanOrEqual(inset - EPS);
    // 차가 없을 때보다 축척이 작다 (범위가 넓어졌다)
    expect(cam.pxPerM).toBeLessThan(fitLot(sc, null, w, h, inset).pxPerM);
  });

  it('차가 주차장 안에 있으면 차를 빼도 같은 카메라', () => {
    for (const c of CASES) {
      const fp = buildFootprint(c.spec);
      const { w, h, inset } = SIZES[2];
      expect(fitLot(c.sc, { fp, pose: c.sc.start }, w, h, inset)).toEqual(fitLot(c.sc, null, w, h, inset));
    }
  });
});
