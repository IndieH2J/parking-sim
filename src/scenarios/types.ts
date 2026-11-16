import type { Pose, Vec2 } from '../sim/geometry';
import type { WorldElement } from '../sim/world';
import type { Goal } from '../sim/goal';

// 시나리오 공통 타입과 옵션 메타데이터 (계약서 §1.1).

// 출차 3종·골목·유턴·발권기 6종은 계약서 개정 2026-11-16 situations (설계 .dev/v4-design.md C0).
export type ScenarioKind =
  | 'rearPerp'
  | 'frontPerp'
  | 'parallel'
  | 'ramp'
  | 'rearPerpOut'
  | 'frontPerpOut'
  | 'parallelOut'
  | 'alley'
  | 'uturn'
  | 'kiosk';
/** 예전 4종이 먼저 (설정 정리·테스트 순서) */
export const SCENARIO_KINDS: readonly ScenarioKind[] = [
  'rearPerp',
  'frontPerp',
  'parallel',
  'ramp',
  'rearPerpOut',
  'frontPerpOut',
  'parallelOut',
  'alley',
  'uturn',
  'kiosk',
];
export type TargetKind = 'between' | 'pillar';

/** 상황 선택 시트의 묶음: 주차하기 / 출차하기 / 주행 연습 */
export type SituationGroup = 'park' | 'pullOut' | 'drive';
export const SITUATION_GROUPS: readonly { group: SituationGroup; kinds: readonly ScenarioKind[] }[] = [
  { group: 'park', kinds: ['rearPerp', 'frontPerp', 'parallel'] },
  { group: 'pullOut', kinds: ['rearPerpOut', 'frontPerpOut', 'parallelOut'] },
  { group: 'drive', kinds: ['ramp', 'alley', 'uturn', 'kiosk'] },
];

/** rearPerp, frontPerp, rearPerpOut, frontPerpOut */
export interface PerpOptions {
  slotWidth: number;
  target: TargetKind;
  /** 옆 차가 비뚤게 선 칸 (crooked.ts). 없으면 꺼짐 */
  crooked?: boolean;
  seed?: number;
}
export interface ParallelOptions {
  slotLength: number;
  seed?: number;
}
/** innerRadius는 RAMP_RADIUS_OPTIONS 중 하나 */
export interface RampOptions {
  innerRadius: number;
}
/** alley, uturn, kiosk: 옵션 없음 (구성이 하나뿐, 크기는 차에 맞춘다) */
export type NoOptions = Record<string, never>;
export interface ScenarioOptionsMap {
  rearPerp: PerpOptions;
  frontPerp: PerpOptions;
  parallel: ParallelOptions;
  ramp: RampOptions;
  rearPerpOut: PerpOptions;
  frontPerpOut: PerpOptions;
  parallelOut: ParallelOptions;
  alley: NoOptions;
  uturn: NoOptions;
  kiosk: NoOptions;
}
export type AnyScenarioOptions = ScenarioOptionsMap[ScenarioKind];

// UI·설정 정리·테스트용 옵션 메타데이터.
// 시나리오 에이전트는 바꿀 필요를 보고만 하고, 수정은 게이트만 한다.
/** 직각 두 종류가 함께 쓴다 (settings.perp). 계획서 옵션이라 지우지 않는다. */
export const PERP_SLOT_PRESETS: readonly number[] = [2.3, 2.5, 2.6];
export const PERP_SLOT_RANGE = { min: 2.1, max: 3.2, step: 0.05 };
export const PARALLEL_LENGTH_PRESETS: readonly number[] = [6.0, 6.5, 7.0];
export const PARALLEL_LENGTH_RANGE = { min: 5.8, max: 8.0, step: 0.1 };
export const RAMP_RADIUS_OPTIONS: readonly number[] = [6, 5];

/** 시각 표현 전용, 볼록. h = 윗면 높이 (기본 0.001). */
export interface FloorPatch {
  poly: Vec2[];
  tone: 'aisle' | 'walkway' | 'road';
  h?: number;
}

export interface Scenario {
  kind: ScenarioKind;
  /** 모두 prepare()를 거친 요소. id는 서로 다르고 poly는 모두 볼록 */
  elements: WorldElement[];
  /** poseClear(start, 조향 0)이 'ok' */
  start: Pose;
  goal: Goal;
  /** 바닥·천장 평면 범위 */
  bounds: { x0: number; x1: number; y0: number; y1: number };
  ceilingHeight: number;
  /** scene.ts·minimap.ts에 박혀 있던 통로 바닥을 대신한다 */
  floor: FloorPatch[];
  /** 천장 조명 중심. 긴 축이 heading 방향 */
  lamps: Pose[];
  /** 야외 (하늘 배경, 천장·조명 없음). 없으면 실내 */
  outdoor?: boolean;
  /** 점수 기준 덮어쓰기: 전환 기준 횟수와 gap 항목 만점 거리 (score.ts ScoreInput.par로 넘긴다) */
  scorePar?: { moves?: number; gapFull?: number };
  /** 발권기 (kioskJudge.ts): x = 기계 중심 x, faceY = 차로 쪽 기계 앞면 y */
  kiosk?: { x: number; faceY: number };
}
