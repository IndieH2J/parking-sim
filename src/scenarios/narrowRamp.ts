import type { Pose, Vec2 } from '../sim/geometry';
import { buildFootprint, wheelPolys } from '../sim/footprint';
import { rectFromAabb } from '../sim/goal';
import type { VehicleSpec } from '../sim/specs';
import { maxSteerAngle } from '../sim/vehicle';
import type { WorldElement } from '../sim/world';
import type { FloorPatch, RampOptions, Scenario } from './types';
import { boundsOf, elementAdder, WALL_T } from './common';

/**
 * 좁은 통로·곡선 램프. 경사는 생략한 평면 2D다 (결정 로그). 계약서 §1.8.4.
 *
 * 주차장법 시행규칙 제6조제1항제5호 (지하식·건축물식 노외주차장의 경사로, 계약서 §B):
 * - 가목: 높이 2.3 m 이상
 * - 나목: 곡선 부분 내변반경 6 m 이상 (주차대수 규모 50대 이하면 5 m)
 * - 다목: 차로 너비 직선 3.3 m·곡선 3.6 m 이상, 양쪽 벽면에서 30 cm 이상 떨어진 지점에 높이 10~15 cm 연석.
 *   연석 부분은 차로 너비에 포함된다.
 * 그래서 차로 너비와 내변반경은 벽면 기준이고, 연석(폭 0.3 m)은 벽면에 붙여 차로 안쪽에 둔다.
 * 바퀴는 연석면 사이(직선 2.7 m, 곡선 3.0 m)로, 차체·미러는 벽면 사이로 지나가야 한다.
 *
 * 경로 (월드 좌표, 원점 = S1 시작 벽면 가운데):
 * - S1: 동쪽(heading 0) 직선, x 0 → 12, 차로 중심 y = 0. 안쪽(왼쪽) 벽면 y = Ws/2
 * - C1: 왼쪽 180°, 중심 (12, Ws/2 + Ri). 안쪽 벽면 반경 Ri, 바깥 벽면 반경 Ri + Wc
 * - S2: 서쪽(heading π) 직선, x 12 → 4. 남쪽 벽면 y = Ws/2 + 2Ri, 북쪽 벽면 yN = Ws/2 + 2Ri + Ws
 * - C2: 오른쪽 90°, 중심 (4, yN + Ri). 안쪽(북쪽) 벽면 반경 Ri
 * - S3: 북쪽(heading π/2) 직선, 길이 max(10, zoneLen + 5). 동쪽 벽면 x = 4 − Ri. 끝 zoneLen m가 출구 구역
 * 곡선 폭 Wc와 직선 폭 Ws의 차이는 곡선 바깥쪽에서만, 곡선에 붙은 직선 1.5 m에 걸쳐 바뀐다 (테이퍼).
 * 스웹트 패스가 1.5 m 테이퍼를 넘는 차(직접 입력 대형차)만 곡선 출구 바깥 벽을 곡선 폭으로 더 유지한 뒤 테이퍼한다
 * (exitHold, 결정 로그). 모델 Y와 프리셋은 해당 없음.
 *
 * 만드는 방법: 경로를 따라 단면(section)을 차례로 놓는다. 단면마다 진행 방향 왼쪽·오른쪽 벽면 위 점과
 * 그 점에서 벽 쪽을 향한 단위 법선을 둔다. 이웃한 두 단면이 조각 하나가 되고, 조각마다 양쪽 벽·연석과 바닥을 만든다.
 * 이웃 조각은 같은 단면 객체를 쓰므로 이음매 꼭짓점이 정확히 같다 (틈 없음).
 * 곡선은 5° 단면마다 원 위에 꼭짓점을 둔 볼록 사다리꼴이라, 현의 가운데는 원보다 최대 (Ri + Wc)(1 − cos 2.5°) ≈ 9 mm 안쪽이다.
 */

/** 연석 폭 (벽면 → 연석면) */
const CURB_W = 0.3;
/** 연석 높이 (법정 0.10~0.15 m) */
const CURB_H = 0.12;
/** 램프 천장 높이 (법정 최소 2.3 m). 차고의 CEILING 2.7 m와 다르다 */
const CEILING = 2.3;
/** 곡선 조각 하나의 최대 각 */
const ARC_STEP = (5 * Math.PI) / 180;
/** 곡선 폭으로 바뀌는 직선 구간 길이 */
const TAPER = 1.5;
/** rampLaneWidths 여유 m: 바퀴·차체 바깥으로 m/2씩 */
const MARGIN = 0.25;
const CURB_COLOR = 0xd8b020;
/** 천장 조명 간격 (차로 중심선 위) */
const LAMP_STEP = 4;
const S1_END = 12;
const S2_END = 4;
/** S2 길이 (x 12 → 4) */
const S2_LEN = S1_END - S2_END;
/** 법정 최소 차로 너비 (벽면~벽면) */
const LEGAL_STRAIGHT = 3.3;
const LEGAL_CURVE = 3.6;

