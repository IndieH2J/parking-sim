import { describe, expect, it } from 'vitest';
import { aabbRect, polyToWorld, type Vec2 } from '../src/sim/geometry';
import { buildFootprint } from '../src/sim/footprint';
import { evaluateGoal, rectCorners, rectFromAabb, wrapPi, type Goal } from '../src/sim/goal';
import { motionCtx, poseClear } from '../src/sim/motion';
import { MODEL_Y_2025 as SPEC } from '../src/sim/specs';
import type { WorldElement } from '../src/sim/world';
import { AISLE, buildGarage, buildRearPerpendicular, LINE_WIDTH, REAR_STOP_FROM_BACK } from '../src/scenarios/rearPerpendicular';
import { boundsOf, elementAdder, isConvex, lineEl } from '../src/scenarios/common';

const DEG = Math.PI / 180;

// v1 코드로 리팩터링 전에 잰 값 (계약서 §1.8.1). 배치·시드·rnd() 순서가 v1과 같아야 한다.
//   count: 요소 수, poly: Σ_i (i + 1) · Σ_꼭짓점 (1.3·x + 0.7·y)
//   meta: Σ_i (i + 1) · (높이·dir·주차 차량 meta 가중합), sig: id·kind·tag·meta 키 목록의 FNV-1a 해시
//   slot: v1 targetSlot (x0, x1, y1), start.x, bounds (x1, y0, y1; x0 = −6.8, start.y = −3, heading 0)
const V1 = [
  { w: 2.3, target: 'between', count: 105, poly: 271531.365534, meta: 47769.745488, sig: 3110284133,
    slot: [10.875, 13.025, 4.925], startX: 2.95, bounds: [29.9, -11.6, 5.6] },
  { w: 2.3, target: 'pillar', count: 105, poly: 271974.410189, meta: 47964.494305, sig: 77817017,
    slot: [8.575, 10.725, 4.925], startX: 0.65, bounds: [29.9, -11.6, 5.6] },
  { w: 2.5, target: 'between', count: 105, poly: 299157.925534, meta: 49028.405488, sig: 3110284133,
    slot: [11.675, 14.025, 4.925], startX: 3.85, bounds: [31.7, -11.6, 5.6] },
  { w: 2.5, target: 'pillar', count: 105, poly: 299640.490189, meta: 49235.374305, sig: 77817017,
    slot: [9.175, 11.525, 4.925], startX: 1.35, bounds: [31.7, -11.6, 5.6] },
  { w: 2.6, target: 'between', count: 105, poly: 311806.405534, meta: 49612.375488, sig: 3110284133,
    slot: [12.075, 14.525, 5.125], startX: 4.3, bounds: [32.6, -11.8, 5.8] },
  { w: 2.6, target: 'pillar', count: 105, poly: 312308.730189, meta: 49825.734305, sig: 77817017,
    slot: [9.475, 11.925, 5.125], startX: 1.7, bounds: [32.6, -11.8, 5.8] },
] as const;

const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** v1 rearPerpendicular.ts의 insideSlot 그대로 (기준 구현) */
function insideSlot(bodyWorld: Vec2[], slot: { x0: number; x1: number; y0: number; y1: number }): boolean {
  return bodyWorld.every((p) => p.x >= slot.x0 && p.x <= slot.x1 && p.y >= slot.y0 && p.y <= slot.y1);
}

