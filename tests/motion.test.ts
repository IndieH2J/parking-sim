import { describe, expect, it } from 'vitest';
import { MODEL_Y_2025 as SPEC } from '../src/sim/specs';
import { buildFootprint, wheelPolys } from '../src/sim/footprint';
import { aabbRect, polygonDistance, polygonsOverlap, polylinePolygonDistance, polyToWorld, type Pose } from '../src/sim/geometry';
import { canSteer, checkMove, motionCtx, poseClear, type MoveResult } from '../src/sim/motion';
import { AttemptTracker } from '../src/sim/attempt';
import { readSensors } from '../src/sim/sensors';
import { initialState, integratePose, updateSpeed } from '../src/sim/vehicle';
import { prepare, type WorldElement } from '../src/sim/world';
import { rectFromAabb } from '../src/sim/goal';
import {
  allSpecs,
  dirChanges,
  DS,
  inRect,
  move,
  moveSteering,
  moveUntilBlocked,
  setSteer,
  startDrive,
} from './helpers/drive';

const fp = buildFootprint(SPEC);
const O: Pose = { x: 0, y: 0, heading: 0 }; // 동쪽을 향한 차, 오른쪽 = −y
let nextId = 0;
const el = (e: Omit<WorldElement, 'id'>): WorldElement => prepare({ ...e, id: `t${nextId++}` });
/** 차 오른쪽(−y)에 길게 놓인 연석. face = 차로 쪽 면의 y */
const rightCurb = (face: number) => el({ kind: 'curb', poly: aabbRect(-6, face - 0.15, 10, face), hMin: 0, hMax: 0.15, dir: 0 });
/** 오른쪽 앞바퀴(FR)의 가장 바깥(−y) 점 */
const frOuterY = (steerNorm: number, pose = O) =>
  Math.min(...polyToWorld(wheelPolys(SPEC, steerNorm * motionCtx(SPEC, []).maxSteer).FR, pose).map((p) => p.y));
const fwd = (from: Pose, ds: number, steer = 0) => integratePose(from, SPEC, steer, ds, 1);

describe('canSteer: 제자리 조향 제한 (§1.5)', () => {
  it('타이어가 연석면에서 0.05 m: 연석 쪽으로 더 돌리기는 거부, 반대로 되돌리기는 허용', () => {
    // 이미 오른쪽(연석 쪽)으로 반쯤 돌린 상태. 앞바퀴 앞 바깥 모서리가 연석면에서 0.05 m
    const ctx = motionCtx(SPEC, [rightCurb(frOuterY(-0.5) - 0.05)]);
    expect(poseClear(ctx, O, -0.5).kind).toBe('ok');
    expect(canSteer(ctx, O, -0.5, -1)).toBe(false);
    expect(canSteer(ctx, O, -0.5, -0.9)).toBe(false);
    expect(canSteer(ctx, O, -0.5, 0)).toBe(true);
    expect(canSteer(ctx, O, -0.5, -0.4)).toBe(true);
    // 판정 기준은 방향이 아니라 겹침: 모서리가 1.7 cm만 더 나가는 조금의 추가 조향은 허용
    expect(canSteer(ctx, O, -0.5, -0.6)).toBe(true);
  });

  it('연석과 나란히 선 차: 끝까지 돌리면 어느 쪽이든 모서리가 연석에 닿아 거부, 조금은 허용', () => {
    // 끝까지 돌리면 타이어 모서리가 (d/2)sinδ + (w/2)cosδ − w/2 ≈ 0.175 m 바깥으로 나온다
    const swing = frOuterY(0) - frOuterY(1);
    expect(swing).toBeCloseTo(0.175, 2);
    const ctx = motionCtx(SPEC, [rightCurb(frOuterY(0) - 0.05)]);
    expect(poseClear(ctx, O, 0).kind).toBe('ok');
    expect(canSteer(ctx, O, 0, -1)).toBe(false);
    expect(canSteer(ctx, O, 0, 1)).toBe(false);
    expect(canSteer(ctx, O, 0, 0.1)).toBe(true);
    expect(canSteer(ctx, O, 0, -0.1)).toBe(true);
  });

  it('휠스톱도 연석처럼 조향을 막고, 이미 걸친 바퀴는 조향을 막지 않는다', () => {
    const stop = el({ kind: 'wheelStop', poly: aabbRect(-6, frOuterY(0) - 0.2, 10, frOuterY(0) - 0.05), hMin: 0, hMax: 0.12 });
    const ctx = motionCtx(SPEC, [stop]);
    expect(canSteer(ctx, O, 0, -1)).toBe(false);
    // 오른쪽 앞바퀴가 이미 걸친 자세(디버그 순간이동 등): 겹침이 새로 생기는 게 아니므로 허용
    const stuck = motionCtx(SPEC, [rightCurb(frOuterY(0) + 0.02)]);
    expect(poseClear(stuck, O, 0).kind).toBe('wheel');
    expect(canSteer(stuck, O, 0, -1)).toBe(true);
  });
});