/** 정상 선회 스웹트 패스 (계약서 §1.8.4 식). 차 로컬 좌표에서 선회 중심은 (0, rr) */
export function rampSweep(spec: VehicleSpec, innerRadius: number): { rr: number; wheelOuter: number; bodyOuter: number } {
  const track = Math.max(spec.trackFront, spec.trackRear);
  // 안쪽 뒷바퀴 안쪽 면이 안쪽 연석면에서 m/2 떨어지는 뒤축 반경. 최소 회전 반경보다 작으면 그쪽을 쓴다.
  const rr = Math.max(
    innerRadius + CURB_W + track / 2 + spec.tireWidth / 2 + MARGIN / 2,
    spec.wheelbase / Math.tan(maxSteerAngle(spec)) + 0.05,
  );
  const delta = Math.atan(spec.wheelbase / rr);
  const radius = (p: Vec2) => Math.hypot(p.x, rr - p.y);
  const maxRadius = (polys: Vec2[][]) => Math.max(...polys.flat().map(radius));
  const fp = buildFootprint(spec);
  return {
    rr,
    wheelOuter: maxRadius(Object.values(wheelPolys(spec, delta))),
    bodyOuter: maxRadius([fp.body.poly, fp.mirrorLeft.poly, fp.mirrorRight.poly]),
  };
}

/** 바깥 벽면이 있어야 할 곡선 중심 반경: 정상 선회에서 바깥 바퀴 + 연석 폭, 차체·미러 바깥 중 큰 쪽 + 여유 m/2 */
function outerNeed(spec: VehicleSpec, innerRadius: number): number {
  const s = rampSweep(spec, innerRadius);
  return Math.max(s.wheelOuter + CURB_W, s.bodyOuter) + MARGIN / 2;
}

/** 벽면~벽면 차로 너비. 법정 최소(직선 3.3, 곡선 3.6)이고, 차의 스웹트 패스가 넘칠 때만 넓힌다. */
export function rampLaneWidths(spec: VehicleSpec, innerRadius: number): { straight: number; curve: number } {
  const track = Math.max(spec.trackFront, spec.trackRear);
  return {
    straight: Math.max(LEGAL_STRAIGHT, track + spec.tireWidth + 2 * CURB_W + MARGIN, spec.widthMirrors + MARGIN),
    // = max(3.6, wheelOuter + c + m/2 − Ri, bodyOuter + m/2 − Ri)
    curve: Math.max(LEGAL_CURVE, outerNeed(spec, innerRadius) - innerRadius),
  };
}

/**
 * 곡선 출구에서 바깥 벽을 곡선 폭으로 더 유지하는 거리 (그 뒤 1.5 m 테이퍼).
 * 차가 정상 선회하는 동안 바깥 앞 모서리·바퀴는 곡선 끝을 지나서도 반경 need(여유 포함)의 원을 그린다.
 * 그 원이 1.5 m 테이퍼 끝(직선 바깥 벽선, 중심에서 Ri + Ws)보다 안쪽이면, 곧 need ≤ √((Ri + Ws)² + 1.5²)이면 0이다.
 * 모델 Y와 프리셋 7종은 모두 0이라 계약서 기하 그대로다 (모델 Y 반경 5 m: need 8.305 ≤ 8.434).
 * 넘는 차(직접 입력 대형차, 곡선을 넓힌 차는 모두)는 원이 직선 벽선과 만나는 거리 √(need² − (Ri + Ws)²)만큼 유지한다.
 * S2(8 m)에서 C2 쪽 테이퍼와 겹치지 않게 4.5 m로 자른다 (CUSTOM_LIMITS 안에서는 약 3.9 m가 최대).
 */
function exitHold(need: number, Ri: number, Ws: number): number {
  const line = Ri + Ws;
  if (need <= Math.hypot(line, TAPER)) return 0;
  return Math.min(Math.sqrt(need * need - line * line), S2_LEN - 2 * TAPER - 0.5);
}

/** 벽면 위 점 p와 차로 → 벽 방향 단위 법선 n */
interface Station {
  p: Vec2;
  n: Vec2;
}
/** 진행 방향 기준 왼쪽·오른쪽 벽면 */
interface Section {
  l: Station;
  r: Station;
}

