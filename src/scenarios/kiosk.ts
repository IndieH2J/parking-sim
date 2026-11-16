import type { Pose } from '../sim/geometry';
import { aabbRect } from '../sim/geometry';
import { rectFromAabb } from '../sim/goal';
import { KIOSK_ALONG_MAX, KIOSK_ANGLE_MAX, KIOSK_REACH_MAX } from '../sim/kioskJudge';
import type { VehicleSpec } from '../sim/specs';
import { maxSteerAngle } from '../sim/vehicle';
import type { WorldElement } from '../sim/world';
import type { Scenario } from './types';
import { boundsOf, elementAdder, WALL_T } from './common';

/**
 * 발권기 앞 정차 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C4). 옵션 없음, 크기는 차에 맞춘다.
 * 판정은 src/sim/kioskJudge.ts (운전석 창문 기준). 지붕 있는 입구라 실내다.
 *
 * 월드 좌표: 차로는 +x(동쪽). 섬 연석면 y = 0, 차로 오른쪽 벽면 y = −W_l (W_l = 미러 포함 폭 + 1.8).
 * - 섬: 연석(높이 0.15) [Xk − 3, Xb + 1.5] × [0, 1.2], 그 뒤 y 1.2–1.5에 벽. 출구 차로는 없다 (설계 H13).
 * - 발권기: [Xk ± 0.25] × [0.10, 0.55], 높이 1.55. 차로 쪽 앞면 faceY = 0.10.
 * - 차단기: Xb = Xk + 앞범퍼→눈 + 1.2 (창문을 맞춘 차의 앞범퍼 1.2 m 앞).
 *   함 [Xb ± 0.2] × [0.3, 0.7] 높이 1.1, 막대 [Xb ± 0.04] × [−W_l + 0.1, 0.3] 높이 0.85–0.95 (0.5 m마다 빨강·흰색).
 * - 출발: 차로 가운데(y = −W_l/2), 동쪽. 뒤 끝 벽면 x = 0은 출발 뒤범퍼 1.5 m 뒤, 앞 끝 벽면은 Xb + 3.
 * - 출발 뒤축에서 LEAD 곧게, 반경 1.5R의 S자로 G의 선까지 Δy 옆으로(길이 2√(1.5·R·Δy)), 그 뒤 RUN 곧게 가면 G
 *   (G = kioskTargetPose: 눈이 발권기 중심, reach = max(mo, 0.10 − e) + 0.06).
 *   설계 C4의 출발 식 (Xk − 3) − 축거 − 2√(1.5·R·Δy) − 2.0은 S자 끝에서 G까지 3 + 눈→앞축(약 4.4 m)만 남긴다.
 *   그 직선이 짧으면 S자 뒤 흔들림이 가라앉기 전에 앞바퀴가 섬 앞끝을 지나 연석에 걸린다 (증명 추종, 11대:
 *   6.5 m 막힘, 7 m 타이어–연석 최소 0.6 cm, 8 m 2.9 cm·끝 reach 오차 0.51 cm 이하). 그래서 출발을 뒤로 빼 RUN = 8 m로 둔다.
 *   S자는 여전히 섬 앞끝보다 앞에서 끝난다.
 */