describe('checkMove · poseClear', () => {
  // 앞바퀴 바로 앞을 가로지르는 연석 (앞바퀴 앞끝 x = 2.89 + 0.356 = 3.246)
  const curbAhead = el({ kind: 'curb', poly: aabbRect(3.3, -2, 3.45, 2), hMin: 0, hMax: 0.15, dir: Math.PI / 2 });

  it('연석 쪽으로 가면 거부(wheel), 멀어지면 ok', () => {
    const ctx = motionCtx(SPEC, [curbAhead]);
    const into = checkMove(ctx, O, fwd(O, 0.1), 0);
    expect(into.kind).toBe('wheel');
    if (into.kind === 'wheel') {
      expect(into.element.kind).toBe('curb');
      expect(['FL', 'FR']).toContain(into.wheel);
    }
    expect(checkMove(ctx, O, fwd(O, -0.1), 0).kind).toBe('ok');
  });

  it('solid에 겹치면 collision', () => {
    const wall = el({ kind: 'solid', tag: 'wall', poly: aabbRect(3.85, -3, 4.0, 3), hMin: 0, hMax: 2.7 });
    const ctx = motionCtx(SPEC, [wall]);
    const r = checkMove(ctx, O, fwd(O, 0.1), 0);
    expect(r.kind).toBe('collision');
    if (r.kind === 'collision') expect(r.hit.part).toBe('body');
    expect(poseClear(ctx, fwd(O, 0.1), 0).kind).toBe('collision');
    expect(checkMove(ctx, O, fwd(O, 0.05), 0).kind).toBe('ok');
  });

  it('poseClear는 checkMove의 "이미 걸침" 예외를 쓰지 않는다', () => {
    const ctx = motionCtx(SPEC, [curbAhead]);
    const a = fwd(O, 0.1); // 앞바퀴가 이미 연석에 걸친 자세
    const b = fwd(O, 0.15);
    expect(poseClear(ctx, a, 0).kind).toBe('wheel');
    expect(checkMove(ctx, a, b, 0).kind).toBe('ok'); // 게임 규칙(v1): 이미 걸친 바퀴는 움직일 수 있다
    expect(poseClear(ctx, b, 0).kind).toBe('wheel');
  });

  it('차체·미러는 연석 위를 지나간다: 바퀴가 안 닿으면 ok', () => {
    const underNose = el({ kind: 'curb', poly: aabbRect(3.4, -0.5, 3.6, 0.5), hMin: 0, hMax: 0.15, dir: Math.PI / 2 });
    const underMirror = el({ kind: 'curb', poly: aabbRect(2.0, 0.97, 2.5, 1.2), hMin: 0, hMax: 0.15, dir: 0 });
    expect(polygonsOverlap(polyToWorld(fp.body.poly, O), underNose.poly)).toBe(true);
    expect(polygonsOverlap(polyToWorld(fp.mirrorLeft.poly, O), underMirror.poly)).toBe(true);
    const ctx = motionCtx(SPEC, [underNose, underMirror]);
    expect(poseClear(ctx, O, 0).kind).toBe('ok');
    expect(checkMove(ctx, fwd(O, -0.3), O, 0).kind).toBe('ok');
  });
});