/** 방향 a의 단위 벡터. 축 방향(90°의 배수)에서는 0을 정확히 0으로 둔다 (직선 벽이 축과 정확히 나란하게). */
function unit(a: number): Vec2 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: Math.abs(c) < 1e-12 ? 0 : c, y: Math.abs(s) < 1e-12 ? 0 : s };
}

const add = (p: Vec2, v: Vec2, k: number): Vec2 => ({ x: p.x + v.x * k, y: p.y + v.y * k });

/** 반시계 방향으로 맞춘다 (rect·aabbRect와 같은 방향) */
function ccw(poly: Vec2[]): Vec2[] {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area >= 0 ? poly : [...poly].reverse();
}

const st = (x: number, y: number, n: Vec2): Station => ({ p: { x, y }, n });
const NORTH: Vec2 = { x: 0, y: 1 };
const SOUTH: Vec2 = { x: 0, y: -1 };
const EAST: Vec2 = { x: 1, y: 0 };
const WEST: Vec2 = { x: -1, y: 0 };

/**
 * 곡선 단면들 (a0 단면 제외, a1 단면 포함). 왼쪽 회전이면 왼쪽이 안쪽 벽(반경 ri)이다.
 * 법선: 안쪽 벽은 중심 쪽(−u), 바깥 벽은 바깥쪽(+u).
 */
function arcSections(c: Vec2, ri: number, ro: number, a0: number, a1: number, leftTurn: boolean): Section[] {
  const n = Math.ceil(Math.abs(a1 - a0) / ARC_STEP - 1e-9);
  const out: Section[] = [];
  for (let k = 1; k <= n; k++) {
    const u = unit(a0 + ((a1 - a0) * k) / n);
    const inner: Station = { p: add(c, u, ri), n: { x: -u.x, y: -u.y } };
    const outer: Station = { p: add(c, u, ro), n: u };
    out.push(leftTurn ? { l: inner, r: outer } : { l: outer, r: inner });
  }
  return out;
}

