import type { Scenario } from '../scenarios/types';
import type { Footprint } from '../sim/footprint';
import type { Pose, Vec2 } from '../sim/geometry';
import { polyToWorld } from '../sim/geometry';
import { rectCorners } from '../sim/goal';

const VIEW_M = 18; // 미니맵 짧은 변에 보이는 거리(m)

/** 화면 중심의 월드 좌표와 축척 */
export interface TopViewCamera {
  cx: number;
  cy: number;
  pxPerM: number;
}

export interface TopViewLayers {
  sc: Scenario;
  car: { fp: Footprint; pose: Pose } | null;
  path?: { left: Vec2[]; right: Vec2[] } | null;
  /** 주황 점선 1.5 px: 차체 + 미러 */
  ghost?: { fp: Footprint; pose: Pose } | null;
  /** 하늘색 2 px 꺾은선 */
  trail?: Vec2[] | null;
}

const FLOOR_TONE = { aisle: '#4a5650', walkway: '#5d6166' } as const;
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/**
 * 위에서 내려다본 2D 지도 (북쪽 +y가 위). ctx에는 이미 dpr 변환이 걸려 있다.
 * 순서: 배경, 바닥 구역, 목표, 요소(연석은 meta 색), 궤적(trail), 예상 경로, 고스트, 차.
 */
export function drawTopView(ctx: CanvasRenderingContext2D, w: number, h: number, cam: TopViewCamera, layers: TopViewLayers): void {
  const { sc, car } = layers;
  const s = cam.pxPerM;
  const toPx = (p: Vec2): [number, number] => [w / 2 + (p.x - cam.cx) * s, h / 2 - (p.y - cam.cy) * s];
  const trace = (pts: Vec2[], close: boolean) => {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [x, y] = toPx(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (close) ctx.closePath();
  };
  const poly = (pts: Vec2[], fill: string | null, stroke: string | null, lw = 1) => {
    trace(pts, true);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  };
  const polyline = (pts: Vec2[], stroke: string, lw: number) => {
    trace(pts, false);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  };
  /**
   * 같은 색 다각형을 한 경로로 모아 한 번에 칠한다. 따로 칠하면 맞닿은 변에 안티앨리어싱 틈(가는 선)이 생긴다
   * (램프의 5° 벽·연석·바닥 조각). 벽·연석은 다른 요소와 겹치지 않으므로 먼저 칠해도 그림은 같다.
   */
  const fillByColour = (items: [string, Vec2[]][]) => {
    const groups = new Map<string, Vec2[][]>();
    for (const [fill, pts] of items) {
      const g = groups.get(fill);
      if (g) g.push(pts);
      else groups.set(fill, [pts]);
    }
    for (const [fill, polys] of groups) {
      ctx.beginPath();
      for (const pts of polys) {
        pts.forEach((p, i) => {
          const [x, y] = toPx(p);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      ctx.fillStyle = fill;
      ctx.fill();
    }
  };
  const isWall = (el: Scenario['elements'][number]) => el.kind === 'solid' && el.tag !== 'car' && el.tag !== 'pillar';
  const curbFill = (el: Scenario['elements'][number]) => {
    const c = el.meta?.color;
    return typeof c === 'number' ? hex(c) : '#bfbfbf';
  };

  ctx.fillStyle = '#3b3f44';
  ctx.fillRect(0, 0, w, h);
  fillByColour(sc.floor.map((f): [string, Vec2[]] => [FLOOR_TONE[f.tone], f.poly]));
  poly(rectCorners(sc.goal.rect), 'rgba(48,209,88,0.28)', null);
  fillByColour(
    sc.elements.flatMap((el): [string, Vec2[]][] =>
      el.kind === 'curb' ? [[curbFill(el), el.poly]] : isWall(el) ? [['#8d9196', el.poly]] : [],
    ),
  );
  for (const el of sc.elements) {
    if (el.kind === 'line') poly(el.poly, '#e8e8e8', null);
    else if (el.kind === 'wheelStop') poly(el.poly, '#e0b400', null);
    else if (el.tag === 'car') poly(el.poly, '#6f7882', '#20242a');
    else if (el.tag === 'pillar') poly(el.poly, '#d8b020', '#20242a');
  }
  if (layers.trail && layers.trail.length > 1) polyline(layers.trail, '#64d2ff', 2);
  if (layers.path) for (const side of [layers.path.left, layers.path.right]) polyline(side, '#ffd60a', 1.5);
  if (layers.ghost) {
    const { fp, pose } = layers.ghost;
    ctx.setLineDash([4, 3]);
    for (const part of [fp.body, fp.mirrorLeft, fp.mirrorRight]) poly(polyToWorld(part.poly, pose), null, '#ff9f0a', 1.5);
    ctx.setLineDash([]);
  }
  if (car) {
    const { fp, pose } = car;
    // 고스트·궤적이 있으면 차체를 반투명하게 채워 그 아래 점선 윤곽·궤적이 보이게 한다.
    // (궤적은 뒤축 중심이라, 몇 m만 움직인 리플레이에서는 궤적 전체가 차체 밑에 있다. 궤적은 리플레이 탑뷰에만 있다)
    poly(polyToWorld(fp.body.poly, pose), layers.ghost || layers.trail ? 'rgba(244,245,247,0.45)' : '#f4f5f7', '#0a84ff', 1.5);
    poly(polyToWorld(fp.mirrorLeft.poly, pose), '#0a84ff', null);
    poly(polyToWorld(fp.mirrorRight.poly, pose), '#0a84ff', null);
    // 앞쪽 표시
    const [nx, ny] = toPx(polyToWorld([{ x: fp.zones.frontCenter[0].x - 0.5, y: 0 }], pose)[0]);
    ctx.fillStyle = '#0a84ff';
    ctx.beginPath();
    ctx.arc(nx, ny, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 차 위치를 중심으로 북쪽이 위인 미니맵. 축척 = 짧은 변에 18 m. 차가 없으면 목표 중심. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  draw(layers: TopViewLayers) {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const center = layers.car?.pose ?? { x: layers.sc.goal.rect.cx, y: layers.sc.goal.rect.cy };
    drawTopView(this.ctx, w, h, { cx: center.x, cy: center.y, pxPerM: Math.min(w, h) / VIEW_M }, layers);
  }
}