describe('센서: 연석은 선처럼 측면 거리에만 잡힌다', () => {
  it('오른쪽 연석 → lines.rightBody·rightMirror, zones에는 없음', () => {
    const curb = rightCurb(-SPEC.width / 2 - 0.3);
    const r = readSensors(fp, O, [curb]);
    expect(r.lines.rightBody).toBeCloseTo(0.3, 9);
    expect(r.lines.rightMirror).toBeCloseTo(SPEC.width / 2 + 0.3 - SPEC.widthMirrors / 2, 9);
    expect(r.lines.leftBody).toBeNull();
    for (const v of Object.values(r.zones)) expect(v).toBeNull();
  });

  it('왼쪽 연석 → lines.leftBody, 진행 방향과 수직인 주차선은 측면 거리에 안 쓴다 (연석은 방향과 상관없이 잰다)', () => {
    const left = el({ kind: 'curb', poly: aabbRect(-6, SPEC.width / 2 + 0.2, 10, SPEC.width / 2 + 0.35), hMin: 0, hMax: 0.12, dir: Math.PI });
    expect(readSensors(fp, O, [left]).lines.leftBody).toBeCloseTo(0.2, 9);
    // 차 뒤 오른쪽에 진행 방향과 수직으로 놓인 조각: 주차선이면 15° 필터로 빠지고, 연석이면 잰다
    const poly = aabbRect(-2, -1.5, -1.85, -1.0);
    const acrossLine = el({ kind: 'line', poly, hMin: 0, hMax: 0.003, dir: Math.PI / 2 });
    expect(readSensors(fp, O, [acrossLine]).lines.rightBody).toBeNull();
    const acrossCurb = el({ kind: 'curb', poly, hMin: 0, hMax: 0.15, dir: Math.PI / 2 });
    const r = readSensors(fp, O, [acrossCurb]);
    const rightSide = polyToWorld(fp.zones.right, O);
    expect(r.lines.rightBody).toBeCloseTo(polylinePolygonDistance(rightSide, poly), 9);
    for (const v of Object.values(r.zones)) expect(v).toBeNull();
  });

  it('곡선 바깥 연석(5° 현 조각): 차체 옆면 앞끝 옆 조각이 진행축과 15° 넘게 어긋나도 그 거리를 잰다', () => {
    // 왼쪽으로 정상 선회하는 차 (선회 중심 = 로컬 (0, R)). 바깥(오른쪽) 연석면은 차체 오른쪽 옆면 앞끝에서 gap 떨어진 원
    const R = 7.4;
    const gap = 0.03;
    const c = { x: 0, y: R };
    const sideFront = fp.zones.right[0]; // (xf − 0.15, −hw)
    const rFace = Math.hypot(sideFront.x - c.x, sideFront.y - c.y) + gap;
    const at = (r: number, a: number) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
    const step = (5 * Math.PI) / 180;
    const pieces: WorldElement[] = [];
    // 차 아래쪽(−π/2)에서 앞쪽으로 −120°..0° 범위의 현 조각. 꼭짓점이 원 위 (narrowRamp.ts와 같은 방식)
    for (let a = (-120 * Math.PI) / 180; a < -1e-9; a += step) {
      const b = a + step;
      const quad = [at(rFace, a), at(rFace + 0.3, a), at(rFace + 0.3, b), at(rFace, b)];
      pieces.push(el({ kind: 'curb', poly: quad, hMin: 0, hMax: 0.12, dir: Math.atan2(at(rFace, b).y - at(rFace, a).y, at(rFace, b).x - at(rFace, a).x) }));
    }
    const rightSide = polyToWorld(fp.zones.right, O);
    const truth = Math.min(...pieces.map((p) => polylinePolygonDistance(rightSide, p.poly)));
    expect(truth).toBeLessThan(gap + 1e-9); // 현 가운데는 원보다 안쪽이라 gap 이하
    // 가장 가까운 조각은 진행축과 15° 넘게 어긋난다 (그래서 예전 15° 필터로는 빠졌다)
    const nearest = pieces.reduce((a, b) => (polylinePolygonDistance(rightSide, b.poly) < polylinePolygonDistance(rightSide, a.poly) ? b : a));
    expect(Math.abs(Math.cos(nearest.dir!))).toBeLessThan(Math.cos((15 * Math.PI) / 180));
    const r = readSensors(fp, O, pieces);
    expect(r.lines.rightBody).toBeCloseTo(truth, 9);
    const mirror = polyToWorld(fp.mirrorRight.poly, O);
    expect(r.lines.rightMirror).toBeCloseTo(Math.min(...pieces.map((p) => polygonDistance(mirror, p.poly))), 9);
  });
});

