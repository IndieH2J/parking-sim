import type { Pose, Vec2 } from './geometry';
import { polygonDistance, polylinePolygonDistance, polyToWorld } from './geometry';
import type { BodyZone, Footprint } from './footprint';
import type { WorldElement } from './world';
import { near } from './world';

export const SENSOR_RANGE = 2.0; // m. 이보다 멀면 표시하지 않는다.
const LINE_RANGE = 1.5;

export interface SensorReadings {
  /** 장애물(solid)까지 최소거리 m. 범위 밖이면 null */
  zones: Record<BodyZone | 'mirrorLeft' | 'mirrorRight', number | null>;
  /** 차와 거의 평행한 주차선까지 거리 m. 범위 밖이면 null */
  lines: {
    leftBody: number | null;
    rightBody: number | null;
    leftMirror: number | null;
    rightMirror: number | null;
  };
}

function hOverlap(a: { hMin: number; hMax: number }, b: { hMin: number; hMax: number }) {
  return a.hMin < b.hMax && b.hMin < a.hMax;
}

function minOrNull(v: number, range: number): number | null {
  return v <= range ? v : null;
}

export function readSensors(fp: Footprint, pose: Pose, elements: WorldElement[]): SensorReadings {
  const candidates = elements.filter((el) => near(el, pose, 6 + SENSOR_RANGE));
  const solids = candidates.filter((el) => el.kind === 'solid');
  // 차량 진행축과 15° 이내로 평행한 선만 측면 여유 계산에 쓴다. 연석도 선처럼 잰다 (하늘색 숫자에 연석 거리 표시).
  // 연석은 방향을 따지지 않는다: 곡선 연석은 5° 현 조각이라, 바깥쪽에서 가장 가까운 조각(차체 옆면 앞끝 옆)이
  // 진행축과 15~40° 어긋나 걸러지면 먼 조각 값이 나온다 (램프 곡선 바깥에서 실제 2 cm가 59 cm로 표시됐음).
  // 연석은 모두 벽을 따라 놓여 있다 (가로 연석 없음).
  const parallelLines = candidates.filter(
    (el) =>
      (el.kind === 'line' || el.kind === 'curb') &&
      el.dir !== undefined &&
      (el.kind === 'curb' || Math.abs(Math.cos(el.dir - pose.heading)) > Math.cos((15 * Math.PI) / 180)),
  );

  const zones = {} as SensorReadings['zones'];
  for (const [zone, local] of Object.entries(fp.zones) as [BodyZone, Vec2[]][]) {
    const line = polyToWorld(local, pose);
    let best = Infinity;
    for (const el of solids) {
      if (!hOverlap(fp.body, el)) continue;
      best = Math.min(best, polylinePolygonDistance(line, el.poly));
    }
    zones[zone] = minOrNull(best, SENSOR_RANGE);
  }
  const mirrorL = polyToWorld(fp.mirrorLeft.poly, pose);
  const mirrorR = polyToWorld(fp.mirrorRight.poly, pose);
  const mirrorDist = (poly: Vec2[], targets: WorldElement[], heightCheck: boolean) => {
    let best = Infinity;
    for (const el of targets) {
      if (heightCheck && !hOverlap(fp.mirrorLeft, el)) continue;
      best = Math.min(best, polygonDistance(poly, el.poly));
    }
    return best;
  };
  zones.mirrorLeft = minOrNull(mirrorDist(mirrorL, solids, true), SENSOR_RANGE);
  zones.mirrorRight = minOrNull(mirrorDist(mirrorR, solids, true), SENSOR_RANGE);

  const sideDist = (local: Vec2[]) => {
    const line = polyToWorld(local, pose);
    let best = Infinity;
    for (const el of parallelLines) best = Math.min(best, polylinePolygonDistance(line, el.poly));
    return minOrNull(best, LINE_RANGE);
  };
  return {
    zones,
    lines: {
      leftBody: sideDist(fp.zones.left),
      rightBody: sideDist(fp.zones.right),
      leftMirror: minOrNull(mirrorDist(mirrorL, parallelLines, false), LINE_RANGE),
      rightMirror: minOrNull(mirrorDist(mirrorR, parallelLines, false), LINE_RANGE),
    },
  };
}