/** 차로 너비 W_l = 미러 포함 폭 + 이 값 (설계 C4 '보통', 구성은 하나) */
const LANE_EXTRA = 1.8;
/** 발권기 차로 쪽 앞면 y (섬 연석면 y = 0에서 0.10 m 안쪽) */
const FACE_Y = 0.1;
/** 발권기: 앞뒤 반폭 0.25, 깊이 0.45, 높이 1.55 */
const KIOSK_HALF = 0.25;
const KIOSK_DEPTH = 0.45;
const KIOSK_H = 1.55;
/** 섬: 깊이 1.2 m (그 뒤 벽), 발권기 3 m 앞에서 시작해 차단기 1.5 m 뒤에서 끝남 */
const ISLAND_D = 1.2;
const ISLAND_NOSE = 3;
const ISLAND_TAIL = 1.5;
const CURB_H = 0.15;
/** 노랑 (램프 연석과 같은 색) */
const CURB_COLOR = 0xd8b020;
/** 창문을 맞춘 차의 앞범퍼 → 차단기 막대 중심 */
const BARRIER_GAP = 1.2;
/** 차단기 함: 앞뒤 반폭 0.2, y 0.3–0.7, 높이 1.1 */
const HOUSING_HALF = 0.2;
const HOUSING_Y0 = 0.3;
const HOUSING_Y1 = 0.7;
const HOUSING_H = 1.1;
/** 차단기 막대: 두께 0.08, 높이 0.85–0.95, 오른쪽 벽면 0.1 m 앞까지, 0.5 m 칸 */
const ARM_HALF = 0.04;
const ARM_H0 = 0.85;
const ARM_H1 = 0.95;
const ARM_WALL_GAP = 0.1;
const ARM_SEG = 0.5;
const ARM_COLORS = [0xd0342c, 0xf2f2f2];
const KIOSK_COLOR = 0x2f6db5;
const HOUSING_COLOR = 0x6b7178;
/** 출발 뒤범퍼 → 뒤 끝 벽면, 차단기 막대 중심 → 앞 끝 벽면 */
const START_BACK = 1.5;
const FAR_GAP = 3;
/** G의 reach = (미러·타이어가 닿지 않는 하한) + 이 여유 (설계 C4) */
const REACH_MARGIN = 0.06;
/** 출발 → S자 시작 직선 (설계 C4) */
const LEAD = 2.0;
/** S자 원호 반경 = 이 값 × 뒤축 최소 회전 반경 R (설계 C4) */
const BEND = 1.5;
/** S자 끝 → G 직선 (위 설명) */
const RUN = 8.0;
/** 지붕 높이, 조명 간격 (차로 가운데 위) */
const CEILING = 3.0;
const LAMP_STEP = 3;

/** 뒤축 → 눈의 차량 x (kioskJudge의 xe) */
const eyeX = (spec: VehicleSpec) => spec.wheelbase + spec.frontOverhang - spec.eye.fromFront;

/**
 * G의 reach (창문 쪽 차체 → 발권기 앞면, m) = max(mo, 0.10 − e) + 0.06.
 * mo = 미러가 차체 옆면 밖으로 나온 길이 (reach > mo여야 미러가 발권기를 지난다),
 * e = 차체 옆면 → 타이어 바깥면 (음수 = 타이어가 밖, reach > 0.10 − e여야 왼쪽 타이어가 섬 연석에 닿지 않는다).
 */
function targetReach(spec: VehicleSpec): number {
  const mo = (spec.widthMirrors - spec.width) / 2;
  const e = spec.width / 2 - (Math.max(spec.trackFront, spec.trackRear) + spec.tireWidth) / 2;
  return Math.max(mo, FACE_Y - e) + REACH_MARGIN;
}

/**
 * 증명용 목표 자세 G (뒤축 중심): 눈이 발권기 중심 x에 오고(along 0), 창문 쪽 차체가 앞면에서 targetReach, 차로 방향(heading 0).
 * 테스트와 브라우저 확인(__sim.goalPose)이 쓴다.
 */
export function kioskTargetPose(spec: VehicleSpec, sc: Scenario): Pose {
  const k = sc.kiosk;
  if (!k) throw new Error(`kioskTargetPose: ${sc.kind} has no kiosk`);
  return { x: k.x - eyeX(spec), y: k.faceY - targetReach(spec) - spec.width / 2, heading: 0 };
}

