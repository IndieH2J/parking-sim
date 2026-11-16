import { clearance } from '../../src/sim/clearance';
import type { Pose, Vec2 } from '../../src/sim/geometry';
import { evaluateGoal, type Goal, type GoalKind } from '../../src/sim/goal';
import { poseClear, type MoveResult } from '../../src/sim/motion';
import { integratePose } from '../../src/sim/vehicle';
import { DS, move, setSteer, type Drive } from './drive';
import { legTime } from './timing';

// 단계 3 해결 가능성 증명의 공용 도구 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C0). 코어 소유, 다른 에이전트는 읽기만 한다.
// - pursue: 순수 추종(pure pursuit) 운전. tests/narrowRamp.test.ts driveRamp를 일반화했고 drive.ts의 setSteer와 move(DS)만 쓴다.
// - minGapAlong: 지나간 자세에서 clearance()의 최솟값 (골목·유턴의 gap).
// - driveLog·proofTime: 방향 전환 수, 구간 길이, 속도 상한으로 걸리는 최소 시간 (시간 기준 가드 tGood ≥ 1.5 × T).
// 기록은 Drive.segments에서 만들므로 drive.ts 동작(move·moveUntilBlocked·moveSteering)과 pursue를 어떻게 섞어도 된다.
// src/scenarios/index.ts는 import하지 않는다 (계약서 §A.5).

/** 앞보기 거리 기본값 (m), driveRamp와 같음 */
export const LOOK_AHEAD = 2.5;
/** 경로를 다시 나누는 간격 (m) */
const H = 0.05;
/** 가장 가까운 경로 점을 찾는 범위: 지난번 점부터 앞으로만 (m) */
const SEARCH = 10;

export interface PursuitOpts {
  /** 1 = 전진 (기본), −1 = 후진. 경로는 어느 쪽이든 지나갈 순서대로 준다 */
  dir?: 1 | -1;
  /** 매 스텝 전에 evaluateGoal(goal)이 성공하면 멈춘다 (zone 목표). 없으면 경로 끝까지 간다 */
  goal?: Goal;
  /** 앞보기 거리 (m), 기본 LOOK_AHEAD */
  lookAhead?: number;
  /** 이번 추종으로 움직일 거리 상한 (m), 기본 경로 길이 × 1.5 + 10 */
  maxDist?: number;
}

export interface PursuitResult {
  /**
   * goal = 목표 성공 (그 자세에서 멈춤), end = 경로 끝을 지남, limit = maxDist에 이름,
   * blocked = 다음 DS 스텝이 poseClear를 통과하지 못함 (차체·미러 충돌 또는 바퀴가 연석·휠스톱에 걸림, 그 앞에서 멈춤)
   */
  end: 'goal' | 'end' | 'blocked' | 'limit';
  /** 이번 추종으로 움직인 거리 (m, 부호 없음) */
  dist: number;
  /** blocked일 때만: 멈춘 자세, 조향, 막은 것 (예: 'mirrorLeft hits pole e7', 'wheel FL on curb e3') */
  error?: string;
}

const describeHit = (r: MoveResult) =>
  r.kind === 'wheel'
    ? `wheel ${r.wheel} on ${r.element.kind} ${r.element.id}`
    : r.kind === 'collision'
      ? `${r.hit.part} hits ${r.hit.element.tag} ${r.hit.element.id}`
      : 'ok';