describe('후면 직각 배치는 v1과 같다 (layout equivalence)', () => {
  for (const c of V1) {
    it(`칸 ${c.w} m, ${c.target}: 요소`, () => {
      const { elements } = buildRearPerpendicular({ slotWidth: c.w, target: c.target });
      let poly = 0;
      let meta = 0;
      elements.forEach((el, i) => {
        let s = 0;
        for (const p of el.poly) s += 1.3 * p.x + 0.7 * p.y;
        poly += (i + 1) * s;
        const m = el.meta ?? {};
        const v =
          1.1 * el.hMin + 1.7 * el.hMax + 2.3 * (el.dir ?? -1) + 1.3 * num(m.cx) + 0.7 * num(m.cy) + 2.9 * num(m.heading) +
          1.9 * num(m.length) + 3.1 * num(m.width) + 4.3 * num(m.height) + 1e-6 * num(m.color);
        meta += (i + 1) * v;
      });
      const sig = elements.map((e) => `${e.id}:${e.kind}:${e.tag ?? ''}:${Object.keys(e.meta ?? {}).join('.')}`).join(',');
      expect(elements.length).toBe(c.count);
      expect(Math.abs(round6(poly) - c.poly)).toBeLessThan(2e-6);
      expect(Math.abs(round6(meta) - c.meta)).toBeLessThan(2e-6);
      expect(fnv1a(sig)).toBe(c.sig);
    });

    it(`칸 ${c.w} m, ${c.target}: 출발·범위는 v1과 같고 목표는 v1 칸에서 뒤 경계만 선 폭만큼 깊다`, () => {
      const sc = buildRearPerpendicular({ slotWidth: c.w, target: c.target });
      expect(sc.kind).toBe('rearPerp');
      expect(sc.start.x).toBeCloseTo(c.startX, 9);
      expect(sc.start.y).toBe(-AISLE / 2);
      expect(sc.start.heading).toBe(0);
      expect(sc.bounds.x0).toBeCloseTo(-6.8, 9);
      expect(sc.bounds.x1).toBeCloseTo(c.bounds[0], 9);
      expect(sc.bounds.y0).toBeCloseTo(c.bounds[1], 9);
      expect(sc.bounds.y1).toBeCloseTo(c.bounds[2], 9);
      expect(sc.ceilingHeight).toBe(2.7);

      const [x0, x1, y1] = c.slot;
      expect(sc.goal).toMatchObject({ kind: 'slot', maxAngleDeg: 15 });
      expect(sc.goal.rect.angle).toBe(-Math.PI / 2);
      const xs = rectCorners(sc.goal.rect).map((p) => p.x);
      const ys = rectCorners(sc.goal.rect).map((p) => p.y);
      expect(Math.min(...xs)).toBeCloseTo(x0, 9);
      expect(Math.max(...xs)).toBeCloseTo(x1, 9);
      expect(Math.min(...ys)).toBeCloseTo(0, 9);
      expect(Math.max(...ys)).toBeCloseTo(y1 + LINE_WIDTH, 9);

      // 바닥 패치·조명 (v1 scene.ts에 박혀 있던 배치)
      expect(sc.floor).toEqual([{ poly: aabbRect(sc.bounds.x0, -AISLE, sc.bounds.x1, 0), tone: 'aisle' }]);
      const lamps = [];
      for (let x = sc.bounds.x0 + 2; x < sc.bounds.x1 - 1; x += 3) {
        for (const y of [-1.5, -4.5, 2.5, -8.5]) lamps.push({ x, y, heading: 0 });
      }
      expect(sc.lamps).toEqual(lamps);
    });
  }
});

