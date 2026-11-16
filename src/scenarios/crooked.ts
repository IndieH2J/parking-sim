import type { Vec2 } from '../sim/geometry';
import { polygonDistance } from '../sim/geometry';
import type { VehicleSpec } from '../sim/specs';
import type { WorldElement } from '../sim/world';
import { near, prepare } from '../sim/world';
import { parkedCar } from './common';
import type { PerpOptions, Scenario } from './types';

// 옆 차가 비뚤게 선 칸 (계약서 개정 2026-11-16 situations, 설계 .dev/v4-design.md C1).
// 직각 주차 빌더 결과의 후처리다: 빌더 시그니처(계약서 §1.2)와 배치·난수 순서를 그대로 두고, rnd()를 부르지 않는다.
// 바꾸는 요소는 목표 칸 양옆 주차 차량뿐이고 id·순서를 지킨다.

/** 가장 좁은 곳을 좁히는 최대 폭 (m) */
export const CROOK_MAX = 0.4;
/** 좁혀도 남기는 미러 바깥 여유, 양쪽 각각 (m, 내 차 미러 폭 기준) */
export const CROOK_ROOM = 0.2;
/** 동쪽 차가 기운 각도 (°) */
export const CROOK_DEG = 6;
/**
 * 기운 동쪽 차와 다른 solid 사이에 남길 거리 (m). 좁은 칸(가장 좁은 폭을 거의 못 줄이는 pillar 목표)에서는
 * 기울기만큼 뒤끝이 반대편 이웃 쪽으로 밀리므로, 이 거리가 남을 때까지 기울기를 1°씩 줄인다 (0°까지).
 */
export const CROOK_GAP = 0.05;

const maxX = (poly: Vec2[]) => Math.max(...poly.map((p) => p.x));
const minX = (poly: Vec2[]) => Math.min(...poly.map((p) => p.x));

/** 주차 차량 요소를 meta 값으로 다시 만든다 (id 유지) */
function rebuildCar(e: WorldElement, cx: number, cy: number, heading: number): WorldElement {
  const m = e.meta!;
  const dims = { length: Number(m.length), width: Number(m.width), height: Number(m.height) };
  return prepare({ ...parkedCar(cx, cy, heading, dims, Number(m.color)), id: e.id });
}

/**
 * 목표 칸(북쪽 열, 중심 x = bayCx) 양옆을 비뚤게 한 새 요소 배열. elements는 바꾸지 않는다.
 * - 이웃: 북쪽 열에서 bayCx ± 칸 폭 근처(칸 폭 절반 안)의 주차 차량. pillar 목표는 서쪽 이웃이 기둥이고 기둥은 움직이지 않는다.
 * - F0 = 동쪽 차의 가장 서쪽 꼭짓점 − 서쪽 이웃의 가장 동쪽 꼭짓점 (지금 가장 좁은 폭).
 *   F_t = min(F0, max(미러 폭 + 2·CROOK_ROOM, F0 − CROOK_MAX)): 원래 칸보다 넓어지지 않는다.
 * - 서쪽 차: 방향 그대로 x로 옮겨 안쪽 면을 bayCx − F_t/2에 둔다 ("선을 넘음").
 * - 동쪽 차: 뒤끝(뒷벽 쪽 끝) 가운데를 축으로 CROOK_DEG 돌려 통로 쪽 끝을 칸 쪽으로 기울이고,
 *   x로 옮겨 가장 가까운 꼭짓점을 서쪽 이웃 면 + F_t에 둔다 ("비스듬히").
 *   다른 solid와 CROOK_GAP보다 가까워지면 기울기를 1°씩 줄인다 (0°이면 옮기기만 한다).
 */
export function crookNeighbours(elements: WorldElement[], bayCx: number, opt: PerpOptions, spec: VehicleSpec): WorldElement[] {
  const W = opt.slotWidth;
  // 북쪽 열은 목표 칸만 비어 있다 (rearPerpendicular.ts buildGarage): 이웃은 늘 있다
  const northCar = (e: WorldElement, x: number) => e.tag === 'car' && e.bc!.y > 0 && Math.abs(e.bc!.x - x) < W / 2;
  const east = elements.find((e) => northCar(e, bayCx + W))!;
  const west =
    opt.target === 'pillar'
      ? elements.find((e) => e.tag === 'pillar' && e.bc!.y > 0 && Math.abs(maxX(e.poly) - (bayCx - W / 2)) < 1e-6)!
      : elements.find((e) => northCar(e, bayCx - W))!;

  const F0 = minX(east.poly) - maxX(west.poly);
  const Ft = Math.min(F0, Math.max(spec.widthMirrors + 2 * CROOK_ROOM, F0 - CROOK_MAX));
  const out = elements.slice();
  let westFace = maxX(west.poly);
  if (west.tag === 'car') {
    westFace = bayCx - Ft / 2;
    const m = west.meta!;
    out[elements.indexOf(west)] = rebuildCar(west, Number(m.cx) + westFace - maxX(west.poly), Number(m.cy), Number(m.heading));
  }

  // 동쪽 차: 뒤끝 가운데를 축으로 시계 방향(−deg) 회전하면 통로 쪽(−y) 끝이 −x(칸 쪽)로 간다
  const m = east.meta!;
  const h = Number(m.heading);
  const half = Number(m.length) / 2;
  const s = Math.sin(h) > 0 ? 1 : -1; // 뒤끝 = y가 큰 쪽 끝
  const px = Number(m.cx) + s * half * Math.cos(h);
  const py = Number(m.cy) + s * half * Math.sin(h);
  const others = out.filter((e) => e.kind === 'solid' && e !== east);
  for (let deg = CROOK_DEG; ; deg--) {
    const a = (-deg * Math.PI) / 180;
    const dx = Number(m.cx) - px;
    const dy = Number(m.cy) - py;
    const cx = px + dx * Math.cos(a) - dy * Math.sin(a);
    const cy = py + dx * Math.sin(a) + dy * Math.cos(a);
    const turned = rebuildCar(east, cx, cy, h + a);
    const car = rebuildCar(east, cx + westFace + Ft - minX(turned.poly), cy, h + a);
    const clear = others.every((o) => !near(o, car.bc!, car.br! + CROOK_GAP) || polygonDistance(car.poly, o.poly) >= CROOK_GAP);
    if (clear || deg === 0) {
      out[elements.indexOf(east)] = car;
      return out;
    }
  }
}

/** 직각 주차 빌더 결과를 후처리한다 (index.ts가 rearPerp·frontPerp에 부른다). opt.crooked가 꺼져 있으면 sc를 그대로 돌려준다. */
export function withCrooked(sc: Scenario, opt: PerpOptions, spec: VehicleSpec): Scenario {
  if (!opt.crooked) return sc;
  return { ...sc, elements: crookNeighbours(sc.elements, sc.goal.rect.cx, opt, spec) };
}
