// 2D 기하 유틸. 모든 폴리곤은 볼록(convex)이라고 가정한다.

export interface Vec2 {
  x: number;
  y: number;
}

export interface Pose {
  x: number;
  y: number;
  heading: number; // rad, +x에서 반시계
}

export function toWorld(p: Vec2, pose: Pose): Vec2 {
  const c = Math.cos(pose.heading);
  const s = Math.sin(pose.heading);
  return { x: pose.x + p.x * c - p.y * s, y: pose.y + p.x * s + p.y * c };
}

export function polyToWorld(poly: Vec2[], pose: Pose): Vec2[] {
  return poly.map((p) => toWorld(p, pose));
}

/** 중심·크기·회전으로 사각형 폴리곤(반시계)을 만든다. */
export function rect(cx: number, cy: number, sx: number, sy: number, angle = 0): Vec2[] {
  const hx = sx / 2;
  const hy = sy / 2;
  const local = [
    { x: -hx, y: -hy },
    { x: hx, y: -hy },
    { x: hx, y: hy },
    { x: -hx, y: hy },
  ];
  return polyToWorld(local, { x: cx, y: cy, heading: angle });
}

/** 축 정렬 사각형 (x0..x1, y0..y1) */
export function aabbRect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function project(poly: Vec2[], ax: number, ay: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of poly) {
    const d = p.x * ax + p.y * ay;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/** 분리축 정리(SAT)로 볼록 폴리곤 겹침 판정. 접하기만 하는 경우는 겹침이 아니다. */
export function polygonsOverlap(a: Vec2[], b: Vec2[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const ax = -(q.y - p.y);
      const ay = q.x - p.x;
      const [aMin, aMax] = project(a, ax, ay);
      const [bMin, bMax] = project(b, ax, ay);
      if (aMax <= bMin || bMax <= aMin) return false;
    }
  }
  return true;
}

export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx - p.x;
  const cy = a.y + t * dy - p.y;
  return Math.hypot(cx, cy);
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const cross = (o: Vec2, p: Vec2, q: Vec2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function segmentSegmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

export function pointInConvex(p: Vec2, poly: Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c !== 0) {
      const s = c > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

/** 꺾은선(polyline)과 볼록 폴리곤 사이 최소거리. 겹치면 0. */
export function polylinePolygonDistance(line: Vec2[], poly: Vec2[]): number {
  for (const p of line) if (pointInConvex(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    for (let j = 0; j < poly.length; j++) {
      const d = segmentSegmentDistance(line[i], line[i + 1], poly[j], poly[(j + 1) % poly.length]);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

/** 볼록 폴리곤 사이 최소거리. 겹치면 0. */
export function polygonDistance(a: Vec2[], b: Vec2[]): number {
  if (polygonsOverlap(a, b)) return 0;
  return polylinePolygonDistance([...a, a[0]], b);
}

export function boundingRadius(poly: Vec2[]): { c: Vec2; r: number } {
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p.x;
    cy += p.y;
  }
  cx /= poly.length;
  cy /= poly.length;
  let r = 0;
  for (const p of poly) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
  return { c: { x: cx, y: cy }, r };
}