describe('scenarios/common 도구', () => {
  it('isConvex', () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(isConvex(sq)).toBe(true);
    expect(isConvex([...sq].reverse())).toBe(true); // 시계 방향도 볼록
    expect(isConvex([{ x: 0, y: 0 }, { x: 0.5, y: 0 }, ...sq.slice(1)])).toBe(true); // 한 직선 위 꼭짓점
    expect(isConvex([sq[0], sq[2], sq[1], sq[3]])).toBe(false); // 나비 모양
    expect(isConvex([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 1 }, { x: 0, y: 1 }])).toBe(false); // 오목
    const star = [0, 2, 4, 1, 3].map((k) => ({ x: Math.cos((k * 2 * Math.PI) / 5), y: Math.sin((k * 2 * Math.PI) / 5) }));
    expect(isConvex(star)).toBe(false); // 같은 방향으로만 꺾이지만 두 바퀴
    expect(isConvex(sq.slice(0, 2))).toBe(false);
  });

  it('elementAdder: prepare + 순서대로 id, boundsOf: 꼭짓점 범위 + pad', () => {
    const list: WorldElement[] = [];
    const add = elementAdder(list);
    const a = add(lineEl(aabbRect(0, 0, 2, 0.15), 0));
    add({ kind: 'solid', tag: 'wall', poly: aabbRect(-1, 3, 4, 3.3), hMin: 0, hMax: 2.7 });
    expect(list.map((e) => e.id)).toEqual(['e0', 'e1']);
    expect(a).toBe(list[0]);
    expect(a).toMatchObject({ kind: 'line', hMin: 0, hMax: 0.003, dir: 0 });
    expect(a.bc).toEqual({ x: 1, y: 0.075 });
    expect(a.br).toBeGreaterThan(1);
    expect(boundsOf(list, 0.5)).toEqual({ x0: -1.5, x1: 4.5, y0: -0.5, y1: 3.8 });
  });

  it('후면 직각: 모든 요소가 볼록하고 id가 겹치지 않는다', () => {
    for (const w of [2.3, 2.5, 2.6]) {
      for (const target of ['between', 'pillar'] as const) {
        const sc = buildRearPerpendicular({ slotWidth: w, target });
        expect(sc.elements.every((e) => isConvex(e.poly))).toBe(true);
        expect(new Set(sc.elements.map((e) => e.id)).size).toBe(sc.elements.length);
        expect(sc.floor.every((f) => isConvex(f.poly))).toBe(true);
      }
    }
  });

  it('buildGarage: stopFromBack이 휠스톱만 바꾸고 주차 차량 배치는 그대로', () => {
    const opt = { slotWidth: 2.5, target: 'between' } as const;
    const cars = (els: WorldElement[]) => els.filter((e) => e.tag === 'car').map((e) => e.meta);
    const rear = buildGarage(opt, { stopFromBack: REAR_STOP_FROM_BACK });
    const none = buildGarage(opt, { stopFromBack: null });
    const front = buildGarage(opt, { stopFromBack: 0.6 });
    expect(none.elements.some((e) => e.kind === 'wheelStop')).toBe(false);
    expect(cars(none.elements)).toEqual(cars(rear.elements));
    expect(cars(front.elements)).toEqual(cars(rear.elements));
    expect(none.inner).toEqual(rear.inner);
    expect(rear.target).toMatchObject({ slotLen: 5.0 });
    expect(rear.inner.y1).toBeCloseTo(5.0 + LINE_WIDTH / 2, 12);
    // 목표 칸 휠스톱의 통로 쪽 면 = 뒷선 중심 − stopFromBack
    const face = (g: typeof rear) => {
      const cx = (g.target.x0 + g.target.x1) / 2;
      const ys = g.elements
        .filter((e) => e.kind === 'wheelStop' && e.bc!.y > 0 && Math.abs(e.bc!.x - cx) < 1)
        .flatMap((e) => e.poly.map((p) => p.y));
      return Math.min(...ys);
    };
    expect(face(rear)).toBeCloseTo(5.0 - 0.8, 9);
    expect(face(front)).toBeCloseTo(5.0 - 0.6, 9);
  });
});

describe('goal 기하 도구', () => {
  it('wrapPi는 (−π, π]', () => {
    expect(wrapPi(Math.PI)).toBe(Math.PI);
    expect(wrapPi(-Math.PI)).toBe(Math.PI);
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapPi(-0.5)).toBe(-0.5);
    expect(wrapPi(2 * Math.PI + 0.25)).toBeCloseTo(0.25, 12);
    expect(wrapPi(-2 * Math.PI - 0.25)).toBeCloseTo(-0.25, 12);
    for (let a = -20; a <= 20; a += 0.37) {
      const w = wrapPi(a);
      expect(w).toBeGreaterThan(-Math.PI);
      expect(w).toBeLessThanOrEqual(Math.PI);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 9);
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 9);
    }
  });

  it('rectFromAabb: halfL은 angle 방향 길이의 절반, rectCorners는 반시계', () => {
    const a = rectFromAabb(0, 0, 4, 2, 0);
    expect(a).toEqual({ cx: 2, cy: 1, angle: 0, halfL: 2, halfW: 1 });
    const b = rectFromAabb(0, 0, 4, 2, -Math.PI / 2);
    expect(b).toMatchObject({ cx: 2, cy: 1, halfL: 1, halfW: 2 });
    for (const r of [a, b, rectFromAabb(1, 1, 3, 6, Math.PI), rectFromAabb(1, 1, 3, 6, Math.PI / 2)]) {
      const c = rectCorners(r);
      let area2 = 0;
      for (let i = 0; i < 4; i++) area2 += c[i].x * c[(i + 1) % 4].y - c[(i + 1) % 4].x * c[i].y;
      expect(area2).toBeGreaterThan(0);
      expect(area2 / 2).toBeCloseTo(4 * r.halfL * r.halfW, 9);
    }
  });
});