export function buildKiosk(spec: VehicleSpec): Scenario {
  const wl = spec.widthMirrors + LANE_EXTRA;
  const R = spec.wheelbase / Math.tan(maxSteerAngle(spec)); // 뒤축 최소 회전 반경
  const start: Pose = { x: START_BACK + spec.rearOverhang, y: -wl / 2, heading: 0 };
  const dy = FACE_Y - targetReach(spec) - spec.width / 2 - start.y; // 출발 → G 옆으로 (+ = 왼쪽)
  const xk = start.x + LEAD + 2 * Math.sqrt(BEND * R * dy) + RUN + eyeX(spec); // 발권기 중심 x (G의 눈)
  const xb = xk + spec.eye.fromFront + BARRIER_GAP;
  const xEnd = xb + FAR_GAP; // 앞 끝 벽면

  const els: WorldElement[] = [];
  const add = elementAdder(els);
  const wall = (x0: number, y0: number, x1: number, y1: number) =>
    add({ kind: 'solid', tag: 'wall', poly: aabbRect(x0, y0, x1, y1), hMin: 0, hMax: CEILING });
  wall(-WALL_T, -wl - WALL_T, xEnd + WALL_T, -wl); // 차로 오른쪽
  wall(-WALL_T, ISLAND_D, xEnd + WALL_T, ISLAND_D + WALL_T); // 섬 뒤
  wall(-WALL_T, -wl, 0, ISLAND_D); // 뒤 끝 (출발 뒤)
  wall(xEnd, -wl, xEnd + WALL_T, ISLAND_D); // 앞 끝 (차단기 너머)

  // 섬: 연석이라 바퀴만 막는다 (계약서 §1.7). dir 0 → 센서가 왼쪽 거리(하늘색)로 잰다
  add({
    kind: 'curb',
    poly: aabbRect(xk - ISLAND_NOSE, 0, xb + ISLAND_TAIL, ISLAND_D),
    hMin: 0,
    hMax: CURB_H,
    dir: 0,
    meta: { color: CURB_COLOR },
  });
  add({
    kind: 'solid',
    tag: 'kiosk',
    poly: aabbRect(xk - KIOSK_HALF, FACE_Y, xk + KIOSK_HALF, FACE_Y + KIOSK_DEPTH),
    hMin: 0,
    hMax: KIOSK_H,
    meta: { color: KIOSK_COLOR },
  });
  add({
    kind: 'solid',
    tag: 'barrier',
    poly: aabbRect(xb - HOUSING_HALF, HOUSING_Y0, xb + HOUSING_HALF, HOUSING_Y1),
    hMin: 0,
    hMax: HOUSING_H,
    meta: { color: HOUSING_COLOR },
  });
  // 막대: 함 앞면에서 오른쪽으로 0.5 m 칸, 마지막 칸만 짧다
  const armY0 = -wl + ARM_WALL_GAP;
  const nSeg = Math.ceil((HOUSING_Y0 - armY0) / ARM_SEG - 1e-9);
  for (let i = 0; i < nSeg; i++) {
    const y1 = HOUSING_Y0 - i * ARM_SEG;
    add({
      kind: 'solid',
      tag: 'barrier',
      poly: aabbRect(xb - ARM_HALF, Math.max(armY0, y1 - ARM_SEG), xb + ARM_HALF, y1),
      hMin: ARM_H0,
      hMax: ARM_H1,
      meta: { color: ARM_COLORS[i % 2] },
    });
  }

  const lamps: Pose[] = [];
  for (let x = LAMP_STEP / 2; x < xEnd - 1; x += LAMP_STEP) lamps.push({ x, y: -wl / 2, heading: 0 });

  return {
    kind: 'kiosk',
    elements: els,
    start,
    // 눈이 발권기 ±0.40 m 안이고 창문 쪽 차체가 앞면 0.30 m 안인 차의 범위. 화면 표시와 각도용 (성공 판정은 kioskEval)
    goal: {
      kind: 'slot',
      rect: rectFromAabb(
        xk - (spec.length - spec.eye.fromFront) - KIOSK_ALONG_MAX,
        FACE_Y - KIOSK_REACH_MAX - spec.width,
        xk + spec.eye.fromFront + KIOSK_ALONG_MAX,
        FACE_Y,
        0,
      ),
      maxAngleDeg: KIOSK_ANGLE_MAX,
    },
    bounds: boundsOf(els, 0),
    ceilingHeight: CEILING,
    floor: [{ poly: aabbRect(0, -wl, xEnd, ISLAND_D), tone: 'aisle' }],
    lamps,
    kiosk: { x: xk, faceY: FACE_Y },
  };
}
