import type { Pose, Vec2 } from './geometry';
import { boundingRadius, polygonsOverlap, polyToWorld } from './geometry';
import type { Footprint, Part, WheelId } from './footprint';
import { wheelPolys } from './footprint';
import type { VehicleSpec } from './specs';

/**
 * solid     : 벽·기둥·주차 차량. 높이 범위가 겹치면 충돌
 * wheelStop : 휠스톱. 바퀴만 막는다 (차체 오버행은 위로 지나감)
 * curb      : 연석. 바퀴만 막는다
 * line      : 주차선. 충돌 없음, 거리 측정·판정용
 */
export type ElementKind = 'solid' | 'wheelStop' | 'curb' | 'line';
export type SolidTag = 'wall' | 'pillar' | 'car';

export interface WorldElement {
  id: string;
  kind: ElementKind;
  tag?: SolidTag;
  poly: Vec2[]; // 월드 좌표, 볼록
  hMin: number;
  hMax: number;
  /** 선 방향(rad). line 요소에서 평행 여부 판정에 사용 */
  dir?: number;
  /** 렌더링용 부가정보 (주차 차량 색 등) */
  meta?: Record<string, number | string>;
  // 캐시
  bc?: Vec2;
  br?: number;
}

export function prepare(el: WorldElement): WorldElement {
  const { c, r } = boundingRadius(el.poly);
  el.bc = c;
  el.br = r;
  return el;
}

export function near(el: WorldElement, p: Vec2, range: number): boolean {
  const dx = el.bc!.x - p.x;
  const dy = el.bc!.y - p.y;
  const r = el.br! + range;
  return dx * dx + dy * dy <= r * r;
}

function heightOverlap(a: { hMin: number; hMax: number }, b: { hMin: number; hMax: number }) {
  return a.hMin < b.hMax && b.hMin < a.hMax;
}

export type HitPart = 'body' | 'mirrorLeft' | 'mirrorRight';

export interface Collision {
  part: HitPart;
  element: WorldElement;
}

const CAR_REACH = 6; // 차량 외곽이 뒤축 중심에서 닿을 수 있는 최대 거리 근사(m)

/** 차체·미러가 solid 요소와 충돌하는지 */
export function findCollision(fp: Footprint, pose: Pose, elements: WorldElement[]): Collision | null {
  const parts: [HitPart, Part][] = [
    ['body', fp.body],
    ['mirrorLeft', fp.mirrorLeft],
    ['mirrorRight', fp.mirrorRight],
  ];
  const world = parts.map(([n, p]) => [n, polyToWorld(p.poly, pose), p] as const);
  for (const el of elements) {
    if (el.kind !== 'solid' || !near(el, pose, CAR_REACH)) continue;
    for (const [name, poly, part] of world) {
      if (heightOverlap(part, el) && polygonsOverlap(poly, el.poly)) return { part: name, element: el };
    }
  }
  return null;
}

/** 바퀴가 휠스톱·연석에 걸리는지 */
export function findWheelBlock(
  spec: VehicleSpec,
  pose: Pose,
  steerAngle: number,
  elements: WorldElement[],
): { wheel: WheelId; element: WorldElement } | null {
  const wheels = wheelPolys(spec, steerAngle);
  for (const el of elements) {
    if ((el.kind !== 'wheelStop' && el.kind !== 'curb') || !near(el, pose, CAR_REACH)) continue;
    for (const id of Object.keys(wheels) as WheelId[]) {
      if (polygonsOverlap(polyToWorld(wheels[id], pose), el.poly)) return { wheel: id, element: el };
    }
  }
  return null;
}
