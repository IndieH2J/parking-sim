import { describe, expect, it } from 'vitest';
import type { Pose } from '../src/sim/geometry';
import { evaluateGoal, rectFromAabb, wrapPi, type ORect } from '../src/sim/goal';
import { motionCtx, poseClear, type MotionCtx } from '../src/sim/motion';
import { isConvex } from '../src/scenarios/common';
import { AISLE, buildRearPerpendicular } from '../src/scenarios/rearPerpendicular';
import { PERP_SLOT_PRESETS, type Scenario, type TargetKind } from '../src/scenarios/types';
import { allSpecs, dirChanges, inRect, move, setSteer, startDrive, type Drive } from './helpers/drive';

// 후면 직각 해결 가능성 (계약서 §8.2). 배치 동일성·판정 격자는 tests/goal.test.ts (코어 A).
// 목표 자세 G에서 앞으로 나와 왼쪽으로 돌아 통로에 출발 방향(동쪽)으로 선다.
// 이 경로를 거꾸로 돌리면 통로에서 뒤로 넣는 경로다 (tests/helpers/drive.ts 머리말).

const TARGETS: readonly TargetKind[] = ['between', 'pillar'];

/** 증명하지 못해 건너뛰는 경우 (§8.2 실패 정책: 사유를 제목에 넣어 it.skip, 결정 로그에 기록). 지금은 없다. */
const KNOWN_TIGHT: { vehicle: string; option: string; reason: string }[] = [];

/** 목표 칸 휠스톱의 통로 쪽 면 (y) */
function stopFace(sc: Scenario): number {
  const r = sc.goal.rect;
  const stops = sc.elements.filter((e) => e.kind === 'wheelStop' && e.bc!.y > 0 && Math.abs(e.bc!.x - r.cx) < r.halfW);
  return Math.min(...stops.flatMap((e) => e.poly.map((p) => p.y)));
}

/**
 * 앞으로 s0 m 직진한 뒤 왼쪽 끝까지 꺾고 heading이 corridor.angle이 될 때까지 전진 (§8.2 rearPerp 행).
 * s0를 0..4 m에서 0.1 m 간격으로 보고, 처음으로 통로에 들어가는 운전을 돌려준다.
 */
function driveOut(ctx: MotionCtx, G: Pose, corridor: ORect): Drive | null {
  const arc = wrapPi(corridor.angle - G.heading) / (Math.tan(ctx.maxSteer) / ctx.spec.wheelbase);
  for (let i = 0; i <= 40; i++) {
    const s0 = i / 10;
    const d = startDrive(ctx, G);
    if (move(d, s0) < s0 - 1e-9 || !setSteer(d, 1) || move(d, arc) < arc - 1e-9) continue;
    if (inRect(ctx.fp, d.pose, corridor, 20)) return d;
  }
  return null;
}

for (const slotWidth of PERP_SLOT_PRESETS) {
  for (const target of TARGETS) {
    const option = `${slotWidth} ${target}`;

    describe(`후면 직각 ${option}: 목표 자세에서 통로로 나올 수 있다 (§8.2)`, () => {
      const sc = buildRearPerpendicular({ slotWidth, target });
      const r = sc.goal.rect;
      // 통로: 양 끝벽 안쪽, y −6..0. rect 각도 = 출발 방향
      const corridor = rectFromAabb(sc.bounds.x0 + 0.3, -AISLE, sc.bounds.x1 - 0.3, 0, sc.start.heading);
      const face = stopFace(sc);

      it('요소: 모두 볼록, id가 겹치지 않음', () => {
        expect(sc.elements.every((e) => isConvex(e.poly))).toBe(true);
        expect(new Set(sc.elements.map((e) => e.id)).size).toBe(sc.elements.length);
        expect(sc.floor.every((f) => isConvex(f.poly))).toBe(true);
      });

      for (const spec of allSpecs()) {
        const tight = KNOWN_TIGHT.find((k) => k.vehicle === spec.id && k.option === option);
        (tight ? it.skip : it)(tight ? `${spec.id}: KNOWN_TIGHT, ${tight.reason}` : spec.id, () => {
          const ctx = motionCtx(spec, sc.elements);
          // 출발: 막히지 않고, 아직 성공이 아니고, 통로 안
          expect(poseClear(ctx, sc.start, 0).kind).toBe('ok');
          expect(evaluateGoal(sc.goal, ctx.fp, sc.start).success).toBe(false);
          expect(inRect(ctx.fp, sc.start, corridor, 20)).toBe(true);

          // G: 칸 가운데, 뒤로 넣은 방향, 뒷바퀴 뒤끝이 휠스톱 면 0.03 m 앞
          const G: Pose = { x: r.cx, y: face - 0.03 - spec.tireDiameter / 2, heading: -Math.PI / 2 };
          expect(evaluateGoal(sc.goal, ctx.fp, G).success).toBe(true);
          expect(poseClear(ctx, G, 0).kind).toBe('ok');

          const d = driveOut(ctx, G, corridor);
          expect(d, 'no s0 in 0..4 m reaches the aisle').not.toBeNull();
          expect(inRect(ctx.fp, d!.pose, corridor, 20)).toBe(true);
          expect(dirChanges(d!)).toBeLessThanOrEqual(12);
        });
      }
    });
  }
}