export function buildNarrowRamp(opt: RampOptions, spec: VehicleSpec): Scenario {
  const Ri = opt.innerRadius;
  const { straight: Ws, curve: Wc } = rampLaneWidths(spec, Ri);
  const c1: Vec2 = { x: S1_END, y: Ws / 2 + Ri };
  const yS = Ws / 2 + 2 * Ri; // S2 남쪽(안쪽 C1) 벽면
  const yN = yS + Ws; // S2 북쪽(안쪽 C2) 벽면
  const c2: Vec2 = { x: S2_END, y: yN + Ri };
  const xE = S2_END - Ri; // S3 동쪽(안쪽 C2) 벽면
  const xW = xE - Ws; // S3 서쪽 벽면
  const hold = exitHold(outerNeed(spec, Ri), Ri, Ws);
  const zoneLen = Math.max(5, spec.length + 1); // 출구 구역 길이: 차 길이 + 1 m (최소 5 m)
  // S3 끝: 길이 max(10, zoneLen + 5). 출구 폭 유지가 있으면 구역이 테이퍼에 걸리지 않게 늘인다 (법정 폭이면 그대로)
  const yEnd = c2.y + Math.max(10, zoneLen + 5, hold + TAPER + zoneLen);

  // 단면: S1 → C1 → S2 → C2 → S3. 테이퍼 조각은 곡선 바깥쪽 벽면만 비스듬하다.
  const sections: Section[] = [
    { l: st(0, Ws / 2, NORTH), r: st(0, -Ws / 2, SOUTH) },
    { l: st(S1_END - TAPER, Ws / 2, NORTH), r: st(S1_END - TAPER, -Ws / 2, SOUTH) },
  ];
  // C1 첫 단면(−π/2)이 S1 끝: 오른쪽 벽면이 −Ws/2에서 Ws/2 − Wc로 테이퍼
  sections.push({ l: { p: add(c1, SOUTH, Ri), n: NORTH }, r: { p: add(c1, SOUTH, Ri + Wc), n: SOUTH } });
  sections.push(...arcSections(c1, Ri, Ri + Wc, -Math.PI / 2, Math.PI / 2, true));
  // S2: 북쪽(바깥 C1) 벽면이 C1 끝에서 (hold 뒤) 1.5 m에 걸쳐 yN으로, 남쪽(바깥 C2) 벽면이 C2 앞 1.5 m에 걸쳐 yN − Wc로
  if (hold > 0) sections.push({ l: st(S1_END - hold, yS, SOUTH), r: st(S1_END - hold, yS + Wc, NORTH) });
  sections.push(
    { l: st(S1_END - hold - TAPER, yS, SOUTH), r: st(S1_END - hold - TAPER, yN, NORTH) },
    { l: st(S2_END + TAPER, yS, SOUTH), r: st(S2_END + TAPER, yN, NORTH) },
    { l: { p: add(c2, SOUTH, Ri + Wc), n: SOUTH }, r: { p: add(c2, SOUTH, Ri), n: NORTH } },
  );
  sections.push(...arcSections(c2, Ri, Ri + Wc, -Math.PI / 2, -Math.PI, false));
  // S3: 서쪽(바깥 C2) 벽면이 처음 (hold 뒤) 1.5 m에 걸쳐 xW로
  if (hold > 0) sections.push({ l: st(xE - Wc, c2.y + hold, WEST), r: st(xE, c2.y + hold, EAST) });
  sections.push(
    { l: st(xW, c2.y + hold + TAPER, WEST), r: st(xE, c2.y + hold + TAPER, EAST) },
    { l: st(xW, yEnd, WEST), r: st(xE, yEnd, EAST) },
  );

  const elements: WorldElement[] = [];
  const addEl = elementAdder(elements);
  const floor: FloorPatch[] = [];
  for (let i = 0; i + 1 < sections.length; i++) {
    const a = sections[i];
    const b = sections[i + 1];
    for (const side of ['l', 'r'] as const) {
      const sa = a[side];
      const sb = b[side];
      addEl({
        kind: 'solid',
        tag: 'wall',
        poly: ccw([sa.p, sb.p, add(sb.p, sb.n, WALL_T), add(sa.p, sa.n, WALL_T)]),
        hMin: 0,
        hMax: CEILING,
      });
      addEl({
        kind: 'curb',
        poly: ccw([add(sa.p, sa.n, -CURB_W), add(sb.p, sb.n, -CURB_W), sb.p, sa.p]),
        hMin: 0,
        hMax: CURB_H,
        dir: Math.atan2(sb.p.y - sa.p.y, sb.p.x - sa.p.x),
        meta: { color: CURB_COLOR },
      });
    }
    floor.push({ poly: ccw([a.l.p, a.r.p, b.r.p, b.l.p]), tone: 'aisle' });
  }
  // 양 끝 벽: 처음 단면 뒤쪽, 마지막 단면 앞쪽을 벽 바깥면까지 막는다
  const endWall = (s: Section, out: Vec2) => {
    const l = add(s.l.p, s.l.n, WALL_T);
    const r = add(s.r.p, s.r.n, WALL_T);
    addEl({ kind: 'solid', tag: 'wall', poly: ccw([l, r, add(r, out, WALL_T), add(l, out, WALL_T)]), hMin: 0, hMax: CEILING });
  };
  endWall(sections[0], WEST);
  endWall(sections[sections.length - 1], NORTH);

  return {
    kind: 'ramp',
    elements,
    start: { x: 2, y: 0, heading: 0 },
    // 출구 구역: S3 마지막 zoneLen m, 벽면~벽면. 요구 방향 북쪽(+π/2), 30°
    goal: { kind: 'zone', rect: rectFromAabb(xW, yEnd - zoneLen, xE, yEnd, Math.PI / 2), maxAngleDeg: 30 },
    bounds: boundsOf(elements, 1.0),
    ceilingHeight: CEILING,
    floor,
    lamps: lampsAlong(sections.map((s) => ({ x: (s.l.p.x + s.r.p.x) / 2, y: (s.l.p.y + s.r.p.y) / 2 }))),
  };
}

/** 차로 중심선(단면 가운데를 이은 꺾은선)을 따라 LAMP_STEP마다. 처음은 LAMP_STEP/2, 끝에서 1 m 안쪽까지 */
function lampsAlong(mids: Vec2[]): Pose[] {
  const segs = mids.slice(1).map((b, i) => ({ a: mids[i], b, len: Math.hypot(b.x - mids[i].x, b.y - mids[i].y) }));
  const total = segs.reduce((s, g) => s + g.len, 0);
  const lamps: Pose[] = [];
  let at = LAMP_STEP / 2;
  let acc = 0;
  for (const { a, b, len } of segs) {
    while (at <= acc + len && at <= total - 1) {
      const t = (at - acc) / len;
      lamps.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), heading: Math.atan2(b.y - a.y, b.x - a.x) });
      at += LAMP_STEP;
    }
    acc += len;
  }
  return lamps;
}
