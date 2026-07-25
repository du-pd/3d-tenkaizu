// 依存なしの簡易3Dビューア（Canvas 2D + 手書き投影）。
// CDN不要で単一サイトに完結させるため、Three.jsは使わずに自前実装する。
// マウスドラッグで回転、ホイールでズーム。面は簡易フラットシェーディング、
// 辺は「折り線=緑 / 切り線=赤」で色分けできる（展開結果を渡した場合）。
import { sub, cross, dot, normalize } from './vec.js';

export class Viewer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rotX = -0.5;
    this.rotY = 0.6;
    this.camZ = 3.2;   // 透視の奥行き（フォアショートニング量）
    this.zoom = 0.52;  // 画面充填率（min(w,h)に対する倍率）。ホイールで変える
    this.mesh = null;
    this.edgeColors = null; // Map edgeKey -> '#hex'
    this.edgePicker = null;
    this.interactive = false;
    this.dpr = 1;
    this._bind();
    // 表示サイズに描画バッファを合わせる（横圧縮を防ぐ）
    this._resize();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', () => this._resize());
  }

  // canvas の描画バッファを実表示サイズ×DPRに合わせる。
  // これをしないと固定解像度がCSSで引き伸ばされ、アスペクト比が崩れる。
  _resize() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    if (w === 0 || h === 0) return;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.draw();
  }

  setMesh(mesh) {
    this.mesh = mesh;
    // 中心化・正規化
    const vs = mesh.vertices;
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const v of vs) for (let k = 0; k < 3; k++) {
      if (v[k] < mn[k]) mn[k] = v[k];
      if (v[k] > mx[k]) mx[k] = v[k];
    }
    this.center = [(mn[0]+mx[0])/2, (mn[1]+mx[1])/2, (mn[2]+mx[2])/2];
    this.scale = Math.max(mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]) || 1;
    this.draw();
  }

  setEdgeColors(map) { this.edgeColors = map; this.draw(); }
  setEdgePicker(fn) { this.edgePicker = fn; }
  setInteractive(enabled) {
    this.interactive = enabled;
    this.canvas.style.cursor = enabled ? 'crosshair' : '';
  }

  _bind() {
    let dragging = false, moved = false, lx = 0, ly = 0, sx = 0, sy = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false; lx = e.clientX; ly = e.clientY; sx = e.clientX; sy = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 4) moved = true;
      this.rotY += (e.clientX - lx) * 0.01;
      this.rotX += (e.clientY - ly) * 0.01;
      lx = e.clientX; ly = e.clientY;
      this.draw();
    });
    this.canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      this.canvas.releasePointerCapture?.(e.pointerId);
      if (!moved && this.interactive && this.edgePicker) {
        const pick = this.pickEdge(e.clientX, e.clientY);
        if (pick) this.edgePicker(pick.key);
      }
    });
    this.canvas.addEventListener('pointercancel', () => { dragging = false; });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom *= e.deltaY > 0 ? 0.9 : 1.1;
      this.zoom = Math.max(0.12, Math.min(3, this.zoom));
      this.draw();
    }, { passive: false });
  }

  _project(p) {
    // 中心化＆正規化
    let x = (p[0] - this.center[0]) / this.scale;
    let y = (p[1] - this.center[1]) / this.scale;
    let z = (p[2] - this.center[2]) / this.scale;
    // Y回転
    let cy = Math.cos(this.rotY), sy = Math.sin(this.rotY);
    let x1 = x * cy + z * sy;
    let z1 = -x * sy + z * cy;
    // X回転
    let cx = Math.cos(this.rotX), sx = Math.sin(this.rotX);
    let y1 = y * cx - z1 * sx;
    let z2 = y * sx + z1 * cx;
    // 透視投影
    // ズーム（画面充填率）と透視の奥行きを分離する。
    const w = this.canvas.width, h = this.canvas.height;
    const f = Math.min(w, h) * this.zoom;
    const persp = this.camZ / (this.camZ - z2);
    return [w / 2 + x1 * f * persp, h / 2 - y1 * f * persp, z2];
  }

  pickEdge(clientX, clientY) {
    if (!this.mesh) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * this.dpr;
    const y = (clientY - rect.top) * this.dpr;
    const projs = this.mesh.vertices.map((v) => this._project(v));
    let best = null;
    const thresholdSq = Math.pow(12 * this.dpr, 2);
    for (const [key, edge] of this.mesh.edgeMap || []) {
      const p = projs[edge.a], q = projs[edge.b];
      const distSq = pointSegDistSq(x, y, p, q);
      if (distSq > thresholdSq) continue;
      // オクルージョン対策: クリック近傍のうち「最も手前(depth大)」の辺を選ぶ。
      // 投影のzは大きいほど手前（draw()も同順で上に重ねている）。裏側の辺を拾いにくい。
      const depth = (p[2] + q[2]) / 2;
      if (!best || depth > best.depth + 1e-6 ||
          (Math.abs(depth - best.depth) <= 1e-6 && distSq < best.distSq)) {
        best = { key, distSq, depth };
      }
    }
    return best;
  }

  draw() {
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f7f8fa';
    ctx.fillRect(0, 0, w, h);
    if (!this.mesh) return;
    const { vertices, faces } = this.mesh;

    // 面を奥行きでソート（画家のアルゴリズム）
    const projs = vertices.map((v) => this._project(v));
    const order = faces.map((f, i) => {
      let z = 0;
      for (const vi of f.verts) z += projs[vi][2];
      return { i, z: z / f.verts.length };
    }).sort((a, b) => a.z - b.z);

    const light = normalize([0.4, 0.6, 1]);
    for (const { i } of order) {
      const f = faces[i];
      // 法線から陰影
      const a = vertices[f.verts[0]], b = vertices[f.verts[1]], c = vertices[f.verts[2]];
      let n = normalize(cross(sub(b, a), sub(c, a)));
      // ビュー空間の向き（rotで回した法線のZを見る）→ 簡易に world法線・light
      const shade = 0.55 + 0.45 * Math.max(0, dot(n, light));
      const col = Math.round(200 * shade);
      ctx.beginPath();
      f.verts.forEach((vi, k) => {
        const p = projs[vi];
        if (k === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      });
      ctx.closePath();
      ctx.fillStyle = `rgb(${col},${col+15},${col+30})`;
      ctx.fill();
      // 辺（DPRに合わせて太さを調整）
      ctx.lineWidth = Math.max(1, this.dpr);
      ctx.lineJoin = 'round';
      f.verts.forEach((vi, k) => {
        const vj = f.verts[(k + 1) % f.verts.length];
        const key = vi < vj ? vi + '_' + vj : vj + '_' + vi;
        const p = projs[vi], q = projs[vj];
        ctx.strokeStyle = (this.edgeColors && this.edgeColors.get(key)) || '#33373d';
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
      });
    }
  }

}

function pointSegDistSq(x, y, p, q) {
  const vx = q[0] - p[0], vy = q[1] - p[1];
  const wx = x - p[0], wy = y - p[1];
  const vv = vx * vx + vy * vy;
  if (vv < 1e-9) return wx * wx + wy * wy;
  let t = (wx * vx + wy * vy) / vv;
  t = Math.max(0, Math.min(1, t));
  const dx = p[0] + vx * t - x;
  const dy = p[1] + vy * t - y;
  return dx * dx + dy * dy;
}