describe('evaluateGoal = v1 insideSlot (후면 직각, 뒤 경계만 뒷선 바깥 가장자리로)', () => {
  const fp = buildFootprint(SPEC);
  for (const c of V1) {
    it(`칸 ${c.w} m, ${c.target}`, () => {
      const sc = buildRearPerpendicular({ slotWidth: c.w, target: c.target });
      const [x0, x1, y1] = c.slot;
      // = {t.x0 + lw/2, t.x1 − lw/2, 0, slotLen + lw/2}
      const ref = { x0, x1, y0: 0, y1: y1 + LINE_WIDTH };
      const cx = (x0 + x1) / 2;
      const slotLen = y1 + LINE_WIDTH / 2;
      const nY = Math.round((slotLen + 0.6) / 0.05);
      let inside = 0;
      let total = 0;
      for (let i = -6; i <= 6; i++) {
        for (let k = 0; k <= nY; k++) {
          for (const dh of [-3, 0, 3]) {
            const pose = { x: cx + 0.05 * i, y: -0.3 + 0.05 * k, heading: -Math.PI / 2 + dh * DEG };
            const want = insideSlot(polyToWorld(fp.body.poly, pose), ref);
            const ev = evaluateGoal(sc.goal, fp, pose);
            expect(ev.inside, `x ${pose.x.toFixed(3)} y ${pose.y.toFixed(3)} dh ${dh}`).toBe(want);
            expect(ev.success).toBe(want); // 뒤로 넣은 자세(±3°)는 방향 조건을 늘 만족
            if (want) inside++;
            total++;
          }
        }
      }
      expect(inside).toBeGreaterThan(0);
      expect(inside).toBeLessThan(total);
    });
  }
});

describe('evaluateGoal 판정 값', () => {
  const fp = buildFootprint(SPEC);

  it('2.5 m 칸 중앙: 좌우 여유 21.5 cm, 미러 11.05 cm, 앞뒤 여유와 오프셋', () => {
    const sc = buildRearPerpendicular({ slotWidth: 2.5, target: 'between' });
    const r = sc.goal.rect;
    const rearBumperY = r.cy + r.halfL - 0.25; // = 4.825
    const ev = evaluateGoal(sc.goal, fp, { x: r.cx, y: rearBumperY - SPEC.rearOverhang, heading: -Math.PI / 2 });
    expect(ev.success).toBe(true);
    expect(ev.angleErrDeg).toBeCloseTo(0, 9);
    expect(ev.margin.left).toBeCloseTo(0.215, 9);
    expect(ev.margin.right).toBeCloseTo(0.215, 9);
    expect(ev.mirrorMargin.left).toBeCloseTo(0.1105, 9);
    expect(ev.mirrorMargin.right).toBeCloseTo(0.1105, 9);
    expect(ev.margin.back).toBeCloseTo(0.25, 9);
    expect(ev.margin.front).toBeCloseTo(4.825 - SPEC.length, 9); // 앞범퍼 → 칸 입구 (y = 0)
    expect(ev.offset.across).toBeCloseTo(0, 9);
    expect(ev.offset.along).toBeCloseTo((ev.margin.back - ev.margin.front) / 2, 9); // + = 앞(통로 쪽)
  });

  it('왼쪽으로 치우치면 margin.left가 줄고 offset.across가 +', () => {
    const sc = buildRearPerpendicular({ slotWidth: 2.5, target: 'between' });
    const r = sc.goal.rect;
    // heading −π/2 차의 왼쪽 = +x
    const ev = evaluateGoal(sc.goal, fp, { x: r.cx + 0.1, y: 3.9, heading: -Math.PI / 2 });
    expect(ev.margin.left).toBeCloseTo(0.115, 9);
    expect(ev.margin.right).toBeCloseTo(0.315, 9);
    expect(ev.offset.across).toBeCloseTo(0.1, 9);
  });

  it('앞으로 넣은 자세: inside지만 방향이 반대 (angleErr ≈ 180°)', () => {
    const sc = buildRearPerpendicular({ slotWidth: 2.5, target: 'between' });
    const ev = evaluateGoal(sc.goal, fp, { x: sc.goal.rect.cx, y: 1.15, heading: Math.PI / 2 });
    expect(ev.inside).toBe(true);
    expect(ev.angleErrDeg).toBeCloseTo(180, 9);
    expect(ev.headingOk).toBe(false);
    expect(ev.success).toBe(false);
  });

  it('밖으로 나가면 해당 여유가 음수', () => {
    const sc = buildRearPerpendicular({ slotWidth: 2.5, target: 'between' });
    const ev = evaluateGoal(sc.goal, fp, { x: sc.goal.rect.cx, y: 3.5, heading: -Math.PI / 2 });
    expect(ev.margin.front).toBeCloseTo(3.5 - (SPEC.wheelbase + SPEC.frontOverhang), 9);
    expect(ev.margin.front).toBeLessThan(0);
    expect(ev.inside).toBe(false);
    expect(ev.success).toBe(false);
  });

  it('zone 목표: 30° 안이면 성공, 밖이면 방향 실패, 구역 밖이면 실패', () => {
    const goal: Goal = { kind: 'zone', rect: rectFromAabb(-4, 10, 4, 20, Math.PI / 2), maxAngleDeg: 30 };
    const ok = evaluateGoal(goal, fp, { x: 0, y: 12, heading: Math.PI / 2 + 20 * DEG });
    expect(ok.inside).toBe(true);
    expect(ok.angleErrDeg).toBeCloseTo(20, 9);
    expect(ok.success).toBe(true);
    const tilted = evaluateGoal(goal, fp, { x: 0, y: 12, heading: Math.PI / 2 - 40 * DEG });
    expect(tilted.inside).toBe(true);
    expect(tilted.headingOk).toBe(false);
    expect(tilted.success).toBe(false);
    // 한 바퀴 더 돈 각도도 같은 방향
    const wrapped = evaluateGoal(goal, fp, { x: 0, y: 12, heading: Math.PI / 2 + 2 * Math.PI - 5 * DEG });
    expect(wrapped.angleErrDeg).toBeCloseTo(5, 9);
    const short = evaluateGoal(goal, fp, { x: 0, y: 8, heading: Math.PI / 2 });
    expect(short.inside).toBe(false);
    expect(short.margin.back).toBeCloseTo(8 - SPEC.rearOverhang - 10, 9);
    expect(short.success).toBe(false);
  });
});