describe('AttemptTracker (§1.6)', () => {
  const dt = 1 / 60;
  const curb = el({ kind: 'curb', poly: aabbRect(0, 0, 1, 1), hMin: 0, hMax: 0.15, dir: 0 });
  const stop = el({ kind: 'wheelStop', poly: aabbRect(0, 0, 1, 1), hMin: 0, hMax: 0.12 });
  const hitCurb: MoveResult = { kind: 'wheel', wheel: 'FR', element: curb };
  const hitStop: MoveResult = { kind: 'wheel', wheel: 'RL', element: stop };
  const ok: MoveResult = { kind: 'ok' };
  /** 앞바퀴 앞끝에서 0.5 m 앞을 가로지르는 연석 (뒤축 x가 0.5를 넘으면 닿는다) */
  const frontCurb = () => {
    const face = SPEC.wheelbase + SPEC.tireDiameter / 2 + 0.5;
    return el({ kind: 'curb', poly: aabbRect(face, -2, face + 0.15, 2), hMin: 0, hMax: 0.15, dir: Math.PI / 2 });
  };
  /**
   * main.ts step()의 3~5단계 순서로 모는 차 (조향 0). drive는 기어를 바꾸고 가속 페달을 throttle로 고정한 채
   * n 스텝을 진행하고, 바퀴가 막혀 거부된 스텝 수를 돌려준다.
   */
  const mainLoop = (elements: WorldElement[]) => {
    const ctx = motionCtx(SPEC, elements);
    const t = new AttemptTracker();
    const s = initialState(0, 0, 0);
    const drive = (gear: 'D' | 'R', n: number, throttle = 1): number => {
      s.gear = gear;
      let refused = 0;
      for (let i = 0; i < n; i++) {
        const v = updateSpeed(s, { throttle, brake: 0, steer: 0 }, dt);
        if (v === 0) {
          s.speed = 0;
          t.step(dt, 0, null);
          continue;
        }
        const to = integratePose(s, SPEC, 0, v, dt);
        const r = checkMove(ctx, s, to, 0);
        if (r.kind === 'wheel') {
          s.speed = 0;
          t.step(dt, 0, r);
          refused++;
          continue;
        }
        Object.assign(s, to, { speed: v });
        t.step(dt, v, r);
      }
      return refused;
    };
    return { t, s, drive };
  };

  it('연석에 막힌 120 스텝 = 접촉 1회', () => {
    const t = new AttemptTracker();
    t.step(dt, 0.5, ok);
    const news = [];
    for (let i = 0; i < 120; i++) news.push(t.step(dt, 0, hitCurb).newCurbTouch);
    expect(t.events.curbTouches).toBe(1);
    expect(news.filter(Boolean).length).toBe(1);
    expect(news[0]).toBe(true);
  });

  it('떨어졌다가 다시 닿으면 2회, 휠스톱은 세지 않는다', () => {
    const t = new AttemptTracker();
    for (let i = 0; i < 10; i++) t.step(dt, 0, hitCurb);
    t.step(dt, -0.4, ok);
    for (let i = 0; i < 10; i++) t.step(dt, 0, hitCurb);
    expect(t.events.curbTouches).toBe(2);
    t.step(dt, 0.4, ok);
    for (let i = 0; i < 10; i++) expect(t.step(dt, 0, hitStop).newCurbTouch).toBe(false);
    expect(t.events.curbTouches).toBe(2);
  });

  it('움직이지 않고 D → R 기어만 바꾸면 전환 0회, 시간도 0', () => {
    const t = new AttemptTracker();
    for (let i = 0; i < 30; i++) t.step(dt, 0, null);
    expect(t.events).toEqual({ dirChanges: 0, elapsed: 0, curbTouches: 0, collisions: 0 });
    expect(t.started).toBe(false);
  });

  it('전진, 정지, 후진, 전진 = 전환 2회', () => {
    const t = new AttemptTracker();
    const run = (v: number, n: number) => {
      for (let i = 0; i < n; i++) t.step(dt, v, v === 0 ? null : ok);
    };
    run(0.8, 30);
    run(0, 20);
    run(-0.6, 30);
    run(0, 5);
    run(0.5, 10);
    expect(t.events.dirChanges).toBe(2);
  });

  it('시간은 처음 움직일 때부터 잰다', () => {
    const t = new AttemptTracker();
    for (let i = 0; i < 30; i++) t.step(dt, 0, null);
    for (let i = 0; i < 60; i++) t.step(dt, 0.5, ok);
    expect(t.started).toBe(true);
    expect(t.events.elapsed).toBeCloseTo(1.0, 9);
    for (let i = 0; i < 30; i++) t.step(dt, 0, null); // 멈춰 있어도 흐른다
    expect(t.events.elapsed).toBeCloseTo(1.5, 9);
  });

  it('crash·finish 뒤에는 무시, reset으로 초기화', () => {
    const t = new AttemptTracker();
    for (let i = 0; i < 6; i++) t.step(dt, 0.5, ok);
    t.crash();
    expect(t.finished).toBe(true);
    expect(t.events.collisions).toBe(1);
    t.step(dt, -0.5, ok);
    t.step(dt, 0, hitCurb);
    expect(t.events).toMatchObject({ dirChanges: 0, curbTouches: 0, collisions: 1 });
    expect(t.events.elapsed).toBeCloseTo(6 * dt, 12);
    t.reset();
    expect(t.started).toBe(false);
    expect(t.finished).toBe(false);
    expect(t.events).toEqual({ dirChanges: 0, elapsed: 0, curbTouches: 0, collisions: 0 });
    t.step(dt, 0.5, ok);
    t.finish();
    t.step(dt, 0.5, ok);
    expect(t.finished).toBe(true);
    expect(t.events.elapsed).toBeCloseTo(dt, 12);
    expect(t.events.collisions).toBe(0);
  });

  // v2 게이트: 거부되면 속도가 0이 되고, 가속 페달을 밟고 있으면 다시 가속해 연석 쪽으로 몇 mm씩 다가간다. 그 스텝은 접촉을 끝내지 않는다.
  it('main.ts 스텝 순서로 D에서 가속 페달을 밟은 채 3초 동안 앞 연석을 밀어도 접촉 1회, 후진했다 다시 밀면 2회', () => {
    const { t, s, drive } = mainLoop([frontCurb()]);
    drive('D', 180);
    expect(t.events.curbTouches).toBe(1);
    expect(s.x).toBeGreaterThan(0.45); // 실제로 연석까지 갔다
    drive('R', 30); // 0.5초 후진 (약 1.1 m/s: 다시 D로 바꿀 수 있는 2 m/s 이하)
    drive('D', 180);
    expect(t.events.curbTouches).toBe(2);
  });

  it('같은 방향으로 0.3 m 넘게 움직이면 접촉이 끝난다 (연석을 따라 가다 다시 닿음)', () => {
    const t = new AttemptTracker();
    t.step(dt, 0.5, ok);
    t.step(dt, 0, hitCurb);
    for (let i = 0; i < 20; i++) t.step(dt, 0.5, ok); // 0.17 m
    expect(t.step(dt, 0, hitCurb).newCurbTouch).toBe(false);
    for (let i = 0; i < 40; i++) t.step(dt, 0.5, ok); // 0.33 m
    expect(t.step(dt, 0, hitCurb).newCurbTouch).toBe(true);
    expect(t.events.curbTouches).toBe(2);
  });

  it('main.ts 스텝 순서로 같은 방향으로 밟고, 떼서 서고, 다시 밟으면 전환 0회', () => {
    for (const gear of ['D', 'R'] as const) {
      const { t, s, drive } = mainLoop([]);
      const sign = gear === 'D' ? 1 : -1;
      drive(gear, 20); // 0.33초 밟기
      expect(s.speed * sign, gear).toBeGreaterThan(0.5);
      drive(gear, 90, 0); // 떼면 서고 그대로 선다
      expect(s.speed, gear).toBe(0);
      const x = s.x;
      drive(gear, 20); // 다시 같은 방향으로
      expect((s.x - x) * sign, gear).toBeGreaterThan(0.05);
      expect(t.events.dirChanges, gear).toBe(0);
    }
  });

  it('main.ts 스텝 순서로 같은 방향으로 연석을 여러 번 밀면(사이사이 페달을 떼고 정지) 매번 막혀도 접촉 1회', () => {
    const { t, s, drive } = mainLoop([frontCurb()]);
    expect(drive('D', 120)).toBeGreaterThan(0); // 연석까지 가서 막힘
    for (let k = 0; k < 3; k++) {
      drive('D', 60, 0); // 페달을 떼고 1초
      expect(s.speed).toBe(0);
      expect(drive('D', 30)).toBeGreaterThan(0); // 다시 밀면 또 막힌다
    }
    expect(t.events.curbTouches).toBe(1);
    expect(t.events.dirChanges).toBe(0);
    expect(s.x).toBeGreaterThan(0.45);
    expect(s.x).toBeLessThan(0.5); // 연석을 넘지 않았다
  });

  it('main.ts 스텝 순서로 기어를 넣고 페달 없이 서 있으면 시작 전(시간 0), 시간은 처음 움직일 때부터', () => {
    const { t, s, drive } = mainLoop([]);
    drive('D', 120, 0);
    drive('R', 120, 0);
    expect(t.started).toBe(false);
    expect(t.events).toEqual({ dirChanges: 0, elapsed: 0, curbTouches: 0, collisions: 0 });
    expect(s).toMatchObject({ x: 0, y: 0, heading: 0, speed: 0 });
    drive('R', 60);
    expect(t.started).toBe(true);
    expect(t.events.elapsed).toBeCloseTo(1.0, 9);
  });
});

