import type { Scenario } from '../scenarios/types';
import type { Footprint } from '../sim/footprint';
import type { Pose } from '../sim/geometry';
import { rectCorners } from '../sim/goal';
import { frameAt, trailOf, type ReplayFrame } from '../sim/replay';
import { drawTopView } from './minimap';

// 리플레이 탑뷰 (계약서 §5.3). 기록 전체의 뒤축 점과 목표 꼭짓점을 감싸는 범위에 4 m를 더해 캔버스에 맞추고,
// 그리기는 미니맵과 같은 drawTopView에 맡긴다 (궤적 = trailOf(frames, t)). 북쪽(+y)이 위.

/** m. 뒤축 점에서 차체 끝까지(모델 Y 앞 모서리 3.87 m, 프리셋 7종도 3.9 m 미만)를 덮는다. 더 긴 직접 입력 차는 draw가 넓힌다. */
const PAD = 4;

export class TopReplayView {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /**
   * ghost: 그 시각의 고스트 자세 (호출하는 쪽이 ghostPose(spec, ghostSpec, frameAt(frames, t), align)로 구한다).
   * insetTop: 캔버스 위쪽에서 이만큼(px)은 다른 UI(상태 표시줄)가 덮으므로, 범위를 그 아래 영역에 맞춘다. 그림은 캔버스 전체에 그린다.
   */
  draw(
    sc: Scenario,
    fp: Footprint,
    frames: readonly ReplayFrame[],
    t: number,
    ghost: { fp: Footprint; pose: Pose } | null,
    insetTop = 0,
  ): void {
    const c = this.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (w === 0 || h === 0) return; // 숨겨진 캔버스
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const grow = (x: number, y: number) => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    };
    for (const f of frames) grow(f.x, f.y);
    for (const p of rectCorners(sc.goal.rect)) grow(p.x, p.y);
    // 어느 프레임에서도 차체·미러는 뒤축 점에서 reach 안에 있다: 그만큼 넓히면 긴 직접 입력 차도 잘리지 않는다
    const reach = Math.max(...[fp.body, fp.mirrorLeft, fp.mirrorRight].flatMap((part) => part.poly.map((p) => Math.hypot(p.x, p.y))));
    const pad = Math.max(PAD, reach + 0.1);
    x0 -= pad;
    y0 -= pad;
    x1 += pad;
    y1 += pad;
    // 위쪽 insetTop을 뺀 영역에 맞추고 그 가운데에 둔다 (북쪽이 위라 캔버스 가운데는 범위 가운데보다 insetTop/2 px만큼 북쪽)
    const fitH = Math.max(1, h - insetTop);
    const pxPerM = Math.min(w / (x1 - x0), fitH / (y1 - y0));

    drawTopView(
      this.ctx,
      w,
      h,
      { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 + insetTop / 2 / pxPerM, pxPerM },
      {
        sc,
        car: frames.length > 0 ? { fp, pose: frameAt(frames, t) } : null,
        trail: trailOf(frames, t),
        ghost,
      },
    );
  }
}