const fmtPose = (p: Pose) => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${((p.heading * 180) / Math.PI).toFixed(1)}°)`;

/** 꺾은선을 H 간격 점으로 다시 나눈다 (첫 점과 끝점 포함, 길이 0인 구간은 건너뜀) */
function resample(path: Vec2[]): Vec2[] {
  const out: Vec2[] = [{ x: path[0].x, y: path[0].y }];
  let carry = 0; // 마지막으로 넣은 점에서 지금 구간 시작까지 거리
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    let t = H - carry;
    for (; t <= len; t += H) out.push({ x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len });
    carry = len - (t - H);
  }
  const last = path[path.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > 1e-9) out.push({ x: last.x, y: last.y });
  return out;
}

/**
 * 순수 추종 운전: 뒤축 중심에서 앞보기 거리만큼 떨어진 경로 점을 지나는 원호의 곡률로 조향하며 dir 방향으로 DS씩 간다.
 * 스텝마다 setSteer(새 조향, 거부되면 이전 조향 유지) 후 move(dir·DS). 후진도 같은 식이다 (자전거 모델의 뒤축 곡률 = tan(조향각)/축거).
 * - path: 뒤축 중심이 지나갈 꺾은선 (월드 좌표, 지나갈 순서). path[0]은 지금 뒤축 근처에 둔다 (가장 가까운 점은 앞쪽 10 m 안에서만 찾는다).
 *   곡률이 매끄러워야 잘 따라간다 (모서리는 원호로). 점 간격은 자유 (0.05 m로 다시 나눈다).
 * - 경로 끝: 남은 경로가 앞보기 거리보다 짧아지면 앞보기 점은 마지막 구간 방향의 연장선 위로 간다 (끝에서 그 방향으로 곧게 선다).
 *   뒤축이 끝점을 지나면(마지막 구간 방향으로 투영해 0 이상) 'end'로 멈춘다. 끝에서 방향까지 맞추려면 경로를 앞보기 거리 이상 직선으로 끝낸다.
 * - 이미 움직인 Drive를 이어서 써도 된다 (탈출 스크립트 뒤에 추종 등).
 */
export function pursue(d: Drive, path: Vec2[], opts: PursuitOpts = {}): PursuitResult {
  if (path.length < 2) throw new Error('pursue: path needs at least 2 points');
  const dir = opts.dir ?? 1;
  const look = opts.lookAhead ?? LOOK_AHEAD;
  const ref = resample(path);
  const n = ref.length;
  const end = ref[n - 1];
  // 마지막 구간 방향 (길이 0이 아닌 마지막 원래 구간)
  let k = path.length - 1;
  while (k > 0 && path[k].x === path[k - 1].x && path[k].y === path[k - 1].y) k--;
  if (k === 0) throw new Error('pursue: path has zero length');
  const segLen = Math.hypot(path[k].x - path[k - 1].x, path[k].y - path[k - 1].y);
  const u = { x: (path[k].x - path[k - 1].x) / segLen, y: (path[k].y - path[k - 1].y) / segLen };
  const maxDist = opts.maxDist ?? (n - 1) * H * 1.5 + 10;
  const window = Math.round(SEARCH / H);
  const spec = d.ctx.spec;
  let i0 = 0;
  let moved = 0;
  for (;;) {
    if (opts.goal && evaluateGoal(opts.goal, d.ctx.fp, d.pose).success) return { end: 'goal', dist: moved };
    const p = d.pose;
    // 가장 가까운 경로 점 (앞으로만 찾는다)
    let iBest = i0;
    let best = Infinity;
    for (let i = i0; i < Math.min(n, i0 + window); i++) {
      const dd = (ref[i].x - p.x) ** 2 + (ref[i].y - p.y) ** 2;
      if (dd < best) {
        best = dd;
        iBest = i;
      }
    }
    i0 = iBest;
    if ((n - 1 - i0) * H < look && (p.x - end.x) * u.x + (p.y - end.y) * u.y >= 0) return { end: 'end', dist: moved };
    if (moved >= maxDist - 1e-9) return { end: 'limit', dist: moved };
    // 앞보기 점: 앞보기 거리 이상 떨어진 첫 경로 점, 남은 경로가 모두 그 안이면 끝점에서 u 방향 연장선 위
    let j = i0;
    while (j < n - 1 && Math.hypot(ref[j].x - p.x, ref[j].y - p.y) < look) j++;
    let tx = ref[j].x;
    let ty = ref[j].y;
    if (Math.hypot(tx - p.x, ty - p.y) < look) {
      const qx = end.x - p.x;
      const qy = end.y - p.y;
      const b = qx * u.x + qy * u.y;
      const t = -b + Math.sqrt(b * b - (qx * qx + qy * qy) + look * look);
      tx = end.x + t * u.x;
      ty = end.y + t * u.y;
    }
    const c = Math.cos(p.heading);
    const s = Math.sin(p.heading);
    const dx = tx - p.x;
    const dy = ty - p.y;
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    const kappa = (2 * ly) / (lx * lx + ly * ly);
    const steer = Math.max(-1, Math.min(1, Math.atan(spec.wheelbase * kappa) / d.ctx.maxSteer));
    if (steer !== d.steer) setSteer(d, steer); // 거부되면 이전 조향 유지
    if (move(d, dir * DS) === 0) {
      const next = integratePose(p, spec, d.steer, dir * DS, 1);
      return {
        end: 'blocked',
        dist: moved,
        error: `blocked at ${fmtPose(p)} steer ${d.steer.toFixed(3)}: ${describeHit(poseClear(d.ctx, next, d.steer))}`,
      };
    }
    moved += DS;
  }
}

/** d.path의 모든 자세(시작 자세 포함)에서 clearance()의 최솟값 (m, 최대 cap). 차체·미러에서 높이가 겹치는 solid까지 */
export function minGapAlong(d: Drive, cap = 1): number {
  let g = cap;
  // 지금까지의 최솟값을 cap으로 넘기면 같은 결과를 더 빨리 얻는다 (멀리 있는 요소를 near()가 거른다)
  for (const p of d.path) g = Math.min(g, clearance(d.ctx.fp, p, d.ctx.elements, g));
  return g;
}

export interface DriveLog {
  /**
   * 방향 전환으로 나눈 구간의 길이 (m, 부호 있음: + 전진, − 후진), 순서대로.
   * 같은 방향으로 이어지는 이동은 사이에 제자리 조향이 있어도 한 구간이다.
   */
  legs: number[];
  /** 방향 전환 수 = legs.length − 1 (drive.ts dirChanges와 같은 값) */
  dirChanges: number;
}

/** Drive.segments에서 만든 기록: drive.ts 동작과 pursue를 어떻게 섞었든 실제로 움직인 순서대로 센다 */
export function driveLog(d: Drive): DriveLog {
  const legs: number[] = [];
  for (const s of d.segments) {
    if (s.dist === 0) continue;
    const last = legs.length - 1;
    if (last >= 0 && Math.sign(legs[last]) === Math.sign(s.dist)) legs[last] += s.dist;
    else legs.push(s.dist);
  }
  return { legs, dirChanges: Math.max(0, legs.length - 1) };
}

/**
 * 증명 주행을 속도 상한으로 따라 하는 데 걸리는 최소 시간 T (초) = Σ legTime(|구간 길이|, 끝에서 움직임).
 * 구간마다 정지에서 출발하고, 마지막 구간을 빼면 모두 정지로 끝난다 (방향을 바꾸려면 선다).
 * 마지막 구간: zone 목표는 움직이는 채로 성공하므로 움직이며 끝나고, slot 목표(발권기)는 P로 끝나므로 정지로 끝난다.
 * 시간 기준 가드: expect(SCORE_PAR[kind].tGood).toBeGreaterThanOrEqual(1.5 * proofTime(driveLog(d), sc.goal.kind)).
 */
export function proofTime(log: DriveLog, goalKind: GoalKind): number {
  return log.legs.reduce((t, L, i) => t + legTime(Math.abs(L), goalKind === 'zone' && i === log.legs.length - 1), 0);
}
