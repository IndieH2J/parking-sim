import type { Vec2 } from './geometry';
import { rect } from './geometry';
import type { VehicleSpec } from './specs';

// 차량 로컬 좌표(원점 = 뒤축 중심, +x 전방, +y 왼쪽)에서의 외곽 형상.

export interface Part {
  poly: Vec2[];
  hMin: number;
  hMax: number;
}

export interface Footprint {
  body: Part;
  mirrorLeft: Part;
  mirrorRight: Part;
  /** 차체 외곽을 구역별 꺾은선으로 나눈 것 (거리 센서용) */
  zones: Record<BodyZone, Vec2[]>;
}

export type BodyZone =
  | 'frontLeft'
  | 'frontCenter'
  | 'frontRight'
  | 'rearLeft'
  | 'rearCenter'
  | 'rearRight'
  | 'left'
  | 'right';

/** 모서리를 깎은 정도(평면도에서 범퍼 모서리의 둥근 정도 근사) */
const CORNER_CHAMFER = 0.15;

export function bodyExtents(spec: VehicleSpec) {
  return {
    xr: -spec.rearOverhang,
    xf: spec.wheelbase + spec.frontOverhang,
    hw: spec.width / 2,
  };
}

export function buildFootprint(spec: VehicleSpec): Footprint {
  const { xr, xf, hw } = bodyExtents(spec);
  const c = CORNER_CHAMFER;
  const body: Vec2[] = [
    { x: xr + c, y: -hw },
    { x: xf - c, y: -hw },
    { x: xf, y: -hw + c },
    { x: xf, y: hw - c },
    { x: xf - c, y: hw },
    { x: xr + c, y: hw },
    { x: xr, y: hw - c },
    { x: xr, y: -hw + c },
  ];
  const m = spec.mirror;
  const mw = spec.widthMirrors / 2;
  const mirrorLeft = [
    { x: m.xRear, y: m.yInner },
    { x: m.xFront, y: m.yInner },
    { x: m.xFront, y: mw },
    { x: m.xRear, y: mw },
  ];
  const mirrorRight = mirrorLeft.map((p) => ({ x: p.x, y: -p.y })).reverse();
  const t = hw / 3;
  const zones: Record<BodyZone, Vec2[]> = {
    frontCenter: [
      { x: xf, y: -t },
      { x: xf, y: t },
    ],
    frontLeft: [
      { x: xf, y: t },
      { x: xf, y: hw - c },
      { x: xf - c, y: hw },
    ],
    frontRight: [
      { x: xf, y: -t },
      { x: xf, y: -hw + c },
      { x: xf - c, y: -hw },
    ],
    rearCenter: [
      { x: xr, y: -t },
      { x: xr, y: t },
    ],
    rearLeft: [
      { x: xr, y: t },
      { x: xr, y: hw - c },
      { x: xr + c, y: hw },
    ],
    rearRight: [
      { x: xr, y: -t },
      { x: xr, y: -hw + c },
      { x: xr + c, y: -hw },
    ],
    left: [
      { x: xf - c, y: hw },
      { x: xr + c, y: hw },
    ],
    right: [
      { x: xf - c, y: -hw },
      { x: xr + c, y: -hw },
    ],
  };
  return {
    body: { poly: body, hMin: spec.groundClearance, hMax: spec.height },
    mirrorLeft: { poly: mirrorLeft, hMin: m.hBottom, hMax: m.hTop },
    mirrorRight: { poly: mirrorRight, hMin: m.hBottom, hMax: m.hTop },
    zones,
  };
}

export type WheelId = 'FL' | 'FR' | 'RL' | 'RR';

/** 타이어 접지 영역(평면도). 앞바퀴는 조향각만큼 회전한다. */
export function wheelPolys(spec: VehicleSpec, steer: number): Record<WheelId, Vec2[]> {
  const L = spec.wheelbase;
  const d = spec.tireDiameter;
  const w = spec.tireWidth;
  return {
    FL: rect(L, spec.trackFront / 2, d, w, steer),
    FR: rect(L, -spec.trackFront / 2, d, w, steer),
    RL: rect(0, spec.trackRear / 2, d, w),
    RR: rect(0, -spec.trackRear / 2, d, w),
  };
}