describe('뒤 경계 이동은 모델 Y 결과를 바꾸지 않는다 (§1.8.1)', () => {
  const ctx0 = (w: number) => {
    const sc = buildRearPerpendicular({ slotWidth: w, target: 'between' });
    return { sc, ctx: motionCtx(SPEC, sc.elements) };
  };
  for (const w of [2.5, 2.6]) {
    it(`칸 길이 ${w >= 2.6 ? 5.2 : 5.0} m: 휠스톱에 뒷바퀴가 닿은 모델 Y의 뒤범퍼는 v1 뒤 경계(뒷선 안쪽) 안`, () => {
      const { sc, ctx } = ctx0(w);
      const r = sc.goal.rect;
      const stops = sc.elements.filter(
        (e) => e.kind === 'wheelStop' && e.bc!.y > 0 && Math.abs(e.bc!.x - r.cx) < r.halfW,
      );
      expect(stops.length).toBe(2);
      const face = Math.min(...stops.flatMap((e) => e.poly.map((p) => p.y))); // 통로 쪽 면
      const slotLen = w >= 2.6 ? 5.2 : 5.0;
      expect(face).toBeCloseTo(slotLen - 0.8, 9);
      const axleY = face - SPEC.tireDiameter / 2; // heading −π/2: 뒷바퀴 뒤끝 = 뒤축 + d/2
      // 정말 닿는 자리인지: 조금 덜 가면 통과, 조금 더 가면 바퀴가 걸린다
      expect(poseClear(ctx, { x: r.cx, y: axleY - 0.002, heading: -Math.PI / 2 }, 0).kind).toBe('ok');
      expect(poseClear(ctx, { x: r.cx, y: axleY + 0.002, heading: -Math.PI / 2 }, 0).kind).toBe('wheel');
      const rearBumper = axleY + SPEC.rearOverhang;
      expect(rearBumper).toBeLessThan(slotLen - LINE_WIDTH / 2); // v1 뒤 경계
      const ev = evaluateGoal(sc.goal, buildFootprint(SPEC), { x: r.cx, y: axleY - 0.002, heading: -Math.PI / 2 });
      expect(ev.success).toBe(true);
      // 뒤축 위치 허용 폭 = 앞범퍼가 입구(y 0)에 닿을 때 ~ 휠스톱에 닿을 때 (5.0 m 칸에서 6.5 cm)
      const window = axleY - (SPEC.wheelbase + SPEC.frontOverhang);
      expect(window).toBeCloseTo(slotLen - 0.8 - SPEC.tireDiameter / 2 - SPEC.wheelbase - SPEC.frontOverhang, 9);
      if (slotLen === 5.0) expect(window).toBeCloseTo(0.065, 3);
    });
  }
});