describe('tests/helpers/drive.ts', () => {
  const wall = el({ kind: 'solid', tag: 'wall', poly: aabbRect(10, -5, 10.3, 5), hMin: 0, hMax: 2.7 });
  const front = SPEC.wheelbase + SPEC.frontOverhang;

  it('allSpecs = 모델 Y + 프리셋 7종', () => {
    const ids = allSpecs().map((s) => s.id);
    expect(ids[0]).toBe('model-y-2025');
    expect(ids.length).toBe(8);
  });

  it('startDrive는 막힌 자세에서 throw', () => {
    const ctx = motionCtx(SPEC, [wall]);
    expect(() => startDrive(ctx, { x: 7, y: 0, heading: 0 })).toThrow();
    expect(startDrive(ctx, O).path).toEqual([O]);
  });

  it('move는 막히기 전 스텝에서 멈추고 움직인 거리를 돌려준다', () => {
    const d = startDrive(motionCtx(SPEC, [wall]), O);
    const m = move(d, 20);
    expect(m).toBeGreaterThan(10 - front - DS - 1e-9);
    expect(m).toBeLessThanOrEqual(10 - front + 1e-9);
    expect(d.pose.x).toBeCloseTo(m, 9);
    expect(poseClear(d.ctx, d.pose, 0).kind).toBe('ok');
    expect(d.path.length).toBe(Math.round(m / DS) + 1);
    expect(move(d, 1)).toBe(0);
    expect(move(d, -0.5)).toBeCloseTo(-0.5, 9);
    expect(d.segments.map((s) => Math.sign(s.dist))).toEqual([1, -1]);
    expect(dirChanges(d)).toBe(1);
  });

  it('moveUntilBlocked는 clearance만큼 덜 가서 서고 방향 전환을 남기지 않는다', () => {
    const d = startDrive(motionCtx(SPEC, [wall]), O);
    const m = moveUntilBlocked(d, 1, 20);
    expect(10 - front - d.pose.x).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(10 - front - d.pose.x).toBeLessThan(0.1 + DS + 1e-9);
    expect(m).toBeCloseTo(d.pose.x, 9);
    expect(dirChanges(d)).toBe(0);
    expect(d.segments.every((s) => s.dist > 0)).toBe(true);
    // 막히지 않으면 물러나지 않는다
    const free = startDrive(motionCtx(SPEC, []), O);
    expect(moveUntilBlocked(free, -1, 1.5)).toBeCloseTo(-1.5, 9);
  });

  it('moveSteering은 거리당 비율로 조향을 바꾸며 서행하고, dirChanges는 조향 변화를 세지 않는다', () => {
    const d = startDrive(motionCtx(SPEC, []), O);
    expect(moveSteering(d, 1, 0.5)).toBeCloseTo(0.5, 9);
    expect(d.steer).toBeCloseTo(0.5, 9);
    moveSteering(d, 1, 1.0);
    expect(d.steer).toBe(1);
    moveSteering(d, -1, -0.3, 2);
    expect(d.steer).toBeCloseTo(0.4, 9);
    expect(dirChanges(d)).toBe(1);
  });

  it('연석 옆: 정지 상태 끝까지 조향은 거부되고, 움직이며 돌리면 조향이 커진다', () => {
    const d = startDrive(motionCtx(SPEC, [rightCurb(frOuterY(0) - 0.05)]), O);
    expect(setSteer(d, -1)).toBe(false);
    expect(d.steer).toBe(0);
    expect(setSteer(d, 1)).toBe(false);
    // 연석에서 멀어지는 쪽(왼쪽)으로 움직이며 돌리면 끝까지 돌아간다
    moveSteering(d, 1, 2.0);
    expect(d.steer).toBe(1);
    expect(d.path.every((p) => poseClear(d.ctx, p, 0).kind === 'ok')).toBe(true);
  });

  it('inRect는 rect.angle을 요구 방향으로 본다', () => {
    const rect = rectFromAabb(-3, -3, 8, 3, 0);
    expect(inRect(fp, O, rect, 20)).toBe(true);
    expect(inRect(fp, { ...O, heading: 0.5 }, rect, 20)).toBe(false);
    expect(inRect(fp, { ...O, heading: Math.PI }, rectFromAabb(-6, -3, 5, 3, 0), 20)).toBe(false);
  });
});
