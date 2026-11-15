// ============================================================
// 专注创作 · 手绘渲染器（浏览器端，零依赖）
// 读取 window.__PLAN__，在 1080×1440 画布上按「纸 → 草稿 → 墨线 → 上色 → 纹理 → 字」画完。
// 所有随机都来自 plan.seed，同一份 plan 结果一致。
// ============================================================
(function () {
  'use strict'

  const W = 1080
  const H = 1440
  const plan = window.__PLAN__ || {}
  const cv = document.getElementById('c')
  const ctx = cv.getContext('2d')

  // ---------------------------------------------------------------- 随机与噪声
  function mulberry32(a) {
    let x = (Number(a) >>> 0) || 1
    return function () {
      x |= 0
      x = (x + 0x6d2b79f5) | 0
      let t = Math.imul(x ^ (x >>> 15), 1 | x)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const rand = mulberry32(plan.seed)
  const rr = (a, b) => a + (b - a) * rand()
  const pick = (list) => list[Math.floor(rand() * list.length)]

  function hash1(i, s) {
    const v = Math.sin(i * 127.1 + s * 311.7) * 43758.5453
    return v - Math.floor(v)
  }
  function noise1(x, s) {
    const i = Math.floor(x)
    const f = x - i
    const a = hash1(i, s)
    const b = hash1(i + 1, s)
    const u = f * f * (3 - 2 * f)
    return a + (b - a) * u
  }
  function fbm(x, s, oct) {
    let v = 0
    let amp = 0.5
    let f = 1
    for (let i = 0; i < (oct || 3); i += 1) {
      v += noise1(x * f, s + i * 13) * amp
      amp *= 0.5
      f *= 2
    }
    return v
  }

  // ---------------------------------------------------------------- 调色板
  const PALETTES = {
    'warm-cream': { bg: '#f4ead6', paper: '#f7f0df', ink: '#3b322a', soft: '#8c7b68', accent: '#d06a48', second: '#7f9c8b', blush: '#e59a92', hair: '#4c7fc2', hair2: '#39639e', dress: '#34506f', apron: '#faf3e5', skin: '#f5d7c4', hi: '#fffaf0' },
    'cool-ink': { bg: '#e4ebee', paper: '#eef3f4', ink: '#2f3a44', soft: '#7c8d99', accent: '#5f86a8', second: '#c9a36b', blush: '#dfa3a0', hair: '#547fb6', hair2: '#3c5f8e', dress: '#324a63', apron: '#f4f7f7', skin: '#f1d6c6', hi: '#fbfdfd' },
    'dusty-blue': { bg: '#dfe3e7', paper: '#e9ecef', ink: '#333a42', soft: '#7b8794', accent: '#6a7f9a', second: '#b98d6a', blush: '#d6a09c', hair: '#5b83b4', hair2: '#40628d', dress: '#384d63', apron: '#f1f3f5', skin: '#efd5c5', hi: '#fafbfc' },
    peach: { bg: '#f7e3d8', paper: '#fbf0e8', ink: '#402f2b', soft: '#96776d', accent: '#df7557', second: '#9aa878', blush: '#eb9d96', hair: '#4e7fbe', hair2: '#3a5f94', dress: '#3b5275', apron: '#fff8ef', skin: '#f6d8c6', hi: '#fffaf3' },
    moss: { bg: '#e7ecdf', paper: '#eff3e7', ink: '#33402f', soft: '#7c8a70', accent: '#a36a4b', second: '#6f8d5e', blush: '#e0a49b', hair: '#4d7cba', hair2: '#3a5e90', dress: '#374f68', apron: '#f7f6ea', skin: '#f3d8c5', hi: '#fcfcf3' },
    mono: { bg: '#e9e6df', paper: '#f2efe8', ink: '#2f2c29', soft: '#8a837a', accent: '#7d7469', second: '#b2a89a', blush: '#d3a39e', hair: '#6d7f95', hair2: '#526274', dress: '#3c454f', apron: '#f5f2ea', skin: '#efd6c6', hi: '#fbf9f3' },
  }
  const P = PALETTES[plan.palette] || PALETTES['warm-cream']

  // 角色身份色：只跟「蛋蛋」本人走，不随纸张/环境调色板漂移。
  // 取自 03-child-initial-maid 三视图：深蓝长发、发梢青蓝、藏青女仆裙、奶白围裙。
  const DAN = {
    hairDeep: '#1d285e',
    hairShade: '#263574',
    hair: '#3b5199',
    hairMid: '#4b66ad',
    hairLight: '#7fa3d8',
    hairTip: '#9ed0ea',
    line: '#25243d',
    lineSoft: '#4d4f70',
    dress: '#242b5d',
    dressLight: '#35447a',
    dressDark: '#171c42',
    apron: '#fbf7ee',
    apronShade: '#e7ded2',
    frill: '#fffdf8',
    skin: '#fbeee8',
    skinHand: '#f3cec1',
    skinShade: '#eec1b5',
    blush: '#efa9a5',
    pearl: '#f7f0e3',
    gold: '#efc96c',
    cyan: '#75bde5',
    red: '#c9565d',
    shadow: '#8d93b5',
  }

  function withAlpha(hex, alpha) {
    const h = String(hex).replace('#', '')
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
    const r = (n >> 16) & 255
    const g = (n >> 8) & 255
    const b = n & 255
    return `rgba(${r},${g},${b},${alpha})`
  }

  /** 在闭合形状里铺一层渐变，保留手绘的溢色与纸齿。 */
  function fillGradient(points, stops, opt) {
    const o = opt || {}
    const alpha = o.alpha == null ? 1 : o.alpha
    const dx = o.dx == null ? rr(-2, 2) : o.dx
    const dy = o.dy == null ? rr(-2, 2) : o.dy
    const path = polyPath(points)
    ctx.save()
    ctx.translate(dx, dy)
    ctx.globalAlpha = alpha
    ctx.clip(path)
    const x1 = o.x1 == null ? 0 : o.x1
    const y1 = o.y1 == null ? -80 : o.y1
    const x2 = o.x2 == null ? 0 : o.x2
    const y2 = o.y2 == null ? 300 : o.y2
    const grad = ctx.createLinearGradient(x1, y1, x2, y2)
    for (const [at, color] of stops) grad.addColorStop(at, color)
    ctx.fillStyle = grad
    ctx.fillRect(-200, -220, 640, 900)
    if (o.texture !== false) {
      ctx.globalAlpha = alpha * 0.18
      ctx.fillStyle = o.textureColor || DAN.hairDeep
      for (let i = 0; i < (o.dots || 90); i += 1) {
        const x = rr(-180, 260)
        const y = rr(-220, 600)
        ctx.beginPath()
        ctx.arc(x, y, rr(0.5, 2.2), 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.restore()
  }

  /** 用软笔在闭合形状里补阴影，不靠均匀排线。 */
  function softShade(points, color, alpha, opt) {
    const o = opt || {}
    ctx.save()
    ctx.clip(polyPath(points))
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    ctx.beginPath()
    const x = o.x == null ? 0 : o.x
    const y = o.y == null ? 100 : o.y
    ctx.ellipse(x, y, o.rx || 80, o.ry || 60, o.rot || 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  /** 局部排线：角色坐标里用，不要拿全局 W/H 去裁。 */
  function charHatch(points, color, opt) {
    const o = opt || {}
    const gap = o.gap || 16
    const angle = o.angle == null ? -1.0 : o.angle
    const path = polyPath(points)
    ctx.save()
    ctx.clip(path)
    ctx.strokeStyle = color
    ctx.globalAlpha = o.alpha == null ? 0.16 : o.alpha
    ctx.lineWidth = o.w || 1
    const len = 420
    for (let d = -420; d < 420; d += gap + rr(-1.5, 1.5)) {
      const cx = Math.cos(angle + Math.PI / 2) * d
      const cy = 140 + Math.sin(angle + Math.PI / 2) * d
      ctx.beginPath()
      ctx.moveTo(cx - Math.cos(angle) * len, cy - Math.sin(angle) * len)
      ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len)
      ctx.stroke()
    }
    ctx.restore()
  }

  /** 一笔彩色高光，像白颜料/彩铅提亮。 */
  function gouache(points, color, opt) {
    brush(points, { ...(opt || {}), color, alpha: (opt && opt.alpha) == null ? 0.75 : opt.alpha, w: (opt && opt.w) || 3, amp: 1.2, kind: 'marker' })
  }

  // ---------------------------------------------------------------- 基础几何
  function dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]) }
  function catmullPoint(p0, p1, p2, p3, t) {
    const t2 = t * t
    const t3 = t2 * t
    return [
      0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
      0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
    ]
  }
  function catmull(points, closed, seg) {
    const n = points.length
    if (n < 2) return points.slice()
    const src = closed ? [points[n - 1], ...points, points[0], points[1]] : [points[0], ...points, points[n - 1]]
    const out = []
    for (let i = 1; i < src.length - 2; i += 1) {
      for (let j = 0; j < seg; j += 1) out.push(catmullPoint(src[i - 1], src[i], src[i + 1], src[i + 2], j / seg))
    }
    if (!closed) out.push(points[n - 1])
    return out
  }
  function resample(points, step) {
    if (points.length < 2) return points.slice()
    const out = [points[0]]
    let carry = 0
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]
      const b = points[i]
      let d = dist(a, b)
      if (d < 1e-6) continue
      let t = 0
      while (carry + d >= step) {
        const need = (step - carry) / d
        t += need
        const px = a[0] + (b[0] - a[0]) * t
        const py = a[1] + (b[1] - a[1]) * t
        out.push([px, py])
        d -= step - carry
        carry = 0
        if (t >= 1) break
      }
      carry += d
    }
    const last = points[points.length - 1]
    if (dist(out[out.length - 1], last) > 1) out.push(last)
    return out
  }
  function normalsOf(pts) {
    const out = []
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[Math.max(0, i - 1)]
      const b = pts[Math.min(pts.length - 1, i + 1)]
      let tx = b[0] - a[0]
      let ty = b[1] - a[1]
      const len = Math.hypot(tx, ty) || 1
      tx /= len
      ty /= len
      out.push([-ty, tx])
    }
    return out
  }
  function ellipsePts(cx, cy, rx, ry, rot, n) {
    const out = []
    const count = n || 48
    for (let i = 0; i < count; i += 1) {
      const a = (Math.PI * 2 * i) / count
      const x = Math.cos(a) * rx
      const y = Math.sin(a) * ry
      out.push([cx + x * Math.cos(rot || 0) - y * Math.sin(rot || 0), cy + x * Math.sin(rot || 0) + y * Math.cos(rot || 0)])
    }
    return out
  }
  function shifted(pts, dx, dy) { return pts.map((p) => [p[0] + dx, p[1] + dy]) }
  function scaled(pts, s, ox, oy) { return pts.map((p) => [(p[0] - (ox || 0)) * s + (ox || 0), (p[1] - (oy || 0)) * s + (oy || 0)]) }

  // ---------------------------------------------------------------- 笔触
  function widthProfile(u, kind) {
    const tin = 0.11
    const tout = 0.16
    let edge = 1
    if (u < tin) edge = 0.3 + 0.7 * (u / tin)
    else if (u > 1 - tout) edge = 0.35 + 0.65 * ((1 - u) / tout)
    let body = 1
    if (kind === 'pencil') body = 0.9 + 0.12 * Math.sin(u * Math.PI)
    if (kind === 'crayon') body = 1.05 - 0.1 * Math.sin(u * Math.PI * 3)
    if (kind === 'marker') body = 1.02
    return edge * body
  }

  function polyPath(points) {
    const p = new Path2D()
    if (!points.length) return p
    p.moveTo(points[0][0], points[0][1])
    for (let i = 1; i < points.length; i += 1) p.lineTo(points[i][0], points[i][1])
    p.closePath()
    return p
  }

  /**
   * 变宽笔触：中心线 → 两侧轮廓 → 填充。
   * @param {Array<[number,number]>} points
   * @param {object} opt
   */
  // 把矩形/多边形每条边拆成几段再交给 brush，避免 catmull 把桌角、床角拉成椭圆。
  function densePoly(points, perEdge = 4) {
    const out = []
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      for (let k = 0; k < perEdge; k += 1) {
        const t = k / perEdge
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      }
    }
    return out
  }

  function brush(points, opt) {    const o = opt || {}
    const w = o.w == null ? 8 : o.w
    const color = o.color || P.ink
    const alpha = o.alpha == null ? 1 : o.alpha
    const amp = o.amp == null ? 2 : o.amp
    const scale = o.scale || 70
    const seed = (o.seed || 0) + (plan.seed || 0) * 0.001
    const kind = o.kind || 'ink'
    const close = Boolean(o.close)
    if (!points || points.length < 2) return
    let dense = resample(catmull(points, close, 10), 3.4)
    if (dense.length < 2) return
    const ns = normalsOf(dense)
    const left = []
    const right = []
    let prevW = w
    for (let i = 0; i < dense.length; i += 1) {
      const u = i / (dense.length - 1)
      const n = ns[i]
      const wob = (fbm(i * 0.06 + seed, seed * 3, 3) - 0.5) * 2 * amp
      const cx = dense[i][0] + n[0] * wob
      const cy = dense[i][1] + n[1] * wob
      const target = w * widthProfile(u, kind)
      prevW = prevW * 0.55 + target * 0.45
      left.push([cx + n[0] * prevW * 0.5, cy + n[1] * prevW * 0.5])
      right.push([cx - n[0] * prevW * 0.5, cy - n[1] * prevW * 0.5])
    }
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    const pts = left.concat(right.reverse())
    ctx.fill(polyPath(pts))
    // 圆头：两端补小圆，避免切口平得像矢量
    const capA = left[0]
    const capB = left[left.length - 1]
    ctx.beginPath()
    ctx.arc(capA[0], capA[1], Math.max(0.5, w * 0.35), 0, Math.PI * 2)
    ctx.arc(capB[0], capB[1], Math.max(0.5, w * 0.28), 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    if (o.double) {
      const shift = o.doubleShift == null ? 2 : o.doubleShift
      const alt = dense.map((p, i) => [p[0] + (hash1(i, seed + 7) - 0.5) * shift, p[1] + (hash1(i, seed + 9) - 0.5) * shift])
      brush(alt.slice(1, Math.max(2, Math.floor(alt.length * 0.92))), { ...o, w: w * 0.45, alpha: alpha * 0.45, double: false, seed: seed + 31 })
    }
    if (o.broken) {
      const at = Math.floor(dense.length * o.broken)
      const gap = 4 + Math.floor(hash1(at, seed) * 8)
      brush(dense.slice(at + gap), { ...o, broken: 0, double: false })
    }
  }

  // ---------------------------------------------------------------- 上色
  function toothDots(path, color, count, size) {
    ctx.save()
    ctx.clip(path)
    ctx.fillStyle = color
    ctx.globalAlpha = 0.5
    for (let i = 0; i < count; i += 1) {
      const x = rr(0, W)
      const y = rr(0, H)
      const s = rr(0.6, size || 2.2)
      ctx.beginPath()
      ctx.arc(x, y, s, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  function hatch(path, color, opt) {
    const o = opt || {}
    const gap = o.gap || 12
    const angle = o.angle == null ? -0.95 : o.angle
    const width = o.w || 1.6
    const alpha = o.alpha == null ? 0.35 : o.alpha
    ctx.save()
    ctx.clip(path)
    ctx.strokeStyle = color
    ctx.globalAlpha = alpha
    ctx.lineWidth = width
    const len = Math.max(W, H) * 1.6
    for (let d = -len; d < len; d += gap + rr(-2, 2)) {
      const cx = W / 2 + Math.cos(angle + Math.PI / 2) * d
      const cy = H / 2 + Math.sin(angle + Math.PI / 2) * d
      ctx.beginPath()
      ctx.moveTo(cx - Math.cos(angle) * len, cy - Math.sin(angle) * len)
      ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len)
      ctx.stroke()
    }
    ctx.restore()
  }

  function fillShape(points, color, opt) {
    const o = opt || {}
    const medium = o.medium || plan.medium || 'coloredPencil'
    const alpha = o.alpha == null ? 0.75 : o.alpha
    const dx = o.dx == null ? rr(-4, 4) : o.dx
    const dy = o.dy == null ? rr(-3, 3) : o.dy
    const path = polyPath(points)
    ctx.save()
    ctx.translate(dx, dy)
    ctx.fillStyle = color
    ctx.globalAlpha = alpha
    ctx.fill(path)
    ctx.restore()
    const p2 = polyPath(shifted(points, dx, dy))

    if (medium === 'watercolor') {
      ctx.save()
      ctx.translate(dx * 1.5, dy * 1.7)
      ctx.globalAlpha = alpha * 0.3
      ctx.fillStyle = color
      ctx.fill(polyPath(scaled(points, 1.01, 0, 0)))
      ctx.restore()
      ctx.save()
      ctx.clip(p2)
      ctx.globalAlpha = 0.14
      ctx.fillStyle = P.ink
      for (let i = 0; i < 160; i += 1) {
        const x = rr(0, W)
        const y = rr(0, H)
        ctx.beginPath()
        ctx.arc(x, y, rr(0.7, 2.4), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
      // 干边：沿轮廓内侧重描一圈
      brush(points, { w: 2.2, color, alpha: alpha * 0.55, amp: 1.6, kind: 'ink', close: true })
    } else if (medium === 'crayon') {
      toothDots(p2, P.paper, Math.round(70 + rr(0, 40)), 3.2)
      ctx.save()
      ctx.clip(p2)
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.22
      ctx.lineWidth = 5
      for (let i = 0; i < 70; i += 1) {
        const x = rr(0, W)
        const y = rr(0, H)
        const len = rr(10, 34)
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x + len, y + rr(-8, 8))
        ctx.stroke()
      }
      ctx.restore()
    } else if (medium === 'coloredPencil') {
      hatch(p2, color, { gap: 9, angle: -0.8, alpha: 0.25, w: 1.4 })
      hatch(p2, P.ink, { gap: 16, angle: 0.7, alpha: 0.1, w: 1.1 })
    } else if (medium === 'pencil') {
      hatch(p2, P.ink, { gap: 8, angle: -0.9, alpha: 0.18, w: 1.2 })
    } else if (medium === 'marker') {
      ctx.save()
      ctx.clip(p2)
      ctx.globalAlpha = 0.25
      ctx.fillStyle = P.ink
      ctx.fillRect(0, H / 2, W, H / 2)
      ctx.restore()
      hatch(p2, color, { gap: 18, angle: -0.6, alpha: 0.14, w: 4 })
    } else {
      hatch(p2, color, { gap: 11, angle: -0.85, alpha: 0.22, w: 1.6 })
    }
  }

  // ---------------------------------------------------------------- 纸与纹理
  function paperRect(color) {
    ctx.fillStyle = color
    ctx.fillRect(0, 0, W, H)
  }

  function fibers(color, count, alpha) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.globalAlpha = alpha
    ctx.lineWidth = 1
    for (let i = 0; i < count; i += 1) {
      const x = rr(0, W)
      const y = rr(0, H)
      const len = rr(8, 42)
      const ang = rr(-0.4, 0.4)
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len)
      ctx.stroke()
    }
    ctx.restore()
  }

  function grainCanvas() {
    const gw = 540
    const gh = 720
    const c = document.createElement('canvas')
    c.width = gw
    c.height = gh
    const g = c.getContext('2d')
    const img = g.createImageData(gw, gh)
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 120 + Math.floor(rand() * 70)
      img.data[i] = v
      img.data[i + 1] = v
      img.data[i + 2] = v
      img.data[i + 3] = Math.floor(rand() * 58)
    }
    g.putImageData(img, 0, 0)
    return c
  }

  function applyGrain(grain) {
    ctx.save()
    ctx.globalCompositeOperation = 'multiply'
    ctx.globalAlpha = 0.5
    ctx.drawImage(grain, 0, 0, W, H)
    ctx.restore()
    // 纸边不齐：外圈画一圈比纸深一点点的毛边
    ctx.save()
    ctx.strokeStyle = 'rgba(80,68,54,0.28)'
    ctx.lineWidth = 2
    ctx.beginPath()
    const pts = []
    for (let i = 0; i <= 40; i += 1) {
      const t = i / 40
      pts.push([t * W, 6 + noise1(i * 0.7, 12) * 5])
    }
    ctx.moveTo(pts[0][0], pts[0][1])
    for (const p of pts) ctx.lineTo(p[0], p[1])
    ctx.stroke()
    ctx.restore()
  }

  function dust(count, alpha) {
    ctx.save()
    ctx.fillStyle = P.ink
    ctx.globalAlpha = alpha
    for (let i = 0; i < count; i += 1) {
      const x = rr(0, W)
      const y = rr(0, H)
      const r = rr(0.4, 1.4)
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  function tape(x, y, rot, len) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ctx.globalAlpha = 0.55
    ctx.fillStyle = '#efe7d2'
    ctx.fillRect(-len / 2, -16, len, 32)
    ctx.globalAlpha = 0.25
    ctx.strokeStyle = '#b9ad93'
    ctx.strokeRect(-len / 2, -16, len, 32)
    ctx.restore()
  }

  // ---------------------------------------------------------------- 背景
  function background() {
    const id = plan.background || 'white-paper'
    const base = P.paper
    paperRect(base)

    if (id === 'white-paper') {
      fibers('#cbbfa9', 260, 0.22)
    } else if (id === 'kraft') {
      paperRect('#ead7b6')
      fibers('#c8b18d', 420, 0.28)
      fibers('#f7ebd4', 180, 0.25)
    } else if (id === 'ruled') {
      fibers('#cbbfa9', 160, 0.16)
      ctx.save()
      ctx.strokeStyle = 'rgba(96,124,146,0.35)'
      ctx.lineWidth = 1.6
      for (let y = 120; y < H; y += 64) {
        ctx.beginPath()
        ctx.moveTo(40, y + noise1(y, 3) * 1.5)
        ctx.lineTo(W - 40, y + noise1(y, 5) * 1.5)
        ctx.stroke()
      }
      ctx.strokeStyle = 'rgba(190,110,100,0.4)'
      ctx.beginPath()
      ctx.moveTo(96, 60)
      ctx.lineTo(96, H - 60)
      ctx.stroke()
      ctx.restore()
    } else if (id === 'grid') {
      fibers('#cbbfa9', 120, 0.14)
      ctx.save()
      ctx.strokeStyle = 'rgba(104,130,146,0.28)'
      ctx.lineWidth = 1.2
      for (let x = 60; x < W; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 40); ctx.lineTo(x, H - 40); ctx.stroke()
      }
      for (let y = 80; y < H; y += 40) {
        ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(W - 40, y); ctx.stroke()
      }
      ctx.restore()
    } else if (id === 'aged') {
      paperRect('#efe2c8')
      fibers('#b8a582', 380, 0.3)
      ctx.save()
      for (let i = 0; i < 6; i += 1) {
        const x = rr(0, W)
        const y = rr(0, H)
        ctx.globalAlpha = 0.08
        ctx.fillStyle = '#8a6f4d'
        ctx.beginPath()
        ctx.ellipse(x, y, rr(40, 160), rr(30, 120), rr(0, 1), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
      ctx.save()
      ctx.strokeStyle = 'rgba(120,96,70,0.35)'
      ctx.lineWidth = 2
      for (const x of [W * 0.34, W * 0.68]) {
        ctx.beginPath()
        ctx.moveTo(x + rr(-6, 6), 40)
        ctx.lineTo(x + rr(-10, 10), H - 40)
        ctx.stroke()
      }
      ctx.restore()
    } else if (id === 'desk') {
      paperRect('#e5cda8')
      ctx.save()
      ctx.strokeStyle = 'rgba(120,86,52,0.18)'
      ctx.lineWidth = 5
      for (let i = 0; i < 14; i += 1) {
        const y = 40 + i * 100 + rr(-20, 20)
        ctx.beginPath()
        ctx.moveTo(20, y)
        ctx.bezierCurveTo(W * 0.3, y + rr(-18, 18), W * 0.7, y + rr(-18, 18), W - 20, y + rr(-8, 8))
        ctx.stroke()
      }
      ctx.restore()
      // 桌上铺着一张画纸：四周留出木纹
      ctx.save()
      ctx.globalAlpha = 0.22
      ctx.fillStyle = '#b98d62'
      ctx.fillRect(62, 52, W - 104, H - 84)
      ctx.restore()
      ctx.save()
      ctx.fillStyle = P.paper
      ctx.fillRect(48, 38, W - 96, H - 76)
      ctx.restore()
      tape(94, 72, -0.5, 150)
      tape(W - 100, 92, 0.45, 140)
    } else if (id === 'wall') {
      paperRect('#e7dfd1')
      fibers('#c3b8a6', 200, 0.15)
      ctx.save()
      ctx.globalAlpha = 0.12
      ctx.fillStyle = '#9a8f7d'
      ctx.fillRect(0, H - 120, W, 120)
      ctx.restore()
    } else if (id === 'fabric') {
      paperRect('#e3ddd2')
      ctx.save()
      ctx.strokeStyle = 'rgba(120,108,92,0.18)'
      ctx.lineWidth = 2
      for (let x = 0; x < W; x += 26) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 10, H); ctx.stroke()
      }
      for (let y = 0; y < H; y += 26) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y + 10); ctx.stroke()
      }
      ctx.restore()
    } else if (id === 'card') {
      paperRect(P.bg)
      ctx.save()
      ctx.globalAlpha = 0.10
      ctx.fillStyle = '#000'
      ctx.fillRect(26, 26, W - 52, H - 52)
      ctx.globalAlpha = 1
      ctx.fillStyle = P.paper
      ctx.fillRect(18, 18, W - 36, H - 36)
      ctx.restore()
      ctx.save()
      ctx.globalAlpha = 0.35
      ctx.strokeStyle = P.second
      ctx.lineWidth = 4
      ctx.strokeRect(18, 18, W - 36, H - 36)
      ctx.restore()
    } else if (id === 'rain-window') {
      paperRect('#dce8eb')
      ctx.save()
      // 窗外模糊的光
      for (let i = 0; i < 8; i += 1) {
        ctx.globalAlpha = 0.25
        ctx.fillStyle = i % 2 ? '#f5d9a8' : '#a9c4cf'
        ctx.beginPath()
        ctx.arc(rr(120, W - 120), rr(120, H * 0.55), rr(40, 120), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
      ctx.save()
      ctx.strokeStyle = 'rgba(210,232,238,0.75)'
      ctx.lineWidth = 3
      for (let i = 0; i < 90; i += 1) {
        const x = rr(0, W)
        const y = rr(0, H)
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x + rr(-3, 3), y + rr(18, 60))
        ctx.stroke()
      }
      ctx.restore()
      ctx.save()
      ctx.fillStyle = 'rgba(92,110,116,0.28)'
      ctx.fillRect(W / 2 - 14, 0, 28, H)
      ctx.fillRect(0, H * 0.42, W, 22)
      ctx.restore()
    }

    // 纸面轻微泛黄 + 四周暗角（手绘扫描感）
    ctx.save()
    ctx.globalAlpha = 0.06
    ctx.fillStyle = '#8a6a42'
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
  }

  // ---------------------------------------------------------------- 物件
  function objCloud(x, y, s, color) {
    const pts = []
    const lumps = [[-60, 0, 46], [-10, -18, 54], [50, -4, 44], [90, 12, 32]]
    for (const [dx, dy, r] of lumps) {
      for (let i = 0; i <= 16; i += 1) {
        const a = Math.PI + (Math.PI * i) / 16
        pts.push([x + dx * s + Math.cos(a) * r * s, y + dy * s + Math.sin(a) * r * s * 0.8])
      }
    }
    for (const [dx, dy, r] of lumps.slice().reverse()) {
      for (let i = 0; i <= 10; i += 1) {
        const a = (Math.PI * i) / 10
        pts.push([x + dx * s + Math.cos(a) * r * s, y + dy * s + Math.sin(a) * r * s * 0.5 + 24 * s])
      }
    }
    brush(catmull(pts, true, 4), { w: 4.5 * s, color, amp: 1.8, close: true })
    fillShape(pts, '#fbfaf2', { alpha: 0.7, medium: 'watercolor' })
  }
  function objRain(x, y, s, color) {
    for (let i = 0; i < 10; i += 1) {
      const px = x + rr(-90, 90) * s
      const py = y + rr(-70, 90) * s
      brush([[px, py], [px - 6 * s, py + 34 * s]], { w: 2.4 * s, color, amp: 1.2, kind: 'ink' })
    }
  }
  function objWindow(x, y, s, color) {
    const w = 108 * s
    const h = 140 * s
    const outer = [[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]]
    // 窗外的天光：淡蓝灰，不涂成一整块死蓝
    const sky = [[x - w / 2 + 7, y - h / 2 + 7], [x + w / 2 - 7, y - h / 2 + 7], [x + w / 2 - 7, y + h / 2 - 7], [x - w / 2 + 7, y + h / 2 - 7]]
    fillShape(sky, '#dfeef3', { alpha: 0.55, medium: 'watercolor' })
    // 四格窗棂
    for (const dx of [-w / 4, w / 4]) {
      brush([[x + dx, y - h / 2 + 5], [x + dx, y + h / 2 - 5]], { w: 2.2 * s, color, alpha: 0.8, amp: 1.1 })
    }
    for (const dy of [-h / 4, h / 4]) {
      brush([[x - w / 2 + 5, y + dy], [x + w / 2 - 5, y + dy]], { w: 2.2 * s, color, alpha: 0.8, amp: 1.1 })
    }
    // 窗框：粗细两次，像用彩铅描过
    brush(outer, { w: 4.2 * s, color, close: true, amp: 1.4 })
    brush(outer, { w: 1.4 * s, color: P.ink, close: true, alpha: 0.35, amp: 0.8 })
    // 窗台
    brush([[x - w / 2 - 8 * s, y + h / 2 + 4 * s], [x + w / 2 + 8 * s, y + h / 2 + 3 * s]], { w: 3.4 * s, color, amp: 0.8 })
    // 雨丝
    for (let i = 0; i < 6; i += 1) {
      const px = x - w / 2 + 12 * s + i * 16 * s
      brush([[px, y - h / 2 + 10 * s], [px + 3 * s, y - h / 2 + 34 * s]], { w: 1.2 * s, color, alpha: 0.4, amp: 0.7 })
    }
  }
  function objCup(x, y, s, color) {
    const pts = [[x - 40 * s, y - 20 * s], [x + 34 * s, y - 20 * s], [x + 26 * s, y + 46 * s], [x - 32 * s, y + 46 * s]]
    brush(pts, { w: 4.5 * s, color, close: true, amp: 1.8 })
    fillShape(pts, '#fdfbf4', { alpha: 0.85, medium: 'watercolor' })
    fillShape(ellipsePts(x - 2 * s, y - 18 * s, 34 * s, 9 * s, 0), '#8a5433', { alpha: 0.55, medium: 'marker' })
    const handle = [[x + 34 * s, y - 4 * s], [x + 58 * s, y + 4 * s], [x + 52 * s, y + 32 * s], [x + 28 * s, y + 26 * s]]
    brush(handle, { w: 3.4 * s, color, amp: 1.2 })
    for (let i = 0; i < 3; i += 1) {
      const px = x + rr(-10, 10) * s
      brush([[px, y - 34 * s], [px + rr(-8, 8) * s, y - 62 * s], [px + rr(-14, 14) * s, y - 88 * s]], { w: 2 * s, color, alpha: 0.45, amp: 2 })
    }
  }
  function objLamp(x, y, s, color) {
    brush([[x - 42 * s, y + 42 * s], [x + 42 * s, y + 42 * s]], { w: 6 * s, color, amp: 1.5 })
    brush([[x, y + 38 * s], [x + 6 * s, y - 10 * s], [x + 24 * s, y - 48 * s]], { w: 4 * s, color, amp: 1.4 })
    const shade = [[x + 6 * s, y - 56 * s], [x + 66 * s, y - 40 * s], [x + 44 * s, y - 8 * s]]
    brush(shade, { w: 4 * s, color, close: true })
    fillShape(shade, '#f2d38a', { alpha: 0.65, medium: 'crayon' })
    ctx.save()
    ctx.globalAlpha = 0.15
    ctx.fillStyle = '#f4d9a0'
    ctx.beginPath()
    ctx.moveTo(x + 8 * s, y - 28 * s)
    ctx.lineTo(x + 120 * s, y + 96 * s)
    ctx.lineTo(x - 30 * s, y + 110 * s)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
  function objPillow(x, y, s, color) {
    const w = 62 * s
    const h = 36 * s
    const r = 14 * s
    // 底下先铺一层淡影，别让枕头像贴在纸上的便签
    ctx.save()
    ctx.globalAlpha = 0.18
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.ellipse(x, y + h * 1.02, w * 0.92, h * 0.42, 0.04, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    const pts = []
    const corner = (cx, cy, a0) => {
      for (let i = 0; i <= 6; i += 1) {
        const a = a0 + (Math.PI / 2) * (i / 6)
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
      }
    }
    corner(x - w + r, y - h + r, Math.PI)
    corner(x + w - r, y - h + r, -Math.PI / 2)
    corner(x + w - r, y + h - r, 0)
    corner(x - w + r, y + h - r, Math.PI / 2)
    fillShape(pts, '#f7f2e5', { alpha: 0.88, medium: 'watercolor' })
    // 布面高光：靠左上的一小块，像被灯照到
    fillShape([
      [x - w * 0.55, y - h * 0.35],
      [x - w * 0.1, y - h * 0.5],
      [x + w * 0.2, y - h * 0.2],
      [x - w * 0.2, y - h * 0.1],
    ], '#fffdf7', { alpha: 0.42, medium: 'watercolor' })
    brush(pts, { w: 3.4 * s, color, close: true, amp: 2 })
    // 中间压痕 + 两道布褶，读得出是软枕头
    brush([[x - w * 0.5, y - 2], [x, y + 5], [x + w * 0.5, y - 2]], { w: 2 * s, color, alpha: 0.42, amp: 1.4 })
    brush([[x - w * 0.6, y + h * 0.35], [x - w * 0.2, y + h * 0.55], [x + w * 0.25, y + h * 0.5]], { w: 1.2 * s, color, alpha: 0.28, amp: 1.2 })
    // 四角的布尖和右侧小流苏
    for (const side of [-1, 1]) {
      brush([[x + side * (w - 4), y - h + 6], [x + side * (w + 8), y - h - 4], [x + side * (w - 2), y - h + 16]], { w: 1.6 * s, color, alpha: 0.6, close: true })
    }
    for (let i = 0; i < 3; i += 1) {
      brush([[x + w + 4, y + 4 + i * 5], [x + w + 14 * s, y + 10 + i * 6]], { w: 1.2 * s, color, alpha: 0.65, amp: 1.2 })
    }
  }
  function objStars(x, y, s, color) {
    for (let i = 0; i < 7; i += 1) {
      const px = x + rr(-90, 90) * s
      const py = y + rr(-80, 80) * s
      const r = rr(8, 16) * s
      brush([[px - r, py], [px, py - r * 1.4], [px + r, py], [px, py + r], [px - r, py]], { w: 2 * s, color, amp: 1 })
      brush([[px, py - r * 1.4], [px, py + r]], { w: 1.4 * s, color, alpha: 0.45 })
    }
  }
  function objFlower(x, y, s, color) {
    brush([[x, y + 70 * s], [x + rr(-10, 10) * s, y + 10 * s]], { w: 3.4 * s, color, amp: 1.6 })
    brush([[x - 8 * s, y + 30 * s], [x - 40 * s, y + 8 * s], [x - 30 * s, y - 12 * s]], { w: 2 * s, color, alpha: 0.8 })
    for (let i = 0; i < 6; i += 1) {
      const a = (Math.PI * 2 * i) / 6
      const px = x + Math.cos(a) * 26 * s
      const py = y + Math.sin(a) * 26 * s
      const petal = ellipsePts(px, py, 18 * s, 12 * s, a)
      brush(petal, { w: 2.8 * s, color, close: true, alpha: 0.9, amp: 1.2 })
      fillShape(petal, P.accent, { alpha: 0.4, medium: 'crayon' })
    }
    brush(ellipsePts(x, y, 10 * s, 10 * s, 0), { w: 2.4 * s, color, close: true })
    fillShape(ellipsePts(x, y, 8 * s, 8 * s, 0), '#efc35a', { alpha: 0.8, medium: 'marker' })
  }
  function objFish(x, y, s, color) {
    const body = [[x - 54 * s, y], [x - 10 * s, y - 30 * s], [x + 34 * s, y - 12 * s], [x + 46 * s, y], [x + 30 * s, y + 18 * s], [x - 12 * s, y + 30 * s]]
    brush(body, { w: 4 * s, color, close: true, amp: 1.8 })
    fillShape(body, P.hair, { alpha: 0.45 })
    brush([[x + 46 * s, y], [x + 74 * s, y - 22 * s], [x + 68 * s, y], [x + 76 * s, y + 22 * s]], { w: 3.2 * s, color, amp: 1.2 })
    brush(ellipsePts(x - 30 * s, y - 6 * s, 5 * s, 6 * s, 0), { w: 2 * s, color, close: true })
  }
  function objShell(x, y, s, color) {
    const pts = [[x, y + 54 * s]]
    for (let i = 0; i <= 8; i += 1) {
      const a = Math.PI + (Math.PI * i) / 8
      pts.push([x + Math.cos(a) * 62 * s, y + 8 * s + Math.sin(a) * 40 * s])
    }
    brush(pts, { w: 4 * s, color, close: true, amp: 2 })
    fillShape(pts, '#f6ddcb', { alpha: 0.55, medium: 'watercolor' })
    for (let i = 1; i < 8; i += 1) {
      const a = Math.PI + (Math.PI * i) / 8
      brush([[x, y + 54 * s], [x + Math.cos(a) * 54 * s, y + 8 * s + Math.sin(a) * 34 * s]], { w: 1.8 * s, color, alpha: 0.7 })
    }
  }
  function objOrigami(x, y, s, color) {
    // 一只折纸鹤：菱形身体 + 翅膀 + 脖子 + 尾巴，线条要能读出折痕
    const body = [[x - 58 * s, y + 26 * s], [x - 12 * s, y - 34 * s], [x + 26 * s, y + 18 * s], [x - 20 * s, y + 44 * s]]
    fillShape(body, '#f6f1e4', { alpha: 0.7, medium: 'watercolor' })
    brush(body, { w: 3.2 * s, color, close: true, amp: 1.4 })
    const wing = [[x - 12 * s, y - 34 * s], [x + 44 * s, y - 48 * s], [x + 36 * s, y - 8 * s], [x + 2 * s, y + 6 * s]]
    fillShape(wing, '#efe8d8', { alpha: 0.55, medium: 'watercolor' })
    brush(wing, { w: 3 * s, color, close: true, amp: 1.2 })
    // 脖子和头
    brush([[x + 26 * s, y + 18 * s], [x + 64 * s, y - 16 * s], [x + 78 * s, y - 6 * s]], { w: 3.4 * s, color, amp: 1.2 })
    brush([[x + 78 * s, y - 6 * s], [x + 60 * s, y + 2 * s], [x + 62 * s, y - 14 * s]], { w: 2.6 * s, color, close: true })
    // 尾巴
    brush([[x - 58 * s, y + 26 * s], [x - 92 * s, y + 6 * s], [x - 76 * s, y + 42 * s]], { w: 3 * s, color, close: true })
    // 折痕
    brush([[x - 12 * s, y - 34 * s], [x + 2 * s, y + 4 * s], [x + 26 * s, y + 18 * s]], { w: 1.6 * s, color, alpha: 0.4 })
  }
  function objNote(x, y, s, color) {
    for (let i = 0; i < 2; i += 1) {
      const px = x + i * 30 * s
      const py = y + i * 10 * s
      brush(ellipsePts(px, py + 26 * s, 16 * s, 11 * s, -0.3), { w: 2.6 * s, color, close: true })
      brush([[px + 14 * s, py + 22 * s], [px + 14 * s, py - 36 * s], [px + 34 * s, py - 26 * s]], { w: 2.4 * s, color, amp: 1.2 })
    }
  }
  function objBook(x, y, s, color) {
    const cover = [[x - 62 * s, y - 8 * s], [x, y - 26 * s], [x + 62 * s, y - 8 * s], [x + 54 * s, y + 38 * s], [x, y + 24 * s], [x - 54 * s, y + 38 * s]]
    fillShape(cover, P.accent, { alpha: 0.28, medium: 'watercolor' })
    brush(cover, { w: 4 * s, color, close: true, amp: 1.6 })
    brush([[x, y - 24 * s], [x, y + 24 * s]], { w: 2.6 * s, color })
    for (let i = 0; i < 3; i += 1) {
      brush([[x - 40 * s, y + 4 * s + i * 9 * s], [x - 12 * s, y - 2 * s + i * 9 * s]], { w: 1.4 * s, color, alpha: 0.4 })
      brush([[x + 14 * s, y - 2 * s + i * 9 * s], [x + 44 * s, y + 4 * s + i * 9 * s]], { w: 1.4 * s, color, alpha: 0.4 })
    }
  }
  function objPen(x, y, s, color) {
    brush([[x - 54 * s, y + 44 * s], [x + 40 * s, y - 42 * s], [x + 54 * s, y - 28 * s], [x - 40 * s, y + 58 * s]], { w: 4 * s, color, close: true, amp: 1.4 })
    brush([[x + 40 * s, y - 42 * s], [x + 54 * s, y - 28 * s]], { w: 2 * s, color })
    brush([[x - 40 * s, y + 58 * s], [x - 48 * s, y + 66 * s]], { w: 2 * s, color })
  }
  function objYarn(x, y, s, color) {
    const ball = ellipsePts(x, y, 40 * s, 38 * s, 0)
    fillShape(ball, P.accent, { alpha: 0.25, medium: 'crayon' })
    brush(ball, { w: 3 * s, color, close: true, amp: 1.6 })
    for (let i = 0; i < 5; i += 1) {
      brush(ellipsePts(x, y, 40 * s, 38 * s, i * 0.5).slice(0, 22), { w: 1.8 * s, color, alpha: 0.6, amp: 1.2 })
    }
    brush([[x + 36 * s, y + 24 * s], [x + 70 * s, y + 50 * s], [x + 92 * s, y + 30 * s]], { w: 2 * s, color, alpha: 0.7 })
  }
  function objBalloon(x, y, s, color) {
    const body = ellipsePts(x, y, 36 * s, 46 * s, 0)
    brush(body, { w: 3.4 * s, color, close: true, amp: 1.5 })
    fillShape(body, P.accent, { alpha: 0.4 })
    brush([[x, y + 46 * s], [x + rr(-6, 6) * s, y + 90 * s], [x + rr(-10, 10) * s, y + 128 * s]], { w: 1.8 * s, color, amp: 2 })
  }
  function objBread(x, y, s, color) {
    const pts = [[x - 46 * s, y + 36 * s], [x - 54 * s, y - 20 * s], [x - 20 * s, y - 34 * s], [x + 24 * s, y - 36 * s], [x + 54 * s, y - 10 * s], [x + 46 * s, y + 36 * s], [x - 46 * s, y + 36 * s]]
    fillShape(pts, '#dda45f', { alpha: 0.55, medium: 'crayon' })
    brush(pts, { w: 4 * s, color, close: true, amp: 1.8 })
    for (let i = 0; i < 5; i += 1) brush([[x - 28 * s + i * 14 * s, y - 18 * s], [x - 22 * s + i * 14 * s, y + 4 * s]], { w: 1.4 * s, color, alpha: 0.4 })
  }
  function objMoon(x, y, s, color) {
    const r = 40 * s
    // 用两段圆弧拼月牙，不是一块黄圆饼
    const outer = []
    const inner = []
    for (let i = 0; i <= 16; i += 1) {
      const a = -Math.PI / 2 + (Math.PI * i) / 16
      outer.push([x + Math.cos(a) * r, y + Math.sin(a) * r * 1.05])
      inner.push([x + r * 0.52 + Math.cos(a) * r * 0.82, y + Math.sin(a) * r * 0.88])
    }
    const pts = outer.concat(inner.reverse())
    fillGradient(pts, [[0, '#f7e4a4'], [0.55, '#f1cd72'], [1, '#e0a94f']], { alpha: 0.62, y1: y - r, y2: y + r, texture: false })
    brush(pts, { w: 2.6 * s, color, close: true, amp: 1.1, alpha: 0.8 })
    // 月面小坑
    for (let i = 0; i < 4; i += 1) {
      const px = x - r * 0.15 + i * 10 * s
      const py = y - 8 * s + (i % 2) * 12 * s
      brush(ellipsePts(px, py, 3.2 * s, 2.4 * s, 0), { w: 0.8, color: P.soft, alpha: 0.35, close: true })
    }
  }
  function objPuddle(x, y, s, color) {
    const pts = ellipsePts(x, y, 92 * s, 26 * s, rr(-0.08, 0.08), 40)
    fillShape(pts, '#b7ccd6', { alpha: 0.32, medium: 'watercolor' })
    brush(pts, { w: 2.8 * s, color, close: true, amp: 1.5, alpha: 0.8 })
    for (let i = 0; i < 4; i += 1) brush([[x - 50 * s + i * 12 * s, y + rr(-8, 8) * s], [x + 30 * s, y + rr(-8, 8) * s]], { w: 1.6 * s, color, alpha: 0.35 })
  }
  function objUmbrella(x, y, s, color) {
    const dome = [[x - 70 * s, y + 10 * s]]
    for (let i = 0; i <= 8; i += 1) {
      const a = Math.PI + (Math.PI * i) / 8
      dome.push([x + Math.cos(a) * 70 * s, y + 10 * s + Math.sin(a) * 56 * s])
    }
    dome.push([x + 70 * s, y + 10 * s])
    fillShape(dome, P.accent, { alpha: 0.3, medium: 'watercolor' })
    brush(dome, { w: 4 * s, color, close: true, amp: 1.6 })
    for (let i = 1; i <= 7; i += 1) {
      const a = Math.PI + (Math.PI * i) / 8
      brush([[x, y - 46 * s], [x + Math.cos(a) * 68 * s, y + 10 * s + Math.sin(a) * 54 * s]], { w: 1.6 * s, color, alpha: 0.5 })
    }
    brush([[x, y + 10 * s], [x, y + 64 * s], [x + 22 * s, y + 72 * s]], { w: 2.6 * s, color })
  }
  function objChicken(x, y, s, color) {
    // 炸鸡腿：肉块 + 露出的骨头，不要画成一块土疙瘩
    const meat = [[x - 18 * s, y - 26 * s], [x + 16 * s, y - 32 * s], [x + 40 * s, y - 8 * s], [x + 34 * s, y + 24 * s], [x + 2 * s, y + 38 * s], [x - 24 * s, y + 16 * s]]
    fillShape(meat, '#c98a4b', { alpha: 0.55, medium: 'crayon' })
    brush(meat, { w: 3.4 * s, color, close: true, amp: 1.8 })
    // 面包糠的小疙瘩
    for (let i = 0; i < 9; i += 1) {
      const px = x - 14 * s + (i % 3) * 16 * s
      const py = y - 18 * s + Math.floor(i / 3) * 14 * s
      brush(ellipsePts(px, py, 6 * s, 4 * s, rr(-0.4, 0.4)), { w: 1.6 * s, color, close: true, alpha: 0.5 })
    }
    // 骨头
    const bone = [[x - 18 * s, y + 6 * s], [x - 58 * s, y - 10 * s]]
    brush(bone, { w: 8 * s, color: '#f3ecdb', alpha: 0.9, kind: 'marker' })
    brush(bone, { w: 2.2 * s, color, amp: 1.2 })
    brush(ellipsePts(x - 60 * s, y - 12 * s, 9 * s, 8 * s, 0.2), { w: 2.2 * s, color, close: true })
    brush(ellipsePts(x - 66 * s, y - 4 * s, 7 * s, 6 * s, 0.6), { w: 2 * s, color, close: true })
  }
  function objTailPillow(x, y, s, color) {
    const tail = [[x - 60 * s, y + 20 * s], [x - 20 * s, y + 40 * s], [x + 20 * s, y + 6 * s], [x + 50 * s, y - 30 * s]]
    brush(tail, { w: 24 * s, color: P.hair, alpha: 0.55, amp: 3, kind: 'marker' })
    brush(tail, { w: 2.4 * s, color, amp: 1.4 })
    const fluke = [[x + 50 * s, y - 30 * s], [x + 76 * s, y - 48 * s], [x + 62 * s, y - 14 * s], [x + 82 * s, y - 6 * s], [x + 46 * s, y + 2 * s]]
    brush(fluke, { w: 2.6 * s, color, close: true, amp: 1.6 })
  }
  function objSun(x, y, s, color) {
    const disc = ellipsePts(x, y, 34 * s, 34 * s, 0)
    fillShape(disc, '#efc35a', { alpha: 0.6, medium: 'crayon' })
    brush(disc, { w: 4 * s, color, close: true, amp: 1.4 })
    for (let i = 0; i < 10; i += 1) {
      const a = (Math.PI * 2 * i) / 10
      brush([[x + Math.cos(a) * 46 * s, y + Math.sin(a) * 46 * s], [x + Math.cos(a) * 66 * s, y + Math.sin(a) * 66 * s]], { w: 2.2 * s, color, amp: 1 })
    }
  }
  function objCandy(x, y, s, color) {
    const mid = ellipsePts(x, y, 34 * s, 21 * s, 0)
    fillGradient(mid, [[0, '#f2b8a8'], [0.55, '#e8968e'], [1, '#d47a80']], { alpha: 0.6, y1: y - 20, y2: y + 20, texture: false })
    brush(mid, { w: 2.8 * s, color, close: true, amp: 1.3 })
    // 糖纸两头：用折线收口，不要画成两个叉
    for (const side of [-1, 1]) {
      const tip = [
        [x + side * 33 * s, y - 2 * s],
        [x + side * 66 * s, y - 18 * s],
        [x + side * 58 * s, y + 1 * s],
        [x + side * 70 * s, y + 19 * s],
        [x + side * 40 * s, y + 12 * s],
      ]
      fillShape(tip, '#f7dfd1', { alpha: 0.52, medium: 'watercolor' })
      brush(tip, { w: 2.2 * s, color, close: true, amp: 1.2 })
    }
    // 糖纸上的斜纹
    for (let i = -2; i <= 2; i += 1) {
      brush([[x + i * 11 * s, y - 15 * s], [x + i * 11 * s + 7 * s, y + 15 * s]], { w: 1.4 * s, color: '#fdf4e8', alpha: 0.45 })
    }
  }

  // ---------------------------------------------------------------- v5 场景物件
  function objHouse(x, y, s, color) {
    const w = 168 * s
    const h = 118 * s
    const wall = [[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]]
    fillShape(wall, '#f7ecda', { alpha: 0.75, medium: 'watercolor' })
    brush(wall, { w: 3.6 * s, color, close: true, amp: 1.2 })
    const roof = [[x - w / 2 - 18 * s, y - h / 2 + 2 * s], [x, y - h / 2 - 70 * s], [x + w / 2 + 18 * s, y - h / 2 + 2 * s]]
    fillShape(roof, '#e3a18a', { alpha: 0.72, medium: 'watercolor' })
    brush(roof, { w: 4 * s, color, close: true, amp: 1.6 })
    // 屋顶瓦片：几道顺着坡度的弧线，别让屋顶变成一块纯色三角
    const roofTopY = y - h / 2 - 70 * s
    const roofBaseY = y - h / 2 + 2 * s
    for (const t of [0.24, 0.42, 0.60, 0.77]) {
      const yy = roofTopY + (roofBaseY - roofTopY) * t
      const half = (w / 2 + 18 * s) * t
      brush([[x - half + 4 * s, yy + 2 * s], [x - half * 0.45, yy - 2 * s], [x + half * 0.45, yy - 2 * s], [x + half - 4 * s, yy + 2 * s]], { w: 1.2 * s, color: '#b97260', alpha: 0.48, amp: 0.8 })
    }
    // 墙角的淡阴影，给房子一点体积
    brush([[x - w / 2 + 5 * s, y - h / 2 + 8 * s], [x - w / 2 + 5 * s, y + h / 2 - 8 * s]], { w: 3 * s, color: '#c9ad8d', alpha: 0.28, amp: 0.7 })
    // 门和两扇窗
    const door = rectPts(x - 24 * s, y + 8 * s, 48 * s, 58 * s)
    fillShape(door, '#d6b58f', { alpha: 0.55, medium: 'watercolor' })
    brush(door, { w: 2.2 * s, color, close: true, amp: 0.8 })
    const knob = ellipsePts(x + 15 * s, y + 38 * s, 2.6 * s, 2.6 * s, 0, 8)
    fillShape(knob, '#b3834f', { alpha: 0.7 })
    for (const dx of [-56 * s, 56 * s]) {
      const win = rectPts(x + dx - 21 * s, y - 30 * s, 42 * s, 38 * s)
      fillShape(win, '#dcecf1', { alpha: 0.45, medium: 'watercolor' })
      brush(win, { w: 2 * s, color, close: true, amp: 0.7 })
      brush([[x + dx, y - 30 * s], [x + dx, y + 8 * s]], { w: 1.3 * s, color, alpha: 0.6 })
      brush([[x + dx - 21 * s, y - 11 * s], [x + dx + 21 * s, y - 11 * s]], { w: 1.3 * s, color, alpha: 0.6 })
      brush([[x + dx - 24 * s, y + 10 * s], [x + dx + 24 * s, y + 10 * s]], { w: 1.6 * s, color, alpha: 0.6 })
    }
    // 屋顶小烟囱和两缕烟
    const chimney = rectPts(x + 44 * s, y - h / 2 - 44 * s, 22 * s, 34 * s)
    fillShape(chimney, '#d9c2aa', { alpha: 0.5, medium: 'watercolor' })
    brush(chimney, { w: 2.2 * s, color, close: true, amp: 0.7 })
    for (let i = 0; i < 2; i += 1) {
      const sx = x + 55 * s
      const sy = y - h / 2 - 66 * s - i * 22 * s
      brush(ellipsePts(sx + i * 4 * s, sy, 9 * s, 6 * s, 0.2, 12), { w: 1 * s, color: '#b9a58d', alpha: 0.3, close: true, amp: 0.6 })
    }
  }

  function objTree(x, y, s, color) {
    const trunk = [[x - 14 * s, y + 92 * s], [x - 9 * s, y + 8 * s], [x + 10 * s, y + 8 * s], [x + 15 * s, y + 92 * s]]
    fillShape(trunk, '#c79b72', { alpha: 0.55, medium: 'watercolor' })
    brush(trunk, { w: 2.8 * s, color, close: true, amp: 1.2 })
    for (let i = 0; i < 3; i += 1) {
      brush([[x - 4 * s, y + 20 * s + i * 18 * s], [x + rr(-2, 6) * s, y + 34 * s + i * 18 * s]], { w: 1 * s, color: '#9a704e', alpha: 0.4 })
    }
    const crowns = [
      [x - 42 * s, y - 10 * s, 48 * s],
      [x + 18 * s, y - 26 * s, 55 * s],
      [x + 54 * s, y + 8 * s, 38 * s],
      [x - 4 * s, y + 16 * s, 48 * s],
    ]
    for (const [cx, cy, r] of crowns) {
      const pts = ellipsePts(cx, cy, r, r * 0.86, 0, 20)
      fillShape(pts, '#b9cf9f', { alpha: 0.55, medium: 'watercolor' })
      brush(pts, { w: 2.4 * s, color, close: true, amp: 1.4 })
    }
    // 树冠内部的叶簇和几道小枝，让树不是三团绿色椭圆
    for (let i = 0; i < 9; i += 1) {
      const cx = x + rr(-62, 70) * s
      const cy = y + rr(-44, 22) * s
      const r = rr(7, 16) * s
      brush(ellipsePts(cx, cy, r, r * 0.55, rr(-0.4, 0.4), 12), { w: 1 * s, color: '#7d9e69', alpha: 0.38, close: true, amp: 0.6 })
    }
    for (let i = 0; i < 3; i += 1) {
      brush([[x + rr(-20, 20) * s, y + 20 * s], [x + rr(-50, 50) * s, y - 22 * s], [x + rr(-58, 58) * s, y - 44 * s]], { w: 1.2 * s, color: '#8eac78', alpha: 0.5, amp: 1 })
    }
  }

  function objMountain(x, y, s, color) {
    const left = [[x - 170 * s, y + 72 * s], [x - 44 * s, y - 128 * s], [x + 42 * s, y + 72 * s]]
    const right = [[x - 8 * s, y + 72 * s], [x + 90 * s, y - 72 * s], [x + 190 * s, y + 72 * s]]
    fillShape(left, '#c8dbe1', { alpha: 0.52, medium: 'watercolor' })
    fillShape(right, '#dce9e8', { alpha: 0.5, medium: 'watercolor' })
    brush(left, { w: 3.4 * s, color, close: true, amp: 1.4 })
    brush(right, { w: 3 * s, color, close: true, amp: 1.2 })
    // 山脊线
    for (const [a, b] of [[left, 0.25], [left, 0.55], [right, 0.3], [right, 0.6]]) {
      const top = a[1]
      const base = a[0]
      brush([[top[0] + (base[0] - top[0]) * b, top[1] + (base[1] - top[1]) * b], [top[0] + (a[2][0] - top[0]) * b * 0.9, top[1] + (a[2][1] - top[1]) * b]], { w: 1.2 * s, color: '#7f9da8', alpha: 0.35, amp: 0.7 })
    }
    // 山顶的雪
    const snow = [[x - 78 * s, y - 78 * s], [x - 44 * s, y - 128 * s], [x - 16 * s, y - 88 * s], [x - 38 * s, y - 94 * s]]
    fillShape(snow, '#fbfaf4', { alpha: 0.65, medium: 'watercolor' })
    brush(snow, { w: 2 * s, color, close: true, amp: 0.7 })
    const snow2 = [[x + 58 * s, y - 37 * s], [x + 90 * s, y - 72 * s], [x + 116 * s, y - 34 * s]]
    fillShape(snow2, '#f8faf5', { alpha: 0.42, medium: 'watercolor' })
    brush(snow2, { w: 1.4 * s, color, alpha: 0.5, close: true, amp: 0.6 })
  }

  function objGrassland(x, y, s, color) {
    const w = 400 * s
    const h = 90 * s
    const field = [[x - w / 2, y + 20 * s], [x - w / 2 + 20 * s, y - 18 * s], [x + w / 2 - 28 * s, y - 6 * s], [x + w / 2, y + 24 * s], [x + w / 2 - 10 * s, y + h], [x - w / 2 + 14 * s, y + h]]
    fillShape(field, '#dce8c6', { alpha: 0.6, medium: 'watercolor' })
    brush(field, { w: 3.2 * s, color, close: true, amp: 1.3 })
    for (let i = 0; i < 14; i += 1) {
      const gx = x - w / 2 + 26 * s + i * 26 * s
      const gy = y + 8 * s + (i % 3) * 16 * s
      brush([[gx, gy + 30 * s], [gx - 4 * s, gy + 8 * s], [gx + 1 * s, gy + 18 * s], [gx + 8 * s, gy + 2 * s]], { w: 1.4 * s, color: '#89a96d', alpha: 0.65, amp: 1 })
    }
  }

  function objRoad(x, y, s, color) {
    const w = 300 * s
    const road = [[x - 30 * s, y - 20 * s], [x + 34 * s, y - 20 * s], [x + w / 2, y + 120 * s], [x - w / 2, y + 120 * s]]
    fillShape(road, '#f0dfc0', { alpha: 0.55, medium: 'watercolor' })
    brush(road, { w: 2.8 * s, color, close: true, amp: 1.1 })
    for (let i = 0; i < 6; i += 1) {
      const t = (i + 0.5) / 6
      const yy = y - 12 * s + t * 120 * s
      const half = 24 * s + t * 70 * s
      brush([[x - half * 0.55, yy], [x + half * 0.55, yy]], { w: 1.5 * s, color: '#c7a878', alpha: 0.5 })
    }
  }

  function objDesk(x, y, s, color) {
    const w = 260 * s
    const top = [[x - w / 2, y - 10 * s], [x + w / 2, y - 10 * s], [x + w / 2 + 10 * s, y + 20 * s], [x - w / 2 - 10 * s, y + 20 * s]]
    fillShape(top, '#e8cfa8', { alpha: 0.75, medium: 'watercolor' })
    brush(densePoly(top, 6), { w: 3.6 * s, color, close: true, amp: 0.9 })
    for (const dx of [-w / 2 + 18 * s, w / 2 - 18 * s]) {
      const leg = [[x + dx - 10 * s, y + 18 * s], [x + dx + 10 * s, y + 18 * s], [x + dx + 7 * s, y + 124 * s], [x + dx - 5 * s, y + 124 * s]]
      fillShape(leg, '#d8b88e', { alpha: 0.45, medium: 'watercolor' })
      brush(densePoly(leg, 5), { w: 2.2 * s, color, close: true, amp: 0.7 })
    }
    // 抽屉：桌沿下面一块浅浅的抽屉面
    const drawer = rectPts(x + 20 * s, y + 22 * s, 76 * s, 38 * s)
    fillShape(drawer, '#e6cca4', { alpha: 0.38, medium: 'watercolor' })
    brush(drawer, { w: 1.6 * s, color, close: true, alpha: 0.7, amp: 0.6 })
    brush([[x + 52 * s, y + 44 * s], [x + 52 * s, y + 50 * s]], { w: 1.2 * s, color, alpha: 0.5 })
    // 桌沿的一小道木纹
    for (let i = 0; i < 5; i += 1) {
      brush([[x - w / 2 + rr(6, 60) * s, y + rr(-4, 4) * s], [x + rr(-60, 60) * s, y + rr(-2, 8) * s], [x + w / 2 - rr(4, 30) * s, y + rr(-4, 6) * s]], { w: 1 * s, color: '#b58a62', alpha: 0.35, amp: 1 })
    }
  }

  function objChair(x, y, s, color) {
    const seat = [[x - 62 * s, y + 22 * s], [x + 62 * s, y + 22 * s], [x + 48 * s, y + 50 * s], [x - 48 * s, y + 50 * s]]
    fillShape(seat, '#e3c49a', { alpha: 0.55, medium: 'watercolor' })
    brush(densePoly(seat, 5), { w: 2.8 * s, color, close: true, amp: 0.8 })
    const back = [[x - 60 * s, y + 26 * s], [x - 54 * s, y - 82 * s], [x + 54 * s, y - 82 * s], [x + 60 * s, y + 26 * s]]
    fillShape(back, '#ecd7b2', { alpha: 0.42, medium: 'watercolor' })
    brush(densePoly(back, 5), { w: 2.8 * s, color, close: true, amp: 0.9 })
    // 靠背两条竖档
    brush([[x - 22 * s, y - 76 * s], [x - 22 * s, y + 20 * s]], { w: 1.8 * s, color, alpha: 0.55 })
    brush([[x + 22 * s, y - 76 * s], [x + 22 * s, y + 20 * s]], { w: 1.8 * s, color, alpha: 0.55 })
    for (const dx of [-42 * s, 42 * s]) {
      brush([[x + dx, y + 44 * s], [x + dx + 4 * s, y + 116 * s]], { w: 2.8 * s, color, alpha: 0.85, amp: 0.7 })
      brush([[x + dx - 10 * s, y + 112 * s], [x + dx + 14 * s, y + 112 * s]], { w: 1.8 * s, color, alpha: 0.7 })
    }
  }

  function objBed(x, y, s, color) {
    const w = 300 * s
    const mattress = [[x - w / 2, y - 16 * s], [x + w / 2, y - 16 * s], [x + w / 2 - 12 * s, y + 42 * s], [x - w / 2 + 12 * s, y + 42 * s]]
    fillShape(mattress, '#f6ead8', { alpha: 0.72, medium: 'watercolor' })
    brush(densePoly(mattress, 6), { w: 3.2 * s, color, close: true, amp: 0.9 })
    // 被子
    const quilt = [[x - w / 2 + 14 * s, y + 8 * s], [x + w / 2 - 26 * s, y + 8 * s], [x + w / 2 - 38 * s, y + 58 * s], [x - w / 2 + 32 * s, y + 58 * s]]
    fillShape(quilt, '#cfddea', { alpha: 0.48, medium: 'watercolor' })
    brush(densePoly(quilt, 5), { w: 2.2 * s, color, close: true, amp: 0.9 })
    // 被面格子
    for (let i = 0; i < 4; i += 1) {
      brush([[x - w / 2 + 36 * s + i * 54 * s, y + 14 * s], [x - w / 2 + 30 * s + i * 54 * s, y + 54 * s]], { w: 1 * s, color: '#93b3c5', alpha: 0.32 })
    }
    // 枕头
    const pillow = ellipsePts(x - w / 2 + 58 * s, y - 28 * s, 48 * s, 22 * s, -0.15, 18)
    fillShape(pillow, '#fff9ef', { alpha: 0.7, medium: 'watercolor' })
    brush(pillow, { w: 2 * s, color, close: true, amp: 0.7 })
    // 床头板和床腿
    brush([[x - w / 2 - 8 * s, y - 50 * s], [x - w / 2 - 4 * s, y + 42 * s]], { w: 2.6 * s, color, alpha: 0.6 })
    for (const dx of [-w / 2 + 20 * s, w / 2 - 24 * s]) {
      brush([[x + dx, y + 44 * s], [x + dx, y + 88 * s]], { w: 3 * s, color, alpha: 0.8 })
    }
  }

  function objBicycle(x, y, s, color) {
    const wheelY = y + 54 * s
    const r = 42 * s
    for (const dx of [-78 * s, 78 * s]) {
      brush(ellipsePts(x + dx, wheelY, r, r, 0, 26), { w: 2.8 * s, color, close: true, amp: 0.8 })
      brush(ellipsePts(x + dx, wheelY, r * 0.82, r * 0.82, 0, 22), { w: 1.2 * s, color, close: true, alpha: 0.45, amp: 0.5 })
      for (let i = 0; i < 8; i += 1) {
        const a = (Math.PI * 2 * i) / 8
        brush([[x + dx, wheelY], [x + dx + Math.cos(a) * r * 0.8, wheelY + Math.sin(a) * r * 0.8]], { w: 1 * s, color, alpha: 0.45 })
      }
    }
    // 车架
    const frame = [[x - 44 * s, wheelY], [x + 4 * s, wheelY - 64 * s], [x + 34 * s, wheelY - 58 * s], [x + 4 * s, wheelY + 2 * s]]
    brush(frame, { w: 3.6 * s, color: '#6f9bb8', close: true, amp: 0.9 })
    brush([[x - 72 * s, wheelY], [x - 44 * s, wheelY], [x + 4 * s, wheelY - 62 * s], [x + 76 * s, wheelY]], { w: 3 * s, color: '#6f9bb8', amp: 0.8 })
    // 车把和座椅
    brush([[x + 34 * s, wheelY - 58 * s], [x + 50 * s, wheelY - 88 * s], [x + 82 * s, wheelY - 96 * s]], { w: 2.6 * s, color: '#6f9bb8', amp: 0.8 })
    brush([[x - 12 * s, wheelY - 62 * s], [x - 30 * s, wheelY - 74 * s], [x + 8 * s, wheelY - 78 * s]], { w: 2.4 * s, color: '#8e735e', amp: 0.8 })
  }

  function objSea(x, y, s, color) {
    const w = 460 * s
    const band = [[x - w / 2, y - 6 * s], [x + w / 2, y - 6 * s], [x + w / 2, y + 118 * s], [x - w / 2, y + 118 * s]]
    fillShape(band, '#cfe4e8', { alpha: 0.55, medium: 'watercolor' })
    brush(band, { w: 2.6 * s, color, close: true, amp: 0.8 })
    for (let i = 0; i < 8; i += 1) {
      const px = x - w / 2 + 32 * s + i * 54 * s
      const py = y + 20 * s + (i % 3) * 26 * s
      brush([[px, py], [px + 12 * s, py - 8 * s], [px + 26 * s, py - 2 * s], [px + 38 * s, py + 4 * s]], { w: 1.8 * s, color: '#79a9b5', alpha: 0.55, amp: 1 })
    }
    // 海平线和几道白色浪
    brush([[x - w / 2, y - 6 * s], [x + w / 2, y - 6 * s]], { w: 2.4 * s, color: '#86b3ba', alpha: 0.6 })
    for (let i = 0; i < 4; i += 1) {
      brush([[x + rr(-180, 60) * s, y + rr(30, 90) * s], [x + rr(-150, 80) * s, y + rr(32, 92) * s], [x + rr(-120, 100) * s, y + rr(30, 88) * s]], { w: 1.2 * s, color: '#fbfaf3', alpha: 0.6 })
    }
  }

  function objDoor(x, y, s, color) {
    const frame = rectPts(x - 52 * s, y - 90 * s, 104 * s, 180 * s)
    fillShape(frame, '#f1e3cc', { alpha: 0.4, medium: 'watercolor' })
    brush(frame, { w: 3 * s, color, close: true, amp: 1 })
    const inner = rectPts(x - 40 * s, y - 78 * s, 80 * s, 168 * s)
    brush(inner, { w: 1.8 * s, color, close: true, alpha: 0.65, amp: 0.7 })
    const knob = ellipsePts(x + 24 * s, y + 8 * s, 5 * s, 5 * s, 0, 10)
    fillShape(knob, '#c9a15d', { alpha: 0.75 })
    brush(knob, { w: 1.2 * s, color, close: true, amp: 0.4 })
  }

  function objFence(x, y, s, color) {
    const w = 260 * s
    for (let i = 0; i < 5; i += 1) {
      const px = x - w / 2 + i * (w / 4)
      brush([[px, y + 52 * s], [px + rr(-2, 2) * s, y - 38 * s]], { w: 3.2 * s, color, alpha: 0.8, amp: 0.8 })
      brush([[px - 10 * s, y - 30 * s], [px + 10 * s, y - 30 * s]], { w: 1.8 * s, color, alpha: 0.6 })
    }
    for (const dy of [-16 * s, 22 * s]) {
      brush([[x - w / 2, y + dy], [x + w / 2, y + dy]], { w: 2.6 * s, color, alpha: 0.75, amp: 0.9 })
    }
  }

  function objStone(x, y, s, color) {
    const pts = [[x - 42 * s, y + 18 * s], [x - 28 * s, y - 18 * s], [x + 6 * s, y - 30 * s], [x + 34 * s, y - 8 * s], [x + 30 * s, y + 24 * s], [x - 10 * s, y + 30 * s]]
    fillShape(pts, '#d8d2c7', { alpha: 0.55, medium: 'watercolor' })
    brush(pts, { w: 2.6 * s, color, close: true, amp: 1.2 })
    brush([[x - 22 * s, y + 2 * s], [x + 4 * s, y - 18 * s], [x + 18 * s, y + 4 * s]], { w: 1.2 * s, color, alpha: 0.45, amp: 0.8 })
  }

  function objKite(x, y, s, color) {
    const pts = [[x, y - 58 * s], [x + 48 * s, y], [x, y + 58 * s], [x - 48 * s, y]]
    fillShape(pts, '#e9b3a1', { alpha: 0.55, medium: 'watercolor' })
    brush(pts, { w: 2.8 * s, color, close: true, amp: 1.1 })
    brush([[x, y - 58 * s], [x, y + 58 * s]], { w: 1.4 * s, color, alpha: 0.6 })
    brush([[x - 48 * s, y], [x + 48 * s, y]], { w: 1.4 * s, color, alpha: 0.6 })
    // 风筝线
    brush([[x, y + 58 * s], [x + 6 * s, y + 90 * s], [x - 4 * s, y + 126 * s], [x + 10 * s, y + 160 * s]], { w: 1.2 * s, color, alpha: 0.65, amp: 2 })
    for (let i = 0; i < 3; i += 1) {
      const yy = y + 96 * s + i * 20 * s
      brush([[x, yy], [x + 12 * s, yy + 10 * s], [x + 18 * s, yy + 2 * s]], { w: 1 * s, color, alpha: 0.55 })
    }
  }

  function objShelf(x, y, s, color) {
    const w = 180 * s
    const h = 190 * s
    const frame = rectPts(x - w / 2, y - h / 2, w, h)
    fillShape(frame, '#ead8bd', { alpha: 0.45, medium: 'watercolor' })
    brush(frame, { w: 3 * s, color, close: true, amp: 1 })
    for (const dy of [-h / 2 + h / 3, -h / 2 + h * 2 / 3]) {
      brush([[x - w / 2 + 4 * s, y + dy], [x + w / 2 - 4 * s, y + dy]], { w: 3 * s, color, alpha: 0.75 })
    }
    for (let i = 0; i < 4; i += 1) {
      const bx = x - w / 2 + 16 * s + i * 40 * s
      const bh = 44 * s + (i % 2) * 10 * s
      const book = rectPts(bx, y + h / 6 - bh, 22 * s, bh)
      fillShape(book, i % 2 ? '#c9d9c0' : '#e3b1a1', { alpha: 0.55, medium: 'watercolor' })
      brush(book, { w: 1.6 * s, color, close: true, amp: 0.6 })
    }
  }

  function objPhone(x, y, s, color) {
    const body = rectPts(x - 34 * s, y - 60 * s, 68 * s, 120 * s)
    fillShape(body, '#dbe4e8', { alpha: 0.6, medium: 'watercolor' })
    brush(body, { w: 2.4 * s, color, close: true, amp: 0.8 })
    const screen = rectPts(x - 25 * s, y - 46 * s, 50 * s, 86 * s)
    fillShape(screen, '#f4f1e6', { alpha: 0.55, medium: 'watercolor' })
    brush(screen, { w: 1.3 * s, color, close: true, alpha: 0.6 })
    brush([[x - 8 * s, y + 48 * s], [x + 8 * s, y + 48 * s]], { w: 1.4 * s, color, alpha: 0.6 })
  }

  const OBJECT_DRAW = {
    cloud: objCloud, rain: objRain, window: objWindow, cup: objCup, lamp: objLamp, pillow: objPillow,
    stars: objStars, flower: objFlower, fish: objFish, shell: objShell, origami: objOrigami,
    note: objNote, book: objBook, pen: objPen, yarn: objYarn, balloon: objBalloon, bread: objBread,
    moon: objMoon, puddle: objPuddle, umbrella: objUmbrella, chicken: objChicken,
    tailpillow: objTailPillow, sun: objSun, candy: objCandy,
    house: objHouse, tree: objTree, mountain: objMountain, grassland: objGrassland, road: objRoad,
    desk: objDesk, chair: objChair, bed: objBed, bicycle: objBicycle, sea: objSea,
    door: objDoor, fence: objFence, stone: objStone, kite: objKite, shelf: objShelf, phone: objPhone,
  }

  const OBJ_SLOTS = {
    'left-low': [[0.64, 0.42], [0.82, 0.5], [0.7, 0.64], [0.86, 0.7], [0.62, 0.8], [0.8, 0.86]],
    'center-bust': [[0.14, 0.28], [0.86, 0.26], [0.1, 0.48], [0.9, 0.46], [0.16, 0.66], [0.84, 0.62]],
    'right-full': [[0.22, 0.34], [0.38, 0.42], [0.16, 0.52], [0.3, 0.6], [0.2, 0.72], [0.4, 0.78]],
    'top-left': [[0.62, 0.5], [0.8, 0.6], [0.56, 0.68], [0.86, 0.72], [0.68, 0.82], [0.9, 0.42]],
    diagonal: [[0.2, 0.32], [0.52, 0.38], [0.14, 0.52], [0.36, 0.6], [0.2, 0.78], [0.56, 0.72]],
    'back-view': [[0.18, 0.34], [0.84, 0.34], [0.12, 0.5], [0.88, 0.5], [0.22, 0.72], [0.78, 0.72]],
  }

  function drawObjects(slots) {
    const objs = plan.objects || []
    const positions = OBJ_SLOTS[plan.composition] || OBJ_SLOTS['left-low']
    objs.forEach((id, i) => {
      const fn = OBJECT_DRAW[id]
      if (!fn) return
      const slot = positions[i % positions.length]
      const jitter = rr(-18, 18)
      const x = slot[0] * W + jitter
      const y = slot[1] * H + jitter
      const s = rr(1.05, 1.35)
      fn(x, y, s, P.soft)
    })
  }

  // ---------------------------------------------------------------- v5 场景层
  // 模型只给 place / weather / items / role，位置由本地规划器和这里决定。
  const SCENE_LAYOUT = {
    sun: { x: 0.14, y: 0.17, s: 1.05 },
    moon: { x: 0.83, y: 0.16, s: 1.0 },
    stars: { x: 0.7, y: 0.16, s: 0.85 },
    cloud: { x: 0.5, y: 0.16, s: 0.95 },
    rain: { x: 0.4, y: 0.2, s: 1.0 },
    kite: { x: 0.72, y: 0.22, s: 0.9 },
    balloon: { x: 0.24, y: 0.28, s: 0.9 },
    mountain: { x: 0.5, y: 0.34, s: 1.45 },
    house: { x: 0.74, y: 0.36, s: 1.15 },
    tree: { x: 0.18, y: 0.58, s: 1.05 },
    fence: { x: 0.3, y: 0.7, s: 0.95 },
    door: { x: 0.82, y: 0.55, s: 0.95 },
    shelf: { x: 0.18, y: 0.5, s: 0.95 },
    window: { x: 0.82, y: 0.36, s: 1.0 },
    lamp: { x: 0.8, y: 0.52, s: 0.85 },
    grassland: { x: 0.5, y: 0.8, s: 2.15 },
    sea: { x: 0.5, y: 0.77, s: 2.1 },
    road: { x: 0.5, y: 0.8, s: 1.7 },
    flower: { x: 0.28, y: 0.78, s: 0.9 },
    stone: { x: 0.38, y: 0.8, s: 0.85 },
    desk: { x: 0.68, y: 0.76, s: 1.18 },
    chair: { x: 0.54, y: 0.68, s: 1.02 },
    bed: { x: 0.5, y: 0.88, s: 1.18 },
    pillow: { x: 0.36, y: 0.8, s: 0.95 },
    bicycle: { x: 0.64, y: 0.79, s: 1.05 },
    cup: { x: 0.7, y: 0.66, s: 0.9 },
    book: { x: 0.62, y: 0.7, s: 0.9 },
    pen: { x: 0.76, y: 0.71, s: 0.8 },
    phone: { x: 0.72, y: 0.64, s: 0.85 },
  }

  const ROLE_SLOTS = {
    sky: [[0.18, 0.16], [0.82, 0.18], [0.5, 0.1], [0.9, 0.3]],
    far: [[0.74, 0.36], [0.28, 0.38], [0.5, 0.3]],
    ground: [[0.5, 0.8], [0.32, 0.83], [0.7, 0.8]],
    mid: [[0.18, 0.58], [0.82, 0.6], [0.3, 0.65], [0.72, 0.62]],
    front: [[0.7, 0.78], [0.3, 0.8], [0.82, 0.6], [0.18, 0.62]],
  }

  function sceneItems() {
    return Array.isArray(plan.scene?.items) ? plan.scene.items : []
  }

  function drawSceneBackdrop() {
    const place = plan.scene?.place
    if (!place) return
    ctx.save()
    const sky = ['grassland', 'mountain', 'street', 'beach']
    if (sky.includes(place)) {
      ctx.globalAlpha = 0.36
      ctx.fillStyle = place === 'beach' ? '#e8f3f2' : '#eaf2f3'
      ctx.fillRect(0, 0, W, H * 0.62)
      ctx.globalAlpha = place === 'beach' ? 0.3 : 0.24
      ctx.fillStyle = place === 'beach' ? '#d8e9e8' : '#e5eccf'
      ctx.fillRect(0, H * 0.58, W, H * 0.42)
      ctx.globalAlpha = 0.32
      ctx.strokeStyle = place === 'beach' ? '#8bb9c1' : '#9aaf86'
      ctx.lineWidth = 2.2
      ctx.beginPath()
      ctx.moveTo(0, H * 0.62 + rr(-5, 5))
      ctx.bezierCurveTo(W * 0.3, H * 0.61 + rr(-8, 8), W * 0.7, H * 0.63 + rr(-8, 8), W, H * 0.62 + rr(-5, 5))
      ctx.stroke()
    } else if (['room', 'desk', 'bed', 'window'].includes(place)) {
      ctx.globalAlpha = 0.2
      ctx.fillStyle = '#f5f0e4'
      ctx.fillRect(0, 0, W, H * 0.64)
      ctx.globalAlpha = 0.22
      ctx.fillStyle = '#e7dac8'
      ctx.fillRect(0, H * 0.64, W, H * 0.36)
      ctx.globalAlpha = 0.3
      ctx.strokeStyle = '#b9a98f'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, H * 0.64)
      ctx.lineTo(W, H * 0.64)
      ctx.stroke()
    } else if (place === 'abstract') {
      ctx.globalAlpha = 0.18
      ctx.fillStyle = '#f1efe4'
      ctx.fillRect(0, 0, W, H)
      ctx.globalAlpha = 0.2
      ctx.fillStyle = '#dfe8ea'
      ctx.beginPath()
      ctx.ellipse(W * 0.5, H * 0.42, W * 0.6, H * 0.28, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  function drawSceneItem(item, role, index) {
    const fn = OBJECT_DRAW[item.id]
    if (!fn) return
    if (plan.pose === 'bike' && item.id === 'bicycle') return
    const layout = SCENE_LAYOUT[item.id]
    let x
    let y
    let s
    if (layout) {
      x = layout.x * W
      y = layout.y * H
      s = (layout.s || 0.95) * (Number(item.scale) || 1)
      // 天空小物不要压在手写文字上：文字在哪边，就把太阳/月亮/星星挪到另一边。
      const textLeft = Number(plan.textBox?.x || 0) < 0.5
      if (role === 'sky' && ['sun', 'moon', 'stars', 'kite', 'balloon'].includes(item.id)) {
        if ((textLeft && layout.x < 0.5) || (!textLeft && layout.x > 0.5)) x = W * (1 - layout.x)
      }
    } else {
      const slots = ROLE_SLOTS[role] || ROLE_SLOTS.mid
      const slot = slots[index % slots.length]
      x = slot[0] * W
      y = slot[1] * H
      s = 0.95 * (Number(item.scale) || 1)
    }
    const furniture = ['desk', 'chair', 'bed', 'shelf', 'door', 'fence', 'stone', 'phone', 'book', 'pen', 'cup', 'window']
    const tint = role === 'sky'
      ? P.second
      : role === 'ground'
        ? P.soft
        : furniture.includes(item.id)
          ? '#b9865c'
          : P.accent
    fn(x + rr(-12, 12), y + rr(-10, 10), s, tint)
  }

  function drawSceneLayer(role) {
    const items = sceneItems().filter((item) => item.role === role)
    items.forEach((item, i) => drawSceneItem(item, role, i))
  }

  // ---------------------------------------------------------------- 角色
  // 画的是「蛋蛋本人」：深蓝长发 + 青蓝发梢、鳍耳 + 白蕾丝女仆头饰、
  // 藏青女仆裙 + 奶白围裙 + 鲸鱼刺绣、鲸尾 + 珍珠链、白袜 + 藏青小皮鞋。
  const CHAR = {
    skin: DAN.skin,
    hair: DAN.hair,
    hair2: DAN.hairDeep,
    dress: DAN.dress,
    apron: DAN.apron,
    ink: DAN.line,
  }

  function rectPts(x, y, w, h) {
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
  }

  function charLine(points, opt) {
    const o = opt || {}
    brush(points, {
      w: o.w == null ? 2.2 : o.w,
      color: o.color || DAN.line,
      alpha: o.alpha == null ? 0.85 : o.alpha,
      amp: o.amp == null ? 1.9 : o.amp,
      close: o.close,
      kind: o.kind || 'ink',
      seed: o.seed,
      broken: o.broken,
    })
  }

  function charFill(points, color, opt) {
    fillShape(points, color, { alpha: 0.9, medium: 'watercolor', ...(opt || {}) })
  }

  function hairGradient(points, alpha, from, to) {
    fillGradient(points, [
      [0, DAN.hairDeep],
      [0.2, DAN.hairShade],
      [0.44, DAN.hair],
      [0.68, DAN.hairMid],
      [0.86, DAN.hairLight],
      [1, DAN.hairTip],
    ], {
      alpha: alpha == null ? 0.97 : alpha,
      y1: from == null ? -130 : from,
      y2: to == null ? 280 : to,
      textureColor: DAN.hairDeep,
      dots: 110,
    })
  }

  // ---------------------------------------------------------------- 角色层 v4：高质量手绘角色底稿
  // 复杂动漫角色不再用几何图元硬拼。角色本体是项目内随仓库分发的透明手绘稿，
  // 画布负责纸张、草稿、场景、文字、颗粒和落款；底稿缺失时自动回退到 v3。
  const SPRITE_FILES = Object.freeze({
    'front-happy': 'front-happy.png',
    'front-sad': 'front-sad.png',
    'front-sleepy': 'front-sleepy.png',
    'front-excited': 'front-excited.png',
    'front-blank': 'front-blank.png',
    'front-wronged': 'front-wronged.png',
    'front-proud': 'front-proud.png',
    'front-calm': 'front-calm.png',
    'sit-happy': 'sit-happy.png',
    'sit-sad': 'sit-sad.png',
    'sit-sleepy': 'sit-sleepy.png',
    'sit-calm': 'sit-calm.png',
    'back-happy': 'back-happy.png',
    'back-sad': 'back-sad.png',
    'curl-wronged': 'curl-wronged.png',
    'peek-blank': 'peek-blank.png',
    'sleep-sleepy': 'sleep-sleepy.png',
    'walk-calm': 'walk-calm.png',
    'walk-happy': 'walk-happy.png',
    'walk-sad': 'walk-sad.png',
    'chair-calm': 'chair-calm.png',
    'chair-happy': 'chair-happy.png',
    'chair-sad': 'chair-sad.png',
    'floor-calm': 'floor-calm.png',
    'floor-happy': 'floor-happy.png',
    'floor-sad': 'floor-sad.png',
    'tummy-calm': 'tummy-calm.png',
    'tummy-happy': 'tummy-happy.png',
    'tummy-sad': 'tummy-sad.png',
    'hold-calm': 'hold-calm.png',
    'hold-happy': 'hold-happy.png',
    'hold-sad': 'hold-sad.png',
    'bike-calm': 'bike-calm.png',
    'bike-happy': 'bike-happy.png',
    'bike-sad': 'bike-sad.png',
  })
  const spriteCache = new Map()
  const NEW_POSES = ['walk', 'chair', 'floor', 'tummy', 'hold', 'bike']

  function spriteKeyFor(mood, pose, bust) {
    if (NEW_POSES.includes(pose)) {
      const variant = mood === 'happy' || mood === 'excited' || mood === 'proud'
        ? 'happy'
        : mood === 'sad' || mood === 'wronged'
          ? 'sad'
          : 'calm'
      return `${pose}-${variant}`
    }
    if (pose === 'peek') return 'peek-blank'
    if (pose === 'back') return mood === 'sad' || mood === 'wronged' ? 'back-sad' : 'back-happy'
    if (pose === 'curl') return 'curl-wronged'
    if (pose === 'sit') {
      if (mood === 'happy' || mood === 'excited') return 'sit-happy'
      if (mood === 'sad' || mood === 'wronged') return 'sit-sad'
      if (mood === 'sleepy' || mood === 'blank') return 'sit-sleepy'
      return 'sit-calm'
    }
    if (pose === 'wave') return 'front-excited'
    if (pose === 'sleep') return 'sleep-sleepy'
    const frontKey = `front-${mood}`
    return SPRITE_FILES[frontKey] ? frontKey : 'front-calm'
  }

  function spriteFor(mood, pose, bust) {
    const key = spriteKeyFor(mood, pose, bust)
    const img = spriteCache.get(key)
    if (img) return img
    // 某一种表情没生成时，优先借最接近的同姿势底稿
    const fallback = NEW_POSES.includes(pose)
      ? `${pose}-calm`
      : pose === 'sit' ? 'sit-calm' : pose === 'back' ? 'back-happy' : 'front-calm'
    return spriteCache.get(fallback) || null
  }

  function drawSpriteShadow(dx, dy, w, h) {
    ctx.save()
    ctx.globalAlpha = 0.2
    ctx.fillStyle = CHIBI.shadow
    ctx.beginPath()
    ctx.ellipse(dx, dy + h - 8, w * 0.46, Math.max(10, h * 0.035), 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  function drawSpriteCharacter(dx, dy, scale, rot, o) {
    const mood = plan.mood.key
    const pose = plan.pose || 'stand'
    const bust = Boolean(o && o.bust)
    const img = spriteFor(mood, pose, bust)
    if (!img) return false
    const units = pose === 'sit'
      ? 420
      : pose === 'curl'
        ? 380
        : pose === 'peek'
          ? 225
          : pose === 'sleep' || pose === 'tummy'
            ? 300
            : pose === 'chair' || pose === 'floor'
              ? 390
              : 420
    const h = (bust && pose !== 'peek' ? 470 : units) * scale
    const w = h * img.width / img.height
    const top = pose === 'peek'
      ? H * 0.6
      : pose === 'sleep'
        ? H * 0.63
        : pose === 'tummy'
          ? H * 0.54
          : pose === 'bike'
            ? H * 0.37
            : dy
    if (!bust && pose !== 'peek' && pose !== 'back') drawSpriteShadow(dx, top, w, h)
    ctx.save()
    ctx.translate(dx, top)
    ctx.rotate(((rot || 0) * Math.PI) / 180)
    ctx.globalAlpha = 0.97
    ctx.drawImage(img, -w / 2, 0, w, h)
    ctx.restore()
    return true
  }

  // ---------------------------------------------------------------- 角色层 v3：兜底几何 chibi

  // 这一层不再使用 v2 的渐变玩偶脸，改成“厚描边 + 平涂 + 彩铅颗粒”的动画手稿语言。
  const CHIBI = Object.freeze({
    ink: '#33386b',
    inkSoft: '#596096',
    hairDeep: '#405097',
    hair: '#6d80c6',
    hairMid: '#8295d6',
    hairLight: '#b2c1ec',
    hairTip: '#d8e0f6',
    skin: '#f8e1db',
    skinShade: '#ecc3be',
    blush: '#efa9a6',
    dress: '#48588f',
    dressDark: '#313c6f',
    dressLight: '#6274b2',
    apron: '#fbf6e8',
    apronShade: '#e6ddcc',
    lace: '#fffdf5',
    ribbon: '#5f74bd',
    ribbonDark: '#44558f',
    eye: '#6f84c9',
    eyeDeep: '#4d61a5',
    pupil: '#252b55',
    tail: '#8194d1',
    tailLight: '#aebce8',
    shadow: '#7180a9',
  })

  function v3Fill(points, color, alpha) {
    charFill(points, color, { alpha: alpha == null ? 0.95 : alpha, medium: 'watercolor' })
  }

  function v3Line(points, w, opt) {
    const o = opt || {}
    brush(points, {
      w: w == null ? 2.4 : w,
      color: o.color || CHIBI.ink,
      close: Boolean(o.close),
      alpha: o.alpha == null ? 0.94 : o.alpha,
      amp: o.amp == null ? 1.6 : o.amp,
      double: o.double !== false,
      doubleShift: 1.7,
      seed: o.seed || 0,
    })
  }

  function v3Ellipse(cx, cy, rx, ry, rot, n) {
    return ellipsePts(cx, cy, rx, ry, rot || 0, n || 18)
  }

  function v3Ribbon(cx, cy, w, h, color, rot) {
    const r = rot || 0
    const c = Math.cos(r)
    const s = Math.sin(r)
    const tp = (x, y) => [cx + x * c - y * s, cy + x * s + y * c]
    const tailL = [tp(-w * 0.2, h * 0.15), tp(-w * 0.58, h * 0.95), tp(-w * 0.08, h * 0.66)]
    const tailR = [tp(w * 0.2, h * 0.15), tp(w * 0.58, h * 0.95), tp(w * 0.08, h * 0.66)]
    v3Fill(tailL, color, 0.92)
    v3Fill(tailR, color, 0.92)
    v3Line(tailL, 1.2, { close: true, color: CHIBI.inkSoft, alpha: 0.5 })
    v3Line(tailR, 1.2, { close: true, color: CHIBI.inkSoft, alpha: 0.5 })
    // 圆润的蝴蝶结耳，不要做成猫耳三角
    const loopL = v3Ellipse(cx - w * 0.46, cy - h * 0.08, w * 0.54, h * 0.56, r + 0.12, 16)
    const loopR = v3Ellipse(cx + w * 0.46, cy - h * 0.08, w * 0.54, h * 0.56, r - 0.12, 16)
    v3Fill(loopL, color, 0.96)
    v3Fill(loopR, color, 0.96)
    softShade(loopL, CHIBI.ribbonDark, 0.2, { x: cx - w * 0.5, y: cy + h * 0.2, rx: w * 0.4, ry: h * 0.3 })
    softShade(loopR, CHIBI.ribbonDark, 0.2, { x: cx + w * 0.5, y: cy + h * 0.2, rx: w * 0.4, ry: h * 0.3 })
    v3Line(loopL, 1.4, { close: true, color: CHIBI.inkSoft })
    v3Line(loopR, 1.4, { close: true, color: CHIBI.inkSoft })
    const knot = v3Ellipse(cx, cy, w * 0.18, h * 0.2, r, 14)
    v3Fill(knot, CHIBI.ribbonDark, 0.96)
    v3Line(knot, 1.2, { close: true, color: CHIBI.ink })
  }

  function drawChibiShadow(R, bodyH, legH, pose, bust) {
    if (bust) return
    let y = bodyH + legH + 12
    let rx = R * 0.86
    if (pose === 'sit') { y = bodyH + legH * 0.72; rx = R * 1.0 } else if (pose === 'curl') { y = bodyH + legH * 0.38; rx = R * 0.72 }
    const sh = v3Ellipse(0, y, rx, R * 0.14, 0, 22)
    ctx.save()
    ctx.globalAlpha = 0.2
    ctx.fillStyle = CHIBI.shadow
    ctx.fill(polyPath(sh))
    ctx.restore()
    for (let i = 0; i < 4; i += 1) {
      brush([[-(rx * 0.7) + i * rx * 0.34, y + 3], [-(rx * 0.4) + i * rx * 0.34, y + 8]], { w: 1.2, color: CHIBI.inkSoft, alpha: 0.22, amp: 1.1 })
    }
  }

  function drawChibiHairBack(R, isBack) {
    const mass = catmull([
      [-R * 0.86, -R * 0.58], [-R * 1.0, R * 0.12], [-R * 0.96, R * 1.0],
      [-R * 0.82, R * 1.5], [-R * 0.52, R * 1.8], [0, R * 1.92],
      [R * 0.54, R * 1.8], [R * 0.82, R * 1.48], [R * 0.98, R * 1.0],
      [R * 1.0, R * 0.1], [R * 0.84, -R * 0.6], [R * 0.3, -R * 1.04],
      [-R * 0.3, -R * 1.04],
    ], true, 8)
    v3Fill(mass, CHIBI.hair, 0.97)
    softShade(mass, CHIBI.hairDeep, 0.34, { x: 0, y: R * 1.35, rx: R * 0.92, ry: R * 0.6 })
    v3Line(mass, 2.8, { close: true })
    // 外缘的波浪发束：不是一颗头盔
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i += 1) {
        const sx = side * (R * (0.62 + i * 0.11))
        const sy = -R * 0.4 + i * R * 0.12
        brush([[sx, sy], [side * R * (0.76 + i * 0.06), R * 0.3], [side * R * (0.68 + i * 0.04), R * 0.95], [side * R * (0.48 + i * 0.07), R * 1.5]], {
          w: 2.2, color: CHIBI.inkSoft, alpha: 0.38, amp: 2.1,
        })
      }
    }
    // 发丝高光：几片淡色，不用塑料渐变
    for (let i = 0; i < 5; i += 1) {
      const hx = -R * 0.7 + i * R * 0.34
      brush([[hx, -R * 0.2], [hx + R * 0.16, R * 0.24], [hx + R * 0.08, R * 0.8]], { w: 0.9, color: CHIBI.hairLight, alpha: 0.34, amp: 1.1 })
    }
    if (isBack) {
      // 背影：后脑一大块发，压住肩背
      const cap = v3Ellipse(0, R * 0.05, R * 0.8, R * 0.92, 0, 22)
      v3Fill(cap, CHIBI.hair, 0.98)
      softShade(cap, CHIBI.hairDeep, 0.28, { x: 0, y: R * 0.4, rx: R * 0.7, ry: R * 0.5 })
      v3Line(cap, 2.4, { close: true })
      for (let i = -2; i <= 2; i += 1) {
        brush([[i * R * 0.13, -R * 0.3], [i * R * 0.1, R * 0.35], [i * R * 0.06, R * 0.9]], { w: 1.5, color: CHIBI.hairLight, alpha: 0.4, amp: 1.3 })
      }
    }
  }

  function drawChibiTail(R, isBack) {
    const body = catmull([
      [R * 0.72, R * 2.0], [R * 0.92, R * 1.98], [R * 1.12, R * 1.9],
      [R * 1.26, R * 1.74], [R * 1.32, R * 1.58], [R * 1.22, R * 1.52],
    ], true, 8)
    v3Fill(body, CHIBI.tail, 0.97)
    v3Line(body, 2.2, { close: true, color: CHIBI.inkSoft })
    const l1 = catmull([[R * 1.24, R * 1.54], [R * 1.48, R * 1.3], [R * 1.6, R * 1.44], [R * 1.46, R * 1.68], [R * 1.3, R * 1.62]], true, 8)
    const l2 = catmull([[R * 1.25, R * 1.6], [R * 1.46, R * 1.84], [R * 1.56, R * 1.74], [R * 1.4, R * 1.56]], true, 8)
    v3Fill(l1, CHIBI.tailLight, 0.96)
    v3Fill(l2, CHIBI.tail, 0.96)
    v3Line(l1, 2.2, { close: true, color: CHIBI.inkSoft })
    v3Line(l2, 2.2, { close: true, color: CHIBI.inkSoft })
    brush([[R * 1.28, R * 1.64], [R * 1.46, R * 1.46], [R * 1.4, R * 1.34]], { w: 1.2, color: CHIBI.apron, alpha: 0.45 })
    for (const [px, py] of [[R * 0.93, R * 1.9], [R * 0.8, R * 1.98]]) {
      const pearl = v3Ellipse(px, py, 5, 6, 0, 12)
      v3Fill(pearl, CHIBI.lace, 0.98)
      v3Line(pearl, 0.9, { close: true, color: CHIBI.inkSoft })
    }
  }

  function drawChibiLegs(R, bodyH, legH, pose) {
    if (pose === 'sit' || pose === 'curl') {
      for (const side of [-1, 1]) {
        const hipX = side * R * 0.19
        const kneeX = side * R * 0.44
        const ankleX = side * R * 0.38
        const kneeY = bodyH + (pose === 'curl' ? 10 : 38)
        const ankleY = bodyH + (pose === 'curl' ? 56 : 84)
        const leg = catmull([[hipX - R * 0.09, bodyH - 10], [hipX + R * 0.09, bodyH - 10], [kneeX + R * 0.09, kneeY], [ankleX + R * 0.08, ankleY], [ankleX - R * 0.08, ankleY], [kneeX - R * 0.09, kneeY]], true, 8)
        v3Fill(leg, CHIBI.skin, 0.97)
        v3Line(leg, 1.3, { close: true, color: CHIBI.inkSoft, alpha: 0.55 })
        const sock = v3Ellipse(ankleX, ankleY + 8, R * 0.13, R * 0.12, 0, 14)
        v3Fill(sock, CHIBI.lace, 0.97)
        v3Line(sock, 1.4, { close: true, color: CHIBI.inkSoft })
        const shoe = v3Ellipse(ankleX + side * 5, ankleY + 20, R * 0.15, R * 0.09, side * 0.06, 14)
        v3Fill(shoe, CHIBI.dressDark, 0.97)
        v3Line(shoe, 1.6, { close: true })
      }
      return
    }
    for (const side of [-1, 1]) {
      const x = side * R * 0.2
      const topY = bodyH - 4
      const ankleY = bodyH + legH - 20
      const leg = catmull([[x - R * 0.075, topY], [x + R * 0.075, topY], [x + side * R * 0.02 + R * 0.06, ankleY], [x + side * R * 0.02 - R * 0.06, ankleY]], true, 8)
      v3Fill(leg, CHIBI.skin, 0.97)
      v3Line(leg, 1.3, { close: true, color: CHIBI.inkSoft, alpha: 0.5 })
      const sock = catmull([[x + side * R * 0.02 - R * 0.1, ankleY - R * 0.28], [x + side * R * 0.02 + R * 0.1, ankleY - R * 0.28], [x + side * R * 0.02 + R * 0.11, ankleY + R * 0.04], [x + side * R * 0.02 - R * 0.11, ankleY + R * 0.04]], true, 8)
      v3Fill(sock, CHIBI.lace, 0.97)
      v3Line(sock, 1.2, { close: true, color: CHIBI.inkSoft })
      brush([[x + side * R * 0.02 - R * 0.1, ankleY - R * 0.2], [x + side * R * 0.02 + R * 0.1, ankleY - R * 0.2]], { w: 0.8, color: CHIBI.inkSoft, alpha: 0.3 })
      const shoe = v3Ellipse(x + side * R * 0.04, ankleY + 10, R * 0.15, R * 0.09, side * 0.04, 16)
      v3Fill(shoe, CHIBI.dressDark, 0.97)
      v3Line(shoe, 1.6, { close: true })
      brush([[x + side * R * 0.04 - R * 0.1, ankleY + 2], [x + side * R * 0.04 + R * 0.1, ankleY + 3]], { w: 2.0, color: CHIBI.dressLight, alpha: 0.45 })
    }
  }

  function drawChibiBackHairOverlay(R, bodyH) {
    const panel = catmull([
      [-R * 0.62, R * 0.35], [-R * 0.72, R * 1.25], [-R * 0.42, bodyH + 10],
      [0, bodyH + 18], [R * 0.42, bodyH + 10], [R * 0.72, R * 1.25], [R * 0.62, R * 0.35],
    ], true, 8)
    v3Fill(panel, CHIBI.hair, 0.97)
    softShade(panel, CHIBI.hairDeep, 0.3, { x: 0, y: bodyH, rx: R * 0.6, ry: R * 0.5 })
    v3Line(panel, 2.4, { close: true })
    for (let i = -2; i <= 2; i += 1) {
      brush([[i * R * 0.13, R * 0.5], [i * R * 0.1, R * 1.3], [i * R * 0.06, bodyH + 6]], { w: 1.4, color: CHIBI.hairLight, alpha: 0.36, amp: 1.4 })
    }
  }

  function drawChibiDress(R, bodyH, bust, isBack) {
    const shoulderY = R * 1.02
    const waistY = R * 1.62
    const hemY = bodyH
    const torsoW = R * 0.4
    // 深色 A 字短裙：收窄一点，别把角色画成一只蓝色蘑菇
    const skirt = catmull([
      [-torsoW * 0.9, waistY - 4], [-R * 0.56, waistY + R * 0.18], [-R * 0.8, hemY],
      [0, hemY + R * 0.06], [R * 0.8, hemY], [R * 0.56, waistY + R * 0.18], [torsoW * 0.9, waistY - 4],
    ], true, 8)
    v3Fill(skirt, CHIBI.dress, 0.96)
    softShade(skirt, CHIBI.dressDark, 0.32, { x: 0, y: hemY - 8, rx: R * 0.85, ry: R * 0.32 })
    v3Line(skirt, 2.4, { close: true })
    // 裙褶
    for (let i = -2; i <= 2; i += 1) {
      brush([[i * R * 0.13, waistY + 12], [i * R * 0.21, hemY - 4]], { w: 1.2, color: CHIBI.dressDark, alpha: 0.48, amp: 1.2 })
    }
    // 裙摆白色荷叶边：连续的一条，不是一圈珠子
    const frill = catmull([
      [-R * 0.74, hemY - R * 0.04], [R * 0.74, hemY - R * 0.04], [R * 0.8, hemY + R * 0.12],
      [0, hemY + R * 0.18], [-R * 0.8, hemY + R * 0.12],
    ], true, 8)
    v3Fill(frill, CHIBI.lace, 0.96)
    v3Line(frill, 1.2, { close: true, color: CHIBI.inkSoft, alpha: 0.55 })
    for (let i = -5; i <= 5; i += 1) {
      const fx = i * R * 0.17
      brush([[fx, hemY + R * 0.02], [fx, hemY + R * 0.14]], { w: 0.8, color: CHIBI.apronShade, alpha: 0.32 })
    }
    // 上衣
    const bodice = catmull([
      [-torsoW, shoulderY + R * 0.05], [torsoW, shoulderY + R * 0.05],
      [torsoW * 0.96, waistY], [-torsoW * 0.96, waistY],
    ], true, 8)
    v3Fill(bodice, CHIBI.dress, 0.97)
    v3Line(bodice, 2.2, { close: true })
    // 白领
    if (!isBack) {
      const collar = catmull([[-R * 0.22, shoulderY + R * 0.02], [0, shoulderY + R * 0.2], [R * 0.22, shoulderY + R * 0.02], [0, shoulderY + R * 0.1]], true, 8)
      v3Fill(collar, CHIBI.lace, 0.98)
      v3Line(collar, 1.4, { close: true, color: CHIBI.inkSoft })
      v3Ribbon(0, shoulderY + R * 0.27, R * 0.14, R * 0.1, CHIBI.ribbon, 0)
      // 白色围裙：宽 bib + 大片裙摆，盖住深色裙子中间
      const bib = catmull([[-R * 0.34, shoulderY + R * 0.25], [R * 0.34, shoulderY + R * 0.25], [R * 0.3, waistY], [-R * 0.3, waistY]], true, 8)
      v3Fill(bib, CHIBI.apron, 0.98)
      v3Line(bib, 1.6, { close: true, color: CHIBI.inkSoft })
      // 围裙肩带
      for (const side of [-1, 1]) {
        brush([[side * R * 0.2, shoulderY + R * 0.24], [side * R * 0.34, shoulderY + R * 0.02]], { w: 3.0, color: CHIBI.apron, alpha: 0.95 })
        brush([[side * R * 0.2, shoulderY + R * 0.24], [side * R * 0.34, shoulderY + R * 0.02]], { w: 0.8, color: CHIBI.inkSoft, alpha: 0.4 })
      }
      const apron = catmull([[-R * 0.44, waistY + 2], [R * 0.44, waistY + 2], [R * 0.62, hemY + 2], [0, hemY + R * 0.15], [-R * 0.62, hemY + 2]], true, 8)
      v3Fill(apron, CHIBI.apron, 0.98)
      softShade(apron, CHIBI.apronShade, 0.16, { x: 0, y: hemY + 8, rx: R * 0.62, ry: R * 0.12 })
      v3Line(apron, 1.8, { close: true, color: CHIBI.inkSoft })
      // 围裙上的小鲸鱼
      const wx = 0
      const wy = waistY + R * 0.5
      const whale = v3Ellipse(wx, wy, R * 0.1, R * 0.055, -0.16, 12)
      v3Fill(whale, CHIBI.dressLight, 0.82)
      brush([[wx + R * 0.05, wy], [wx + R * 0.15, wy - R * 0.05], [wx + R * 0.14, wy + R * 0.04]], { w: 0.85, color: CHIBI.dressLight, alpha: 0.82, close: true })
      brush([[wx - R * 0.07, wy + R * 0.03], [wx - R * 0.14, wy - R * 0.04]], { w: 0.75, color: CHIBI.dressLight, alpha: 0.78 })
    } else {
      // 背影的白色大蝴蝶结
      v3Ribbon(0, waistY + R * 0.05, R * 0.3, R * 0.2, CHIBI.apron, 0)
    }
    // 腰带：细窄，不要一条黑胶带
    const belt = catmull([[-torsoW, waistY], [torsoW, waistY], [torsoW * 0.96, waistY + R * 0.035], [-torsoW * 0.96, waistY + R * 0.035]], true, 8)
    v3Fill(belt, CHIBI.ribbon, 0.88)
    v3Line(belt, 0.9, { close: true, color: CHIBI.inkSoft, alpha: 0.55 })
  }

  function drawChibiArms(R, bodyH, pose, isBack) {
    for (const side of [-1, 1]) {
      // 泡泡袖：短而扁的灯笼形，不是圆球
      const sp = catmull([
        [side * R * 0.46, R * 1.0], [side * R * 0.7, R * 0.98], [side * R * 0.78, R * 1.16],
        [side * R * 0.68, R * 1.27], [side * R * 0.48, R * 1.24], [side * R * 0.42, R * 1.1],
      ], true, 8)
      v3Fill(sp, CHIBI.dress, 0.97)
      softShade(sp, CHIBI.dressDark, 0.26, { x: side * R * 0.64, y: R * 1.22, rx: R * 0.16, ry: R * 0.1 })
      v3Line(sp, 1.8, { close: true })
      brush([[side * R * 0.49, R * 1.06], [side * R * 0.51, R * 1.23]], { w: 0.8, color: CHIBI.dressLight, alpha: 0.4 })
      brush([[side * R * 0.64, R * 1.03], [side * R * 0.66, R * 1.22]], { w: 0.8, color: CHIBI.dressDark, alpha: 0.35 })
      for (let j = 0; j < 6; j += 1) {
        const cuffX = side * R * (0.43 + j * 0.055)
        const cuff = v3Ellipse(cuffX, R * 1.26, R * 0.055, R * 0.04, 0, 10)
        v3Fill(cuff, CHIBI.lace, 0.96)
      }
      brush([[side * R * 0.43, R * 1.25], [side * R * 0.7, R * 1.25]], { w: 1.0, color: CHIBI.inkSoft, alpha: 0.45 })
      if (isBack) continue
      const sx = side * R * 0.54
      const sy = R * 1.18
      let hx = side * R * 0.76
      let hy = R * 1.86
      if (pose === 'wave' && side === 1) { hx = R * 1.2; hy = -R * 0.18 }
      else if (pose === 'curl') { hx = side * R * 0.3; hy = R * 1.78 }
      else if (pose === 'sit') { hx = side * R * 0.44; hy = R * 1.86 }
      const elbowX = (sx + hx) * 0.52 + side * R * 0.1
      const elbowY = (sy + hy) * 0.52 + R * 0.14
      // 手臂画成有宽度的填充形，外面再压一道边
      const arm = catmull([
        [sx + side * R * 0.09, sy + R * 0.18], [sx + side * R * 0.13, sy + R * 0.36],
        [elbowX + side * R * 0.07, elbowY], [hx + side * R * 0.08, hy - R * 0.06],
        [hx - side * R * 0.08, hy - R * 0.06], [elbowX - side * R * 0.06, elbowY + R * 0.02],
        [sx - side * R * 0.04, sy + R * 0.2],
      ], true, 8)
      v3Fill(arm, CHIBI.skin, 0.98)
      v3Line(arm, 1.5, { close: true, color: CHIBI.inkSoft, alpha: 0.65 })
      const hand = v3Ellipse(hx, hy + 2, R * 0.14, R * 0.16, side * 0.12, 16)
      v3Fill(hand, CHIBI.skin, 0.98)
      v3Line(hand, 1.4, { close: true, color: CHIBI.ink })
      const thumb = v3Ellipse(hx + side * R * 0.09, hy + R * 0.03, R * 0.045, R * 0.07, side * 0.4, 12)
      v3Fill(thumb, CHIBI.skin, 0.98)
      v3Line(thumb, 1.0, { close: true, color: CHIBI.inkSoft, alpha: 0.55 })
      for (let i = 0; i < 3; i += 1) {
        brush([[hx - R * 0.055 + i * R * 0.05, hy + R * 0.07], [hx - R * 0.045 + i * R * 0.05, hy + R * 0.13]], { w: 0.7, color: CHIBI.inkSoft, alpha: 0.35 })
      }
    }
  }

  function drawChibiEye(cx, cy, R, mood) {
    const closed = mood === 'sleepy'
    const half = mood === 'calm' ? 0.62 : mood === 'proud' ? 0.52 : mood === 'blank' ? 0.78 : mood === 'excited' ? 1.06 : 1
    const w = R * 0.145
    const h = R * 0.185
    if (closed) {
      brush([[cx - w, cy], [cx - w * 0.5, cy + h * 0.2], [cx, cy + h * 0.16], [cx + w * 0.55, cy + h * 0.1], [cx + w, cy - 1]], { w: 2.6, color: CHIBI.ink, amp: 1.0 })
      for (let i = 0; i < 2; i += 1) {
        brush([[cx + (i - 0.5) * w * 1.35, cy + h * 0.1], [cx + (i - 0.5) * w * 1.5, cy + h * 0.25]], { w: 0.9, color: CHIBI.inkSoft, alpha: 0.5 })
      }
      return
    }
    const sclera = v3Ellipse(cx, cy, w, h * half, 0, 16)
    v3Fill(sclera, '#fffdf6', 0.97)
    v3Line(sclera, 1.1, { close: true, color: CHIBI.inkSoft, alpha: 0.65 })
    // 虹膜几乎填满眼睛，只留一圈眼白，这才是参考图里的动漫眼
    const iris = v3Ellipse(cx, cy + R * 0.018, w * 0.9, h * half * 0.92, 0, 16)
    v3Fill(iris, CHIBI.eye, 0.96)
    v3Fill(v3Ellipse(cx, cy + R * 0.045, w * 0.56, h * half * 0.5, 0, 14), CHIBI.eyeDeep, 0.78)
    const pupil = v3Ellipse(cx, cy + R * 0.055, w * 0.3, h * half * 0.42, 0, 12)
    v3Fill(pupil, CHIBI.pupil, 0.96)
    const hi = v3Ellipse(cx - w * 0.25, cy - h * half * 0.18, w * 0.16, h * half * 0.12, 0, 10)
    v3Fill(hi, '#ffffff', 0.92)
    brush([[cx + w * 0.22, cy - h * half * 0.28], [cx + w * 0.25, cy - h * half * 0.02]], { w: 0.8, color: '#ffffff', alpha: 0.45 })
    // 半睁：用眼皮把上半截盖住，保留清楚的虹膜
    if (half < 0.9) {
      ctx.save()
      ctx.beginPath()
      ctx.clip(polyPath(sclera))
      ctx.fillStyle = CHIBI.skin
      ctx.globalAlpha = 0.98
      ctx.fillRect(cx - w - 4, cy - h - 8, w * 2 + 8, h * (1 - half) + 6)
      ctx.restore()
      brush([[cx - w, cy - h * half - 1], [cx, cy - h * half + 2], [cx + w, cy - h * half - 1]], { w: 2.2, color: CHIBI.ink, amp: 1.0 })
    }
    // 上眼睑 + 下睫毛
    brush([[cx - w, cy - h * half * 0.8], [cx - w * 0.55, cy - h * half * 1.02], [cx + w * 0.5, cy - h * half * 0.96], [cx + w, cy - h * half * 0.6]], { w: 2.8, color: CHIBI.ink, amp: 1.0 })
    brush([[cx - w * 0.8, cy + h * half * 0.78], [cx, cy + h * half * 0.94], [cx + w * 0.7, cy + h * half * 0.7]], { w: 0.9, color: CHIBI.inkSoft, alpha: 0.45 })
    for (let i = 0; i < 2; i += 1) {
      brush([[cx + w * 0.8, cy - h * half * 0.32 + i * 4], [cx + w * 1.04, cy - h * half * 0.18 + i * 4]], { w: 0.8, color: CHIBI.inkSoft, alpha: 0.5 })
    }
  }

  function drawChibiBangs(R) {
    // 中分刘海：左右两片大帘子，各自带尖角，不再是锯齿锅盖
    const sides = [
      [[-R * 0.03, -R * 1.02], [-R * 0.3, -R * 0.96], [-R * 0.56, -R * 0.72], [-R * 0.74, -R * 0.34], [-R * 0.78, -R * 0.16],
        [-R * 0.63, -R * 0.06], [-R * 0.52, -R * 0.36], [-R * 0.4, -R * 0.12], [-R * 0.26, -R * 0.42], [-R * 0.12, -R * 0.2], [-R * 0.02, -R * 0.26]],
      [[R * 0.03, -R * 1.02], [R * 0.3, -R * 0.96], [R * 0.56, -R * 0.72], [R * 0.74, -R * 0.34], [R * 0.78, -R * 0.16],
        [R * 0.63, -R * 0.06], [R * 0.52, -R * 0.36], [R * 0.4, -R * 0.12], [R * 0.26, -R * 0.42], [R * 0.12, -R * 0.2], [R * 0.02, -R * 0.26]],
    ]
    for (const pts of sides) {
      const bang = catmull(pts, true, 10)
      v3Fill(bang, CHIBI.hair, 0.98)
      softShade(bang, CHIBI.hairDeep, 0.2, { x: 0, y: -R * 0.48, rx: R * 0.52, ry: R * 0.18 })
      v3Line(bang, 2.4, { close: true })
    }
    // 中缝
    brush([[0, -R * 1.0], [R * 0.01, -R * 0.7], [R * 0.03, -R * 0.42]], { w: 1.2, color: CHIBI.hairDeep, alpha: 0.45 })
    // 发丝
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i += 1) {
        brush([[side * R * 0.08, -R * 0.96], [side * R * (0.28 + i * 0.12), -R * 0.6], [side * R * (0.45 + i * 0.1), -R * 0.2]], { w: 0.8, color: CHIBI.hairDeep, alpha: 0.3, amp: 1.2 })
      }
    }
    brush([[-R * 0.02, -R * 0.82], [R * 0.02, -R * 0.62], [R * 0.06, -R * 0.34]], { w: 1.0, color: CHIBI.hairLight, alpha: 0.4 })
  }

  function drawChibiSideLocks(R, bodyH) {
    // 前面只留几缕细的发丝，头发体量交给后面的发团
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i += 1) {
        const x0 = side * (R * 0.68 + i * R * 0.055)
        const x1 = side * (R * 0.82 + i * R * 0.035)
        const y1 = R * (0.5 + i * 0.28)
        const y2 = bodyH - R * (0.28 + i * 0.1)
        brush([[x0, -R * 0.18], [x1, y1], [side * R * 0.75, y2]], { w: 6 - i, color: CHIBI.hair, alpha: 0.96, amp: 1.3 })
        brush([[x0, -R * 0.18], [x1, y1], [side * R * 0.75, y2]], { w: 1.0, color: CHIBI.hairDeep, alpha: 0.45, amp: 1.3 })
      }
    }
  }

  function drawChibiBonnet(R) {
    const outer = catmull(v3Ellipse(0, -R * 0.12, R * 1.04, R * 1.0, 0, 26), true, 4)
    v3Fill(outer, CHIBI.lace, 0.97)
    v3Line(outer, 1.8, { close: true, color: CHIBI.inkSoft, alpha: 0.5 })
    // 外圈蕾丝：连续扇贝，不要一颗颗珍珠
    for (let i = 0; i < 28; i += 1) {
      const a = (i / 28) * Math.PI * 2
      const cx = Math.cos(a) * R * 0.99
      const cy = -R * 0.12 + Math.sin(a) * R * 0.97
      const scallop = v3Ellipse(cx, cy, R * 0.085, R * 0.07, a, 10)
      v3Fill(scallop, CHIBI.lace, 0.98)
    }
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2
      const cx = Math.cos(a) * R * 0.93
      const cy = -R * 0.12 + Math.sin(a) * R * 0.9
      brush([[cx, cy], [cx + R * 0.06, cy + R * 0.015]], { w: 0.6, color: CHIBI.inkSoft, alpha: 0.25 })
    }
    v3Ribbon(R * 0.32, -R * 1.08, R * 0.3, R * 0.2, CHIBI.ribbon, 0.15)
    v3Ribbon(-R * 0.36, -R * 0.95, R * 0.2, R * 0.13, CHIBI.ribbon, -0.2)
  }

  function drawChibiFinEars(R) {
    for (const side of [-1, 1]) {
      const ear = catmull([
        [side * R * 0.76, -R * 0.08], [side * R * 1.02, R * 0.02], [side * R * 1.04, R * 0.26],
        [side * R * 0.88, R * 0.34], [side * R * 0.76, R * 0.2],
      ], true, 6)
      v3Fill(ear, CHIBI.hair, 0.96)
      v3Fill(catmull([[side * R * 0.84, -R * 0.02], [side * R * 0.98, R * 0.08], [side * R * 1.0, R * 0.24], [side * R * 0.89, R * 0.28], [side * R * 0.82, R * 0.16]], true, 6), CHIBI.lace, 0.78)
      v3Line(ear, 2.0, { close: true, color: CHIBI.inkSoft })
      const pearl = v3Ellipse(side * R * 0.88, R * 0.4, 4, 6, 0, 10)
      v3Fill(pearl, CHIBI.lace, 0.96)
      v3Line(pearl, 0.8, { close: true, color: CHIBI.inkSoft })
    }
  }

  function drawChibiFace(R, mood) {
    const face = catmull(v3Ellipse(0, R * 0.05, R * 0.705, R * 0.66, 0, 24), true, 4)
    v3Fill(face, CHIBI.skin, 0.98)
    softShade(face, CHIBI.skinShade, 0.16, { x: -R * 0.3, y: R * 0.25, rx: R * 0.24, ry: R * 0.3 })
    softShade(face, '#fffdf8', 0.14, { x: R * 0.12, y: R * 0.2, rx: R * 0.3, ry: R * 0.18 })
    v3Line(face, 2.0, { close: true, color: CHIBI.inkSoft, alpha: 0.7 })
    // 腮红
    for (const side of [-1, 1]) {
      const bl = v3Ellipse(side * R * 0.45, R * 0.3, R * 0.09, R * 0.045, 0, 14)
      ctx.save()
      ctx.globalAlpha = 0.24
      ctx.fillStyle = CHIBI.blush
      ctx.fill(polyPath(bl))
      ctx.restore()
    }
    drawChibiEye(-R * 0.3, -R * 0.02, R, mood)
    drawChibiEye(R * 0.3, -R * 0.02, R, mood)
    // 眉毛：细、低、不要抢眼睛
    const browInner = mood === 'sad' || mood === 'wronged' ? -R * 0.055 : mood === 'proud' ? -R * 0.015 : 0
    for (const side of [-1, 1]) {
      brush([[side * R * 0.46, -R * 0.22], [side * R * 0.16, -R * 0.23 + browInner]], { w: 1.1, color: CHIBI.inkSoft, alpha: 0.45 })
    }
    // 鼻子
    brush([[0, R * 0.16], [-R * 0.03, R * 0.21]], { w: 0.9, color: CHIBI.inkSoft, alpha: 0.45 })
    // 嘴
    if (mood === 'excited') {
      const m = v3Ellipse(0, R * 0.38, R * 0.1, R * 0.09, 0, 14)
      v3Fill(m, '#5b3c4a', 0.9)
      v3Line(m, 1.1, { close: true, color: CHIBI.inkSoft })
      v3Fill(v3Ellipse(0, R * 0.42, R * 0.055, R * 0.03, 0, 10), '#e58a96', 0.8)
    } else if (mood === 'wronged') {
      brush([[-R * 0.12, R * 0.38], [-R * 0.03, R * 0.33], [R * 0.04, R * 0.38], [R * 0.12, R * 0.33]], { w: 1.3, color: CHIBI.ink, alpha: 0.8 })
    } else if (mood === 'proud') {
      brush([[-R * 0.12, R * 0.37], [0, R * 0.32], [R * 0.13, R * 0.36]], { w: 1.3, color: CHIBI.ink, alpha: 0.8 })
    } else if (mood === 'blank') {
      brush([[-R * 0.1, R * 0.36], [R * 0.1, R * 0.36]], { w: 1.1, color: CHIBI.inkSoft, alpha: 0.65 })
    } else {
      brush([[-R * 0.12, R * 0.35], [0, R * 0.4], [R * 0.12, R * 0.35]], { w: 1.2, color: CHIBI.ink, alpha: 0.8 })
    }
    // 泪
    if (mood === 'sad' || mood === 'wronged') {
      for (const side of [-1, 1]) {
        const tear = v3Ellipse(side * R * 0.48, R * 0.23, R * 0.035, R * 0.06, side * 0.1, 10)
        v3Fill(tear, '#b9d9f2', 0.8)
        v3Line(tear, 0.8, { close: true, color: '#7aa8cc', alpha: 0.5 })
      }
    }
    if (mood === 'sleepy') drawZzz(R)
    if (mood === 'happy' || mood === 'excited') {
      // 小星星是稀疏的两三颗，不做满眼星
      for (const [sx, sy, ss] of [[R * 0.72, -R * 0.45, 4], [R * 0.86, -R * 0.2, 3], [-R * 0.85, -R * 0.35, 3]]) {
        brush([[sx - ss, sy], [sx, sy - ss], [sx + ss, sy], [sx, sy + ss]], { w: 0.8, color: '#e6c97a', alpha: 0.55, close: true })
      }
    }
  }

  function drawZzz(R) {
    ctx.save()
    ctx.globalAlpha = 0.45
    for (let i = 0; i < 3; i += 1) {
      const x = R * 0.7 + i * 16
      const y = -R * 0.55 - i * 22
      ctx.fillStyle = CHIBI.inkSoft
      ctx.font = `${11 + i * 3}px "LongCang", sans-serif`
      ctx.fillText('Z', x, y)
    }
    ctx.restore()
  }

  function drawChibiHead(R, mood, isBack, opts) {
    drawChibiBonnet(R)
    drawChibiFinEars(R)
    if (isBack) {
      const cap = v3Ellipse(0, -R * 0.08, R * 0.82, R * 0.92, 0, 20)
      v3Fill(cap, CHIBI.hair, 0.98)
      v3Line(cap, 2.4, { close: true })
      for (let i = -2; i <= 2; i += 1) {
        brush([[i * R * 0.12, -R * 0.8], [i * R * 0.1, -R * 0.1], [i * R * 0.06, R * 0.45]], { w: 1.1, color: CHIBI.hairLight, alpha: 0.38, amp: 1.2 })
      }
      v3Ribbon(R * 0.32, -R * 1.08, R * 0.3, R * 0.2, CHIBI.ribbon, 0.15)
      return
    }
    drawChibiFace(R, mood)
    drawChibiBangs(R)
    drawZzzIfNeeded(R, mood)
  }

  function drawZzzIfNeeded(R, mood) {
    if (mood === 'sleepy') drawZzz(R)
  }

  function drawChibiPeekHands(R) {
    for (const side of [-1, 1]) {
      const x = side * R * 0.52
      const y = R * 1.15
      const cuff = v3Ellipse(x, y - R * 0.2, R * 0.28, R * 0.14, side * 0.1, 16)
      v3Fill(cuff, CHIBI.lace, 0.96)
      v3Line(cuff, 1.3, { close: true, color: CHIBI.inkSoft })
      const hand = v3Ellipse(x, y, R * 0.2, R * 0.22, side * 0.12, 16)
      v3Fill(hand, CHIBI.skin, 0.98)
      v3Line(hand, 1.8, { close: true })
      for (let i = 0; i < 3; i += 1) {
        brush([[x - R * 0.1 + i * R * 0.08, y + R * 0.03], [x - R * 0.08 + i * R * 0.08, y - R * 0.12]], { w: 1.0, color: CHIBI.inkSoft, alpha: 0.5 })
      }
    }
  }

  function drawChibiV3(R, bodyH, legH, o) {
    const pose = o.pose || 'stand'
    const mood = o.mood || 'calm'
    const isBack = Boolean(o.isBack)
    const bust = Boolean(o.bust)
    const peek = Boolean(o.peek)
    if (peek) {
      drawChibiHead(R, mood, false, o)
      drawChibiPeekHands(R)
      return
    }
    if (!bust && !isBack) drawChibiShadow(R, bodyH, legH, pose, bust)
    drawChibiHairBack(R, isBack)
    if (!bust && !isBack) drawChibiLegs(R, bodyH, legH, pose)
    if (!isBack) drawChibiTail(R, isBack)
    drawChibiDress(R, bodyH, bust, isBack)
    if (!isBack) {
      drawChibiSideLocks(R, bodyH)
    }
    drawChibiHead(R, mood, isBack, o)
    if (isBack) {
      drawChibiBackHairOverlay(R, bodyH)
      // 背腰蝴蝶结压在头发上，不能被长发吞掉
      const waistY = R * 1.62
      v3Ribbon(0, waistY + R * 0.05, R * 0.3, R * 0.2, CHIBI.apron, 0)
    }
    drawChibiArms(R, bodyH, pose, isBack)
    if (!isBack) drawStickerMotif(R, bodyH, pose)
  }

  function drawCharacter(dx, dy, scale, rot, opts) {
    const o = opts || {}
    if (drawSpriteCharacter(dx, dy, scale, rot, o)) return
    const pose = plan.pose || 'stand'
    const mood = plan.mood.key
    const age = plan.character.ageGroup === 'teen' ? 1 : 0
    const R = age ? 124 : 128
    const bodyH = age ? 270 : 244
    const legH = age ? 118 : 96
    const bust = Boolean(o.bust)
    const peek = pose === 'peek' || Boolean(o.peek)

    ctx.save()
    ctx.translate(dx, dy)
    ctx.rotate(((rot || 0) * Math.PI) / 180)
    ctx.scale(scale, scale)

    const lean = pose === 'sleep' ? -3 : pose === 'curl' ? 2 : 0
    const bob = pose === 'sit' ? 34 : pose === 'sleep' ? 22 : pose === 'curl' ? 58 : 0
    ctx.save()
    ctx.translate(0, bob)
    ctx.rotate((lean * Math.PI) / 180)

    drawChibiV3(R, bodyH, legH, {
      pose,
      mood,
      isBack: pose === 'back',
      bust,
      peek,
      opts: o,
    })

    ctx.restore()
    ctx.restore()
  }

  function drawGroundShadow(R, bodyH, legH, pose) {
    const y = pose === 'curl' ? bodyH + legH * 0.5 : pose === 'sit' ? bodyH + legH + 22 : bodyH + legH + 24
    const rx = pose === 'sit' ? R * 1.28 : pose === 'curl' ? R * 0.92 : R * 0.8
    const shadow = ellipsePts(0, y, rx, 24, 0)
    ctx.save()
    ctx.globalAlpha = 0.2
    ctx.fillStyle = DAN.shadow
    ctx.fill(polyPath(shadow))
    ctx.clip(polyPath(shadow))
    ctx.strokeStyle = DAN.lineSoft
    ctx.globalAlpha = 0.28
    ctx.lineWidth = 1.3
    for (let i = 0; i < 10; i += 1) {
      const sy = y - 12 + i * 3
      ctx.beginPath()
      ctx.moveTo(-rx + rr(0, 24), sy)
      ctx.lineTo(rx - rr(0, 28), sy + rr(-2, 2))
      ctx.stroke()
    }
    ctx.restore()
  }

  function drawTail(R, bodyH, tailScale) {
    const dir = 1
    const x0 = R * 0.42 * dir
    const y0 = bodyH - 18
    const curve = [
      [x0, y0],
      [x0 + 54 * tailScale, y0 + 18 * tailScale],
      [x0 + 108 * tailScale, y0 - 18 * tailScale],
      [x0 + 154 * tailScale, y0 - 66 * tailScale],
    ]
    const dense = catmull(curve, false, 12)
    // 尾巴主体：深蓝到青蓝的体积感
    fillGradient(dense, [
      [0, DAN.dressDark],
      [0.35, DAN.hairDeep],
      [0.72, DAN.hair],
      [1, DAN.hairMid],
    ], { alpha: 0.88, y1: y0 - 120, y2: y0 + 40, dots: 50, textureColor: DAN.hairDeep })
    brush(dense, { w: 33 * tailScale, color: DAN.hairDeep, alpha: 0.9, amp: 2.4, kind: 'marker' })
    brush(dense, { w: 23 * tailScale, color: DAN.hair, alpha: 0.35, amp: 2.2, kind: 'marker' })
    brush(curve, { w: 3.4, color: DAN.line, alpha: 0.8, amp: 2 })
    brush([[x0 + 30, y0 + 12], [x0 + 60, y0 + 2], [x0 + 92, y0 - 18]], { w: 1.5, color: DAN.hairLight, alpha: 0.45 })

    // 尾鳍：两片展开的鲸尾，有厚度、有内折
    const tip = curve[curve.length - 1]
    const left = [
      [tip[0], tip[1]],
      [tip[0] - 22 * tailScale, tip[1] - 54 * tailScale],
      [tip[0] - 66 * tailScale, tip[1] - 38 * tailScale],
      [tip[0] - 48 * tailScale, tip[1] - 4 * tailScale],
      [tip[0] - 12 * tailScale, tip[1] + 12 * tailScale],
    ]
    const right = [
      [tip[0], tip[1]],
      [tip[0] + 22 * tailScale, tip[1] - 50 * tailScale],
      [tip[0] + 64 * tailScale, tip[1] - 30 * tailScale],
      [tip[0] + 42 * tailScale, tip[1] + 2 * tailScale],
      [tip[0] + 10 * tailScale, tip[1] + 14 * tailScale],
    ]
    for (const fluke of [left, right]) {
      fillGradient(fluke, [[0, DAN.hairDeep], [0.55, DAN.hair], [1, DAN.hairLight]], {
        alpha: 0.92, y1: tip[1] - 60, y2: tip[1] + 20, dots: 26,
      })
      brush(fluke, { w: 3.2, color: DAN.line, close: true, alpha: 0.85, amp: 1.8 })
    }
    // 尾鳍内折线与青色边
    brush([[tip[0] - 8, tip[1] - 6], [tip[0] - 28, tip[1] - 34], [tip[0] - 52, tip[1] - 28]], { w: 1.4, color: DAN.hairTip, alpha: 0.55 })
    brush([[tip[0] + 8, tip[1] - 6], [tip[0] + 27, tip[1] - 32], [tip[0] + 49, tip[1] - 26]], { w: 1.4, color: DAN.hairTip, alpha: 0.55 })

    // 珍珠链：沿尾巴一侧散落，尾根系一只小蓝结
    for (let i = 1; i <= 7; i += 1) {
      const u = i / 8
      const p = curve[Math.min(3, Math.floor(u * 4))] || tip
      const q = curve[Math.min(3, Math.floor(u * 4) + 1)] || tip
      const px = p[0] + (q[0] - p[0]) * (u * 4 - Math.floor(u * 4))
      const py = p[1] + (q[1] - p[1]) * (u * 4 - Math.floor(u * 4)) + 19
      ctx.beginPath()
      ctx.fillStyle = DAN.pearl
      ctx.globalAlpha = 0.75
      ctx.arc(px, py, 4.2, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 0.35
      ctx.strokeStyle = DAN.lineSoft
      ctx.lineWidth = 1
      ctx.stroke()
    }
    const bowX = x0 + 34
    const bowY = y0 + 22
    brush([[bowX, bowY], [bowX - 20, bowY - 14], [bowX - 16, bowY + 8], [bowX, bowY]], { w: 2.2, color: DAN.cyan, close: true, alpha: 0.8 })
    brush([[bowX, bowY], [bowX + 20, bowY - 14], [bowX + 16, bowY + 8], [bowX, bowY]], { w: 2.2, color: DAN.cyan, close: true, alpha: 0.8 })
  }

  function drawPeekHands(R) {
    for (const side of [-1, 1]) {
      const x = side * R * 0.98
      const y = R * 0.64
      // 袖口先露出来，手才像从纸边扒住
      const sleeve = ellipsePts(x + side * 8, y + 22, 34, 24, side * 0.06)
      fillGradient(sleeve, [[0, DAN.dressLight], [1, DAN.dressDark]], { alpha: 0.9, y1: y, y2: y + 60, dots: 18 })
      brush(sleeve, { w: 2.2, color: DAN.line, close: true, alpha: 0.6 })
      const cuff = ellipsePts(x + side * 14, y + 8, 18, 10, side * 0.05)
      charFill(cuff, DAN.frill, { alpha: 0.95 })
      brush(cuff, { w: 1.8, color: DAN.lineSoft, close: true, alpha: 0.5 })
      const hand = ellipsePts(x + side * 14, y - 3, 25, 20, side * 0.2)
      charFill(hand, DAN.skin, { alpha: 0.96 })
      brush(hand, { w: 2.3, color: DAN.line, close: true, alpha: 0.55, amp: 1.4 })
      for (let i = 0; i < 3; i += 1) {
        const fx = x + side * 14 - 14 + i * 10
        brush([[fx, y - 18], [fx + side * 2, y - 4]], { w: 1.3, color: DAN.skinShade, alpha: 0.55 })
      }
    }
  }

  function drawLegsStand(R, bodyH, legH, pose) {
    const hipY = bodyH
    for (const side of [-1, 1]) {
      const cx = side * R * 0.27
      const ankleY = hipY + legH - 18
      // 腿是有体积的：大腿根宽、脚踝收，外轮廓用彩铅线，不要一根白管子
      const leg = [
        [cx - R * 0.115, hipY + 6],
        [cx + R * 0.115, hipY + 6],
        [cx + R * 0.1, hipY + legH * 0.5],
        [cx + R * 0.075, ankleY],
        [cx + R * 0.13, ankleY + 12],
        [cx - R * 0.13, ankleY + 12],
        [cx - R * 0.075, ankleY],
        [cx - R * 0.1, hipY + legH * 0.5],
      ]
      fillGradient(leg, [[0, '#fbe3d8'], [0.55, DAN.skin], [1, '#f6d8cb']], {
        alpha: 0.94, y1: hipY, y2: ankleY, dots: 16, texture: false,
      })
      brush(leg, { w: 1.5, color: DAN.lineSoft, close: true, alpha: 0.35, amp: 1.1 })
      softShade(leg, DAN.skinShade, 0.2, { x: cx - side * 6, y: hipY + legH * 0.6, rx: 12, ry: legH * 0.25 })
      // 膝盖内侧的浅压线
      brush([[cx - R * 0.04, hipY + legH * 0.44], [cx + R * 0.04, hipY + legH * 0.46]], { w: 0.9, color: DAN.skinShade, alpha: 0.45 })
      // 白袜：袜口有褶，袜筒顺着小腿
      const sockTop = hipY + legH * 0.56
      const sock = [
        [cx - R * 0.095, sockTop],
        [cx + R * 0.095, sockTop],
        [cx + R * 0.085, ankleY + 2],
        [cx - R * 0.085, ankleY + 2],
      ]
      charFill(sock, DAN.frill, { alpha: 0.97 })
      brush(sock, { w: 1.2, color: DAN.lineSoft, close: true, alpha: 0.38, amp: 1 })
      for (let i = 0; i < 7; i += 1) {
        brush([[cx - R * 0.09 + i * R * 0.028, sockTop], [cx - R * 0.09 + i * R * 0.028, sockTop + R * 0.06]], { w: 0.75, color: DAN.lineSoft, alpha: 0.4 })
      }
      // 小皮鞋：圆头玛丽珍，鞋头不做出尖角，避免看成高跟鞋
      const footX = cx + side * R * 0.05
      const shoe = ellipsePts(footX, ankleY + 12, R * 0.18, R * 0.11, 0, 28)
      charFill(shoe, DAN.dress, { alpha: 0.97 })
      brush(shoe, { w: 1.9, color: DAN.line, close: true, alpha: 0.68, amp: 1 })
      // 鞋面/鞋底
      brush([[footX - R * 0.16, ankleY + 14], [footX + R * 0.16, ankleY + 14]], { w: 1.6, color: DAN.dressDark, alpha: 0.6 })
      brush([[footX - R * 0.17, ankleY + 21], [footX + R * 0.17, ankleY + 21]], { w: 1.2, color: '#11152e', alpha: 0.55 })
      // 搭扣 + 蓝结
      brush([[footX - side * R * 0.08, ankleY + 3], [footX + side * R * 0.08, ankleY + 17]], { w: 1.1, color: DAN.pearl, alpha: 0.5 })
      drawBowSmall(footX + side * R * 0.03, ankleY + 9, 0.5, DAN.cyan)
      if (pose === 'sleep') brush([[footX - R * 0.1, ankleY + 4], [footX + R * 0.1, ankleY + 6]], { w: 1.6, color: DAN.lineSoft, alpha: 0.28 })
    }
  }

  function drawBowSmall(x, y, s, color) {
    brush([[x, y], [x - 10 * s, y - 7 * s], [x - 8 * s, y + 4 * s], [x, y]], { w: 1.5, color, close: true, alpha: 0.85 })
    brush([[x, y], [x + 10 * s, y - 7 * s], [x + 8 * s, y + 4 * s], [x, y]], { w: 1.5, color, close: true, alpha: 0.85 })
    brush(ellipsePts(x, y, 2.4 * s, 2 * s, 0), { w: 0.7, color: DAN.lineSoft, close: true, alpha: 0.5 })
  }

  function drawLegsSit(R, bodyH, legH) {
    const hipY = bodyH
    for (const side of [-1, 1]) {
      const kneeX = side * R * 0.48
      const kneeY = hipY + legH * 0.3
      const footX = side * R * 0.64
      const footY = hipY + legH * 0.9
      // 大腿横向折出去，膝盖朝外
      brush([[side * R * 0.2, hipY + 8], [kneeX, kneeY], [footX, footY - 18]], { w: 18, color: DAN.skin, amp: 1.6 })
      // 白袜
      const sock = [[footX - 13, footY - 46], [footX + 13, footY - 46], [footX + 14, footY - 2], [footX - 14, footY - 2]]
      charFill(sock, DAN.frill, { alpha: 0.96 })
      brush(sock, { w: 1.3, color: DAN.lineSoft, close: true, alpha: 0.4 })
      // 鞋
      const shoe = ellipsePts(footX + side * 8, footY + 4, 25, 13, side * 0.08)
      fillGradient(shoe, [[0, DAN.dressLight], [1, DAN.dressDark]], { alpha: 0.95, y1: footY - 12, y2: footY + 20, dots: 12 })
      brush(shoe, { w: 2.2, color: DAN.line, close: true, alpha: 0.75 })
      brush([[footX - 14, footY - 1], [footX + 18, footY - 3]], { w: 2, color: DAN.dressDark, alpha: 0.7 })
      brush(ellipsePts(footX + side * 3, footY - 4, 3, 2.2, 0), { w: 0.8, color: DAN.cyan, close: true, alpha: 0.75 })
    }
  }

  function drawLegsCurl(R, bodyH, legH) {
    const hipY = bodyH
    for (const side of [-1, 1]) {
      const kneeX = side * R * 0.5
      const kneeY = hipY + legH * 0.18
      const footX = side * R * 0.55
      const footY = hipY + legH * 0.58
      // 抱膝时大腿几乎贴着小腿，脚缩在裙摆下
      brush([[side * R * 0.18, hipY + 6], [kneeX, kneeY], [footX, footY - 12]], { w: 17, color: DAN.skin, amp: 1.4 })
      const sock = ellipsePts(footX, footY - 2, 13, 16, side * 0.15)
      charFill(sock, DAN.frill, { alpha: 0.95 })
      brush(sock, { w: 1.2, color: DAN.lineSoft, close: true, alpha: 0.4 })
      const shoe = ellipsePts(footX + side * 4, footY + 12, 20, 10, side * 0.1)
      charFill(shoe, DAN.dressDark, { alpha: 0.95 })
      brush(shoe, { w: 2, color: DAN.line, close: true, alpha: 0.72 })
      brush(ellipsePts(footX + side * 2, footY + 8, 2.6, 2, 0), { w: 0.8, color: DAN.cyan, close: true, alpha: 0.7 })
    }
  }

  function drawLegsLie(R, bodyH, legH) {
    const hipY = bodyH
    for (const side of [-1, 1]) {
      brush([[side * R * 0.2, hipY], [side * R * 0.5, hipY - 10], [side * R * 0.78, hipY - 24]], { w: 17, color: DAN.skin, amp: 2 })
    }
  }

  function drawDress(R, bodyH, bust, isBack) {
    const shoulderY = R * 1.16
    const waistY = bodyH * 0.72
    const hemY = bodyH + 46
    const bodice = [
      [-R * 0.68, shoulderY],
      [-R * 0.32, shoulderY - R * 0.08],
      [0, shoulderY + R * 0.02],
      [R * 0.32, shoulderY - R * 0.08],
      [R * 0.68, shoulderY],
      [R * 0.59, waistY],
      [-R * 0.59, waistY],
    ]
    fillGradient(bodice, [[0, DAN.dressLight], [0.55, DAN.dress], [1, DAN.dressDark]], {
      alpha: 0.95, y1: shoulderY - 20, y2: waistY, dots: 40,
    })
    charHatch(bodice, DAN.dressDark, { gap: 18, angle: 0.9, alpha: 0.09, w: 0.9 })
    brush(bodice, { w: 3.2, color: DAN.line, close: true, amp: 1.8, alpha: 0.8, double: true, doubleShift: 2 })
    softShade(bodice, DAN.dressDark, 0.2, { x: -R * 0.3, y: waistY - 24, rx: R * 0.22, ry: R * 0.35 })

    // 裙摆：A 字 + 两层褶边
    const skirt = [
      [-R * 0.59, waistY - 2],
      [R * 0.59, waistY - 2],
      [R * 1.04, hemY - 26],
      [R * 0.88, hemY + 6],
      [R * 0.54, hemY - 2],
      [R * 0.18, hemY + 10],
      [-R * 0.16, hemY + 8],
      [-R * 0.54, hemY - 2],
      [-R * 0.88, hemY + 4],
      [-R * 1.04, hemY - 24],
    ]
    fillGradient(skirt, [[0, DAN.dressLight], [0.4, DAN.dress], [1, DAN.dressDark]], {
      alpha: 0.95, y1: waistY, y2: hemY, dots: 46,
    })
    charHatch(skirt, DAN.dressDark, { gap: 20, angle: 0.85, alpha: 0.08, w: 0.9 })
    brush(skirt, { w: 3.4, color: DAN.line, close: true, amp: 2, alpha: 0.8, double: true, doubleShift: 2.2 })
    // 裙褶
    for (let i = -3; i <= 3; i += 1) {
      brush([[i * R * 0.16, waistY + 6], [i * R * 0.24, hemY - 2], [i * R * 0.28, hemY + 3]], { w: 1.5, color: DAN.dressDark, alpha: 0.38 })
    }
    // 白色蕾丝下摆
    const frill = []
    for (let i = 0; i <= 12; i += 1) {
      const u = i / 12
      frill.push([-R * 0.95 + u * R * 1.9, hemY - 2 + (i % 2 ? 10 : 2)])
    }
    fillGradient(frill, [[0, DAN.apronShade], [1, DAN.frill]], { alpha: 0.92, y1: hemY - 12, y2: hemY + 16, dots: 24 })
    brush(frill, { w: 2, color: DAN.lineSoft, close: true, alpha: 0.4, amp: 1.2 })

    // 白色领口 + 蓝宝石蝴蝶结（只在正面画，背影不要一块白布）
    if (!isBack) {
    const collar = [
      [-R * 0.34, shoulderY - 4],
      [-R * 0.16, shoulderY + R * 0.2],
      [0, shoulderY + R * 0.3],
      [R * 0.16, shoulderY + R * 0.2],
      [R * 0.34, shoulderY - 4],
      [0, shoulderY + R * 0.1],
    ]
    charFill(collar, DAN.frill, { alpha: 0.98 })
    brush(collar, { w: 1.8, color: DAN.lineSoft, close: true, alpha: 0.5, amp: 1.2 })
    for (let i = -2; i <= 2; i += 1) {
      const x = i * R * 0.12
      brush([[x, shoulderY + 2], [x + 2, shoulderY + R * 0.25]], { w: 1, color: DAN.apronShade, alpha: 0.6 })
    }
    drawBow(0, shoulderY + R * 0.28, 0.78, DAN.cyan, DAN.hairDeep)
    // 蓝宝石
    const gem = ellipsePts(0, shoulderY + R * 0.33, 8, 9, 0)
    fillGradient(gem, [[0, DAN.cyan], [1, DAN.hairDeep]], { alpha: 0.95, y1: shoulderY + R * 0.2, y2: shoulderY + R * 0.45, dots: 0 })
    brush(gem, { w: 1.4, color: DAN.line, close: true, alpha: 0.6 })

    // 胸前一排小珍珠扣
    for (let i = 0; i < 4; i += 1) {
      ctx.beginPath()
      ctx.fillStyle = DAN.pearl
      ctx.globalAlpha = 0.9
      ctx.arc(0, shoulderY + R * 0.48 + i * R * 0.18, 3.6, 0, Math.PI * 2)
      ctx.fill()
    }
    }

    // 腰带
    brush([[-R * 0.54, waistY - 6], [0, waistY - 2], [R * 0.54, waistY - 6]], { w: 9, color: DAN.dressDark, alpha: 0.9, kind: 'marker' })
    brush([[-R * 0.52, waistY - 10], [R * 0.52, waistY - 10]], { w: 2, color: DAN.cyan, alpha: 0.5 })

    if (isBack) {
      // 背后的大蝴蝶结与两条垂带
      drawBow(0, waistY + 6, 1.15, DAN.frill, DAN.apronShade)
      brush([[-10, waistY + 24], [-34, waistY + 90], [-18, waistY + 76]], { w: 3, color: DAN.frill, alpha: 0.85, close: true })
      brush([[10, waistY + 24], [36, waistY + 92], [20, waistY + 78]], { w: 3, color: DAN.frill, alpha: 0.85, close: true })
    }
  }

  function drawBow(x, y, s, color, edge) {
    const left = [[x, y], [x - 26 * s, y - 16 * s], [x - 22 * s, y + 12 * s], [x, y]]
    const right = [[x, y], [x + 26 * s, y - 16 * s], [x + 22 * s, y + 12 * s], [x, y]]
    for (const loop of [left, right]) {
      charFill(loop, color, { alpha: 0.95 })
      brush(loop, { w: 1.4, color: edge || DAN.lineSoft, close: true, alpha: 0.55, amp: 1 })
    }
    const knot = ellipsePts(x, y + 1, 7 * s, 6 * s, 0)
    charFill(knot, edge || DAN.line, { alpha: 0.75 })
  }

  function drawApron(R, bodyH, bust) {
    const top = R * 1.48
    const waistY = bodyH * 0.72
    const bot = bodyH + 6
    const bib = [
      [-R * 0.26, top + R * 0.08],
      [-R * 0.19, top],
      [R * 0.19, top],
      [R * 0.26, top + R * 0.08],
      [R * 0.23, waistY - 8],
      [-R * 0.23, waistY - 8],
    ]
    charFill(bib, DAN.apron, { alpha: 0.96 })
    brush(bib, { w: 1.9, color: DAN.lineSoft, close: true, alpha: 0.48, amp: 1.2, double: true, doubleShift: 1.4 })
    // 领口蓝蝴蝶结要压在围裙上面，不然会被胸片吃掉
    drawBow(0, top - R * 0.12, 0.64, DAN.cyan, DAN.hairDeep)
    const neckGem = ellipsePts(0, top - R * 0.08, 6, 7, 0)
    fillGradient(neckGem, [[0, DAN.cyan], [1, DAN.hairDeep]], { alpha: 0.95, y1: top - R * 0.16, y2: top, dots: 0 })
    brush(neckGem, { w: 1.2, color: DAN.line, close: true, alpha: 0.55 })
    // 胸片顶端的荷叶边
    for (let i = -2; i <= 2; i += 1) {
      const x = i * R * 0.11
      const r = 13
      ctx.save()
      ctx.globalAlpha = 0.9
      ctx.fillStyle = DAN.frill
      ctx.beginPath()
      ctx.arc(x, top + 2, r, Math.PI, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      brush([[x - r, top + 2], [x, top - 6], [x + r, top + 2]], { w: 1.1, color: DAN.lineSoft, alpha: 0.4 })
    }
    // 鲸鱼刺绣
    const wx = 0
    const wy = top + R * 0.4
    const whale = [
      [wx - 28, wy],
      [wx - 8, wy - 12],
      [wx + 16, wy - 4],
      [wx + 24, wy + 2],
      [wx + 14, wy + 12],
      [wx - 8, wy + 9],
    ]
    charFill(whale, DAN.dress, { alpha: 0.82 })
    brush(whale, { w: 1.3, color: DAN.dressDark, close: true, alpha: 0.6 })
    brush([[wx - 18, wy + 1], [wx - 12, wy + 6], [wx - 4, wy + 8]], { w: 1.2, color: DAN.hairTip, alpha: 0.6 })
    // 小鲸尾和水花
    brush([[wx + 20, wy], [wx + 31, wy - 8], [wx + 28, wy + 2], [wx + 34, wy + 6]], { w: 2, color: DAN.dress, alpha: 0.75, close: true })
    brush([[wx + 2, wy - 15], [wx + 2, wy - 23], [wx + 8, wy - 19]], { w: 1.1, color: DAN.cyan, alpha: 0.55 })

    // 围裙裙摆
    const skirt = [
      [-R * 0.3, waistY - 2],
      [R * 0.3, waistY - 2],
      [R * 0.56, bot - 12],
      [R * 0.42, bot + 2],
      [R * 0.18, bot - 4],
      [-R * 0.12, bot + 4],
      [-R * 0.4, bot - 2],
      [-R * 0.58, bot - 12],
    ]
    charFill(skirt, DAN.apron, { alpha: 0.94 })
    brush(skirt, { w: 1.9, color: DAN.lineSoft, close: true, alpha: 0.45, amp: 1.2 })
    // 围裙下摆荷叶边：一褶一褶的白布，不是一条直线
    for (let i = 0; i < 7; i += 1) {
      const x = -R * 0.53 + i * R * 0.175
      const petal = [
        [x, bot - 8],
        [x + R * 0.04, bot + 1],
        [x + R * 0.09, bot - 4],
        [x + R * 0.13, bot - 9],
      ]
      charFill(petal, DAN.frill, { alpha: 0.9 })
      brush(petal, { w: 0.9, color: DAN.lineSoft, close: true, alpha: 0.35 })
    }
    // 腰封：把胸片和裙摆分开，腰线才立得住
    const waistband = [
      [-R * 0.3, waistY - 10],
      [R * 0.3, waistY - 10],
      [R * 0.28, waistY + 4],
      [-R * 0.28, waistY + 4],
    ]
    charFill(waistband, DAN.frill, { alpha: 0.96 })
    brush(waistband, { w: 1.3, color: DAN.lineSoft, close: true, alpha: 0.4 })
    for (let i = -4; i <= 4; i += 1) {
      brush([[i * R * 0.06, waistY - 9], [i * R * 0.06 + 2, waistY + 3]], { w: 0.7, color: DAN.apronShade, alpha: 0.5 })
    }
    // 肩带与腰后系带
    brush([[-R * 0.2, top + 4], [-R * 0.42, top - R * 0.22], [-R * 0.5, top - R * 0.3]], { w: 3, color: DAN.frill, alpha: 0.9 })
    brush([[R * 0.2, top + 4], [R * 0.42, top - R * 0.22], [R * 0.5, top - R * 0.3]], { w: 3, color: DAN.frill, alpha: 0.9 })
    drawBow(0, waistY - 2, 0.55, DAN.frill, DAN.apronShade)
    // 腰侧贝壳小包 + 珍珠链
    const pouchX = R * 0.72
    const pouchY = waistY + 16
    const pouch = ellipsePts(pouchX, pouchY, 26, 22, 0.1)
    charFill(pouch, DAN.apron, { alpha: 0.92 })
    brush(pouch, { w: 1.6, color: DAN.lineSoft, close: true, alpha: 0.5 })
    for (let i = 0; i < 5; i += 1) {
      brush([[pouchX - 16 + i * 8, pouchY - 16], [pouchX - 10 + i * 6, pouchY + 12]], { w: 1, color: DAN.apronShade, alpha: 0.6 })
    }
    for (let i = 0; i < 4; i += 1) {
      ctx.beginPath()
      ctx.fillStyle = DAN.pearl
      ctx.globalAlpha = 0.85
      ctx.arc(R * 0.42 + i * 12, waistY - 6 - i * 4, 3, 0, Math.PI * 2)
      ctx.fill()
    }
    if (bust) {
      // 半身裁切处补一道柔和的纸边/裙边，不像被硬切掉
      brush([[-R * 0.6, bot - 2], [0, bot + 4], [R * 0.6, bot - 2]], { w: 2, color: DAN.lineSoft, alpha: 0.3 })
    }
  }

  function drawArms(R, bodyH, pose, isBack) {
    const legH = 132
    const top = R * 1.16
    const config = {
      stand: { elbow: [0.78, 1.62], hand: [0.7, 2.02] },
      wave: { elbow: [0.78, 1.55], hand: [0.72, 1.98] },
      sit: { elbow: [0.72, 1.58], hand: [0.43, 1.9] },
      curl: { elbow: [0.58, 1.74], hand: [0.32, 2.14] },
      sleep: { elbow: [0.76, 1.65], hand: [0.62, 2.04] },
      back: { elbow: [0.74, 1.62], hand: [0.66, 2.0] },
    }[pose] || { elbow: [0.78, 1.62], hand: [0.7, 2.02] }

    for (const side of [-1, 1]) {
      const raised = pose === 'wave' && side === 1
      const sx = side * R * 0.68
      let ex = side * R * config.elbow[0]
      let ey = R * config.elbow[1]
      let hx = side * R * config.hand[0]
      let hy = R * config.hand[1]
      if (raised) {
        ex = side * R * 0.95
        ey = R * 1.08
        hx = side * R * 1.28
        hy = -R * 0.16
      }
      if (pose === 'curl') {
        hx = side * R * 0.3
        hy = bodyH + legH * 0.31
        ex = side * R * 0.55
        ey = bodyH - R * 0.3
      }
      if (pose === 'sit') {
        hx = side * R * 0.33
        hy = bodyH + legH * 0.22
        ex = side * R * 0.66
        ey = bodyH - R * 0.58
      }

      // 背影看不到手臂，直接跳过，免得从背后伸两条白胳膊
      if (isBack) {
        // 背影也给一小截泡泡袖，不能露出光肩膀
        const sleeve = ellipsePts(sx, top + 8, 26, 23, side * 0.08)
        charFill(sleeve, DAN.dressLight, { alpha: 0.96 })
        softShade([sx, top + 4], 24, DAN.dressDark, 0.35)
        charHatch(sleeve, DAN.dressDark, { gap: 9, angle: 1.0, alpha: 0.16, w: 0.8 })
        brush(catmull(sleeve, true, 5), { w: 1.7, color: DAN.lineSoft, close: true, amp: 1.4 })
        brush([
          [sx - 14, top + 22],
          [sx, top + 25],
          [sx + 14, top + 22],
        ], { w: 3.2, color: DAN.frill, amp: 1.2 })
        continue
      }

      // 长袖：肩→肘→腕，先用深藏青铺一条袖管，再用浅一档的蓝压出褶皱
      const wristY = raised ? hy + 12 : hy - 12
      brush([[sx, top + 8], [ex, ey], [hx, wristY]], { w: 20, color: DAN.skin, amp: 1.5 })
      brush([[ex, ey], [hx, wristY + 2]], { w: 14, color: DAN.skinHand, amp: 1.2 })
      brush([[ex - side * 6, ey - 8], [ex, ey + 4], [ex + side * 7, ey - 6]], { w: 1.2, color: DAN.dressDark, alpha: 0.4 })
      brush([[ex, ey + 6], [hx - side * 3, hy - 16]], { w: 1.6, color: DAN.dressDark, alpha: 0.3 })


      // 泡泡袖：肩头鼓起，底部收进白蕾丝
      const sleeve = ellipsePts(sx, top + 8, 27, 24, side * 0.08)
      fillGradient(sleeve, [[0, DAN.dressLight], [0.45, DAN.dress], [1, DAN.dressDark]], {
        alpha: 0.95, y1: top - 14, y2: top + 36, dots: 18,
      })
      brush(sleeve, { w: 1.9, color: DAN.line, close: true, alpha: 0.55, amp: 1.3 })
      charHatch(sleeve, DAN.dressDark, { gap: 11, angle: 1.0, alpha: 0.1, w: 0.8 })
      for (let i = -2; i <= 2; i += 1) {
        brush([[sx + i * R * 0.055, top - 10 + Math.abs(i) * 3], [sx + i * R * 0.062, top + 26]], { w: 0.9, color: i % 2 ? DAN.dressLight : DAN.dressDark, alpha: 0.32 })
      }
      for (let i = 0; i < 3; i += 1) {
        const ang = -1.1 + i * 0.5
        brush([[sx + Math.cos(ang) * 15, top + 8 + Math.sin(ang) * 10], [sx + Math.cos(ang) * 25, top + 15 + Math.sin(ang) * 13]], { w: 0.8, color: DAN.dressDark, alpha: 0.32 })
      }
      for (let i = -2; i <= 2; i += 1) {
        const lx = sx + i * R * 0.07
        const ly = top + R * 0.3 + Math.abs(i) * 2
        const lace = ellipsePts(lx, ly, R * 0.046, R * 0.028, 0, 16)
        charFill(lace, DAN.frill, { alpha: 0.96 })
        brush(lace, { w: 0.8, color: DAN.lineSoft, close: true, alpha: 0.32 })
      }

      // 白色蕾丝袖口：只给挥手那只收一圈，日常手臂保持裸露
      if (raised) {
        const cuff = ellipsePts(hx - side * 1, hy + 13, 13, 7, side * 0.06)
        charFill(cuff, DAN.frill, { alpha: 0.98 })
        brush(cuff, { w: 1.1, color: DAN.lineSoft, close: true, alpha: 0.4 })
        for (let i = -2; i <= 2; i += 1) {
          brush([[hx - 9 + i * 5, hy + 8], [hx - 8 + i * 5, hy + 18]], { w: 0.7, color: DAN.apronShade, alpha: 0.45 })
        }
      }

      // 手：掌心 + 拇指 + 指缝，尺寸略小于袖口，不再像一只粉色拳套
      const hand = ellipsePts(hx, hy + 2, raised ? 14.5 : 13.5, raised ? 16 : 15.5, side * 0.1)
      ctx.save()
      ctx.fillStyle = DAN.shadow
      ctx.globalAlpha = 0.14
      ctx.beginPath()
      ctx.ellipse(hx + 2, hy + 11, 11, 5, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      charFill(hand, DAN.skinHand, { alpha: 0.98 })
      softShade(hand, DAN.skinShade, 0.3, { x: hx - side * 4, y: hy + 8, rx: 9, ry: 7 })
      brush(hand, { w: 1.5, color: DAN.line, close: true, alpha: 0.66, amp: 0.9 })
      brush([[hx - 5, hy - 5], [hx + 5, hy - 6]], { w: 1, color: DAN.skinShade, alpha: 0.55 })
      if (raised) {
        for (let i = 0; i < 4; i += 1) {
          const fx = hx - 9 + i * 5.8
          brush([[fx, hy - 2], [fx + side * 1.8, hy - 18]], { w: 1.4, color: DAN.skinShade, alpha: 0.68 })
        }
        brush([[hx + side * 10, hy + 8], [hx + side * 16, hy - 2]], { w: 1.4, color: DAN.skinShade, alpha: 0.55 })
      } else {
        for (let i = 0; i < 3; i += 1) {
          const fx = hx - 8.5 + i * 6
          brush([[fx, hy + 7], [fx + (i - 1) * 1, hy + 18]], { w: 0.9, color: DAN.lineSoft, alpha: 0.46 })
        }
        // 拇指在掌外侧
        const thumb = ellipsePts(hx + side * 11, hy + 5, 5, 7.5, side * 0.4, 16)
        charFill(thumb, DAN.skinHand, { alpha: 0.95 })
        brush(thumb, { w: 0.9, color: DAN.lineSoft, close: true, alpha: 0.38 })
      }
    }
  }

  // 后发单独先画，压在身体后面，不能让长发盖住裙子和手。
  function drawHairBack(R, isBack) {
    const cy = 0
    // 后发：大面积、波浪、从头顶包到腰
    const backHair = [
      [-R * 0.62, -R * 0.06],
      [-R * 0.94, -R * 0.54],
      [-R * 0.78, -R * 1.04],
      [-R * 0.36, -R * 1.18],
      [0, -R * 1.23],
      [R * 0.36, -R * 1.18],
      [R * 0.78, -R * 1.02],
      [R * 0.94, -R * 0.5],
      [R * 0.62, -R * 0.06],
      [R * 1.04, R * 0.26],
      [R * 1.2, R * 0.72],
      [R * 1.28, R * 1.35],
      [R * 1.12, R * 1.9],
      [R * 0.94, R * 2.26],
      [R * 0.72, R * 2.48],
      [R * 0.56, R * 2.25],
      [R * 0.46, R * 1.78],
      [R * 0.36, R * 1.55],
      [R * 0.2, R * 2.08],
      [0, R * 2.36],
      [-R * 0.2, R * 2.04],
      [-R * 0.36, R * 1.62],
      [-R * 0.48, R * 2.18],
      [-R * 0.68, R * 2.46],
      [-R * 0.9, R * 2.24],
      [-R * 1.08, R * 1.8],
      [-R * 1.2, R * 1.12],
      [-R * 1.24, R * 0.5],
    ]
    hairGradient(backHair, 0.97, -R * 1.35, R * 2.5)
    charHatch(backHair, DAN.hairDeep, { gap: 20, angle: 1.15, alpha: 0.16, w: 0.9 })
    brush(catmull(backHair, true, 4), { w: 2.6, color: DAN.hairShade, close: true, alpha: 0.72, amp: 2.2, double: true, doubleShift: 1.8 })
    // 后发内部分束：长而顺的波浪
    for (let i = -5; i <= 5; i += 1) {
      const x = i * R * 0.16
      brush([
        [x, -R * 0.85],
        [x + i * R * 0.04, R * 0.1],
        [x + i * R * 0.02, R * 1.0],
        [x + i * R * 0.05, R * 1.8],
        [x + i * R * 0.02, R * 2.15],
      ], { w: 1.4, color: i % 2 ? DAN.hairLight : DAN.hairDeep, alpha: 0.35, amp: 1.6 })
    }
    // 两侧的大波浪：用较粗的深浅发束压出发量，不让头发像一块直布
    for (const side of [-1, 1]) {
      for (let j = 0; j < 3; j += 1) {
        const x0 = side * R * (0.58 + j * 0.14)
        brush([
          [x0, -R * 0.45],
          [x0 + side * R * 0.12, R * 0.2],
          [x0 - side * R * 0.05, R * 0.85],
          [x0 + side * R * 0.12, R * 1.45],
          [x0 - side * R * 0.03, R * 2.05],
          [x0 + side * R * 0.18, R * 2.32],
        ], { w: 11 - j * 3, color: j % 2 ? DAN.hairDeep : DAN.hairLight, alpha: j % 2 ? 0.22 : 0.2, amp: 2.4, kind: 'marker' })
      }
      brush([
        [side * R * 0.86, -R * 0.2],
        [side * R * 1.02, R * 0.45],
        [side * R * 0.9, R * 1.1],
        [side * R * 1.02, R * 1.7],
        [side * R * 0.8, R * 2.1],
      ], { w: 1.6, color: DAN.hairLight, alpha: 0.4, amp: 2 })
    }
    // 发梢青蓝
    for (const side of [-1, 1]) {
      const tipPatch = [
        [side * R * 0.5, R * 1.5],
        [side * R * 0.9, R * 1.85],
        [side * R * 0.72, R * 2.2],
        [side * R * 0.3, R * 2.3],
        [side * R * 0.18, R * 1.95],
      ]
      fillGradient(tipPatch, [[0, withAlpha(DAN.hairTip, 0)], [1, withAlpha(DAN.hairTip, 0.75)]], {
        alpha: 0.5, y1: R * 1.4, y2: R * 2.3, texture: false,
      })
    }
  }

  function drawHead(R, isBack, mood, opts) {
    const cy = 0
    // 脖子
    const neck = [[-R * 0.2, R * 0.6], [R * 0.2, R * 0.6], [R * 0.22, R * 1.08], [-R * 0.22, R * 1.08]]
    charFill(neck, DAN.skin, { alpha: 0.95 })
    brush(neck, { w: 1.6, color: DAN.lineSoft, close: true, alpha: 0.35 })
    softShade(neck, DAN.skinShade, 0.22, { x: 0, y: R * 0.85, rx: R * 0.16, ry: R * 0.25 })

    if (isBack) {
      // 后脑：先用头发盖住颈部，再从发旋往下分束，不能露出一块肤色
      const backHead = ellipsePts(0, -R * 0.12, R * 0.82, R * 1.0, 0)
      hairGradient(backHead, 0.97, -R * 1.1, R * 0.9)
      brush(backHead, { w: 2.2, color: DAN.hairShade, close: true, alpha: 0.6, amp: 1.4 })
      const nape = [[-R * 0.42, R * 0.2], [R * 0.42, R * 0.2], [R * 0.3, R * 0.92], [0, R * 1.13], [-R * 0.3, R * 0.92]]
      charFill(nape, DAN.hairShade, { alpha: 0.97 })
      brush(nape, { w: 1.8, color: DAN.hairDeep, close: true, alpha: 0.55 })
      for (let i = -2; i <= 2; i += 1) {
        brush([[i * R * 0.11, R * 0.22], [i * R * 0.09 + R * 0.02, R * 0.62], [i * R * 0.05, R * 1.0]], { w: 1.2, color: i % 2 ? DAN.hair : DAN.hairDeep, alpha: 0.42 })
      }
      // 后脑：发旋 + 头饰背面 + 鳍耳，不露脸
      brush(ellipsePts(0, -R * 0.22, R * 0.34, R * 0.25, 0), { w: 1.8, color: DAN.hairLight, alpha: 0.55, close: true })
      brush([[0, -R * 0.22], [R * 0.18, R * 0.02], [R * 0.34, R * 0.18]], { w: 1.5, color: DAN.hairLight, alpha: 0.45 })
      drawBonnet(R, true)
      drawHeaddress(R, true)
      drawHeaddressBows(R)
      drawFinEars(R, cy)
      return
    }

    // 脸
    const face = ellipsePts(0, cy + R * 0.04, R * 0.73, R * 0.7, 0)
    charFill(face, DAN.skin, { alpha: 0.96 })
    brush(face, { w: 1.6, color: DAN.lineSoft, close: true, alpha: 0.3, amp: 1.2 })
    softShade(face, DAN.skinShade, 0.12, { x: -R * 0.32, y: R * 0.2, rx: R * 0.3, ry: R * 0.3 })
    // 刘海在额头投下的一层薄影 + 下巴的受光，脸不再是一块平的白塑料
    softShade(face, '#e9c3ba', 0.18, { x: 0, y: -R * 0.36, rx: R * 0.58, ry: R * 0.24 })
    softShade(face, '#fffdf8', 0.14, { x: R * 0.1, y: R * 0.42, rx: R * 0.34, ry: R * 0.18 })
    // 下巴小影
    brush([[-R * 0.24, R * 0.58], [0, R * 0.66], [R * 0.24, R * 0.58]], { w: 1.2, color: DAN.skinShade, alpha: 0.45 })

    drawFinEars(R, cy)
    drawBonnet(R, false)

    // 前发：中分刘海 + 尖角发束，不是头盔
    const bangs = [
      [-R * 0.74, -R * 0.3],
      [-R * 0.62, -R * 0.82],
      [-R * 0.32, -R * 0.98],
      [-R * 0.02, -R * 0.94],
      [R * 0.3, -R * 0.98],
      [R * 0.62, -R * 0.8],
      [R * 0.74, -R * 0.3],
      [R * 0.56, -R * 0.26],
      [R * 0.38, -R * 0.45],
      [R * 0.2, -R * 0.2],
      [R * 0.04, -R * 0.36],
      [-R * 0.12, -R * 0.16],
      [-R * 0.28, -R * 0.42],
      [-R * 0.44, -R * 0.24],
      [-R * 0.6, -R * 0.32],
    ]
    hairGradient(bangs, 0.96, -R * 1.0, R * 0.1)
    brush(catmull(bangs, true, 4), { w: 2.2, color: DAN.hairShade, close: true, alpha: 0.6, amp: 1.4 })
    // 三层斜刘海，让发际线有来处，不是一刀切的锅盖
    const bangsLocks = [
      [
        [-R * 0.62, -R * 0.86],
        [-R * 0.1, -R * 0.96],
        [R * 0.16, -R * 0.8],
        [R * 0.02, -R * 0.44],
        [-R * 0.22, -R * 0.16],
        [-R * 0.34, -R * 0.55],
      ],
      [
        [R * 0.3, -R * 0.96],
        [R * 0.62, -R * 0.78],
        [R * 0.55, -R * 0.44],
        [R * 0.3, -R * 0.12],
        [R * 0.16, -R * 0.42],
        [R * 0.24, -R * 0.72],
      ],
      [
        [-R * 0.2, -R * 0.94],
        [R * 0.02, -R * 0.9],
        [R * 0.08, -R * 0.64],
        [-R * 0.04, -R * 0.36],
        [-R * 0.16, -R * 0.6],
      ],
    ]
    for (const lock of bangsLocks) {
      hairGradient(lock, 0.97, -R * 0.9, -R * 0.1)
      brush(catmull(lock, true, 3), { w: 1.6, color: DAN.hairDeep, close: true, alpha: 0.38, amp: 1.2 })
    }
    // 发缝与高光：两道淡淡的反光，说明头发有厚度
    brush([[-R * 0.03, -R * 0.94], [-R * 0.08, -R * 0.56], [-R * 0.12, -R * 0.3]], { w: 1.2, color: DAN.hairLight, alpha: 0.28 })
    for (let i = -2; i <= 2; i += 1) {
      brush([[-R * 0.4 + i * R * 0.22, -R * 0.75], [-R * 0.26 + i * R * 0.22, -R * 0.45], [-R * 0.16 + i * R * 0.22, -R * 0.2]], { w: 1.1, color: DAN.hairLight, alpha: 0.35 })
    }
    // 刘海上的宽高光：不是一根根白线，是一整片被光照到的发面
    brush([[-R * 0.42, -R * 0.82], [-R * 0.12, -R * 0.84], [R * 0.16, -R * 0.72], [R * 0.34, -R * 0.54]], { w: 5.5, color: '#dfefff', alpha: 0.28, kind: 'marker' })
    brush([[-R * 0.34, -R * 0.7], [-R * 0.06, -R * 0.72], [R * 0.2, -R * 0.6]], { w: 2.2, color: '#f2f8ff', alpha: 0.36 })

    // 侧发：两缕垂到胸前，发梢青蓝
    for (const side of [-1, 1]) {
      const lock = [
        [side * R * 0.62, -R * 0.28],
        [side * R * 0.82, R * 0.04],
        [side * R * 0.96, R * 0.5],
        [side * R * 0.86, R * 0.82],
        [side * R * 0.96, R * 1.12],
        [side * R * 0.8, R * 1.46],
        [side * R * 0.88, R * 1.72],
        [side * R * 0.64, R * 1.92],
        [side * R * 0.54, R * 1.58],
        [side * R * 0.58, R * 1.2],
        [side * R * 0.5, R * 0.76],
        [side * R * 0.52, R * 0.3],
      ]
      hairGradient(lock, 0.95, -R * 0.5, R * 1.9)
      brush(catmull(lock, true, 4), { w: 2, color: DAN.hairShade, close: true, alpha: 0.55, amp: 1.7 })
      brush([[side * R * 0.72, R * 0.7], [side * R * 0.84, R * 1.18], [side * R * 0.76, R * 1.64]], { w: 1.4, color: DAN.hairTip, alpha: 0.45 })
    }

    // 呆毛：一根绕回来的粗发丝，不是头顶插了一块叶子
    const ahogeCurve = [
      [0, -R * 1.03],
      [-R * 0.04, -R * 1.2],
      [-R * 0.12, -R * 1.42],
      [R * 0.02, -R * 1.52],
      [R * 0.24, -R * 1.48],
      [R * 0.34, -R * 1.32],
      [R * 0.26, -R * 1.16],
      [R * 0.14, -R * 1.08],
    ]
    brush(ahogeCurve, { w: 6.5, color: DAN.hair, alpha: 0.92, amp: 1.4, kind: 'marker' })
    brush(ahogeCurve, { w: 4.2, color: DAN.hairLight, alpha: 0.45, amp: 1.3 })
    brush([[-R * 0.02, -R * 1.1], [-R * 0.05, -R * 1.34], [R * 0.02, -R * 1.5]], { w: 1.6, color: DAN.line, alpha: 0.55 })
    brush([[R * 0.18, -R * 1.14], [R * 0.32, -R * 1.24], [R * 0.38, -R * 1.4]], { w: 1.6, color: DAN.line, alpha: 0.5 })
    brush([[R * 0.12, -R * 1.3], [R * 0.18, -R * 1.45], [R * 0.3, -R * 1.44]], { w: 2, color: DAN.hairTip, alpha: 0.42 })

    drawHeaddress(R, false)
    drawHeaddressBows(R)
    drawFace(R, cy, mood)

    // 星星发夹 + 小鲸鱼挂坠
    drawStarPin(-R * 0.5, -R * 0.38, 1)
    drawStarPin(R * 0.58, -R * 0.42, 0.7)
    brush([[R * 0.66, -R * 0.1], [R * 0.78, R * 0.1], [R * 0.66, R * 0.3]], { w: 1, color: DAN.lineSoft, alpha: 0.4 })
    const charm = ellipsePts(R * 0.7, R * 0.36, 8, 10, 0.2)
    charFill(charm, DAN.cyan, { alpha: 0.7 })
    brush(charm, { w: 1, color: DAN.lineSoft, close: true, alpha: 0.45 })
    brush([[R * 0.7, R * 0.3], [R * 0.68, R * 0.26]], { w: 1.2, color: DAN.cyan, alpha: 0.35 })
  }

  function drawBonnet(R, back) {
    // 白荷叶边软帽：一整圈围着头，压在刘海后面，不是额头上一条白带
    const cy = -R * 0.08
    const radius = R * 1.02
    for (let i = 1; i < 8; i += 1) {
      const a = (-150 + i * 17.5) * (Math.PI / 180)
      const x = Math.cos(a) * radius
      const y = cy + Math.sin(a) * radius
      const petal = ellipsePts(x, y, R * 0.14, R * 0.085, 0, 20)
      charFill(petal, DAN.frill, { alpha: 0.97 })
      brush(petal, { w: 0.8, color: DAN.lineSoft, close: true, alpha: 0.24, amp: 0.7 })
      // 褶边内侧的阴影，别让一圈白瓣变成珍珠项链
      brush([[x - R * 0.1, y + R * 0.03], [x, y + R * 0.07], [x + R * 0.1, y + R * 0.03]], { w: 0.65, color: DAN.apronShade, alpha: 0.45 })
    }
    // 帽圈底色，把白瓣连成一片
    const hoop = []
    for (let i = 0; i <= 20; i += 1) {
      const a = (-150 + i * 6.25) * (Math.PI / 180)
      hoop.push([Math.cos(a) * R * 0.99, cy + Math.sin(a) * R * 0.99])
    }
    for (let i = 20; i >= 0; i -= 1) {
      const a = (-150 + i * 6.25) * (Math.PI / 180)
      hoop.push([Math.cos(a) * R * 0.88, cy + Math.sin(a) * R * 0.88])
    }
    charFill(hoop, DAN.frill, { alpha: 0.95 })
    brush(hoop, { w: 1, color: DAN.lineSoft, close: true, alpha: 0.26, amp: 0.8 })
  }

  function drawHeaddress(R, back) {
    // 前面只留一条窄窄的藏青发箍，白荷叶边已经由软帽铺在后面
    const band = [
      [-R * 0.7, -R * 0.84],
      [-R * 0.4, -R * 0.93],
      [0, -R * 0.95],
      [R * 0.4, -R * 0.93],
      [R * 0.7, -R * 0.84],
      [R * 0.68, -R * 0.78],
      [0, -R * 0.87],
      [-R * 0.68, -R * 0.78],
    ]
    charFill(band, DAN.dressDark, { alpha: 0.92 })
    brush(band, { w: 1, color: DAN.line, close: true, alpha: 0.4, amp: 0.7 })
    // 发箍上缘一道很细的白边，和软帽接上
    brush([[-R * 0.68, -R * 0.83], [0, -R * 0.95], [R * 0.68, -R * 0.83]], { w: 1.4, color: DAN.frill, alpha: 0.9 })
    if (back) {
      // 背面：发箍沿后脑压一条弧
      brush([[-R * 0.5, -R * 0.55], [0, -R * 0.62], [R * 0.5, -R * 0.55]], { w: 5, color: DAN.dressDark, alpha: 0.85 })
    }
  }

  function drawHeaddressBows(R) {
    // 两侧蓝色小蝴蝶结：女仆头饰的第二个识别点
    drawBow(-R * 0.8, -R * 0.62, 0.72, DAN.hairLight, DAN.hairDeep)
    drawBow(R * 0.8, -R * 0.62, 0.72, DAN.hairLight, DAN.hairDeep)
    // 白色细带垂到耳侧
    brush([[-R * 0.64, -R * 0.66], [-R * 0.8, -R * 0.28], [-R * 0.88, R * 0.05]], { w: 1.5, color: DAN.frill, alpha: 0.82 })
    brush([[R * 0.64, -R * 0.66], [R * 0.8, -R * 0.28], [R * 0.88, R * 0.05]], { w: 1.5, color: DAN.frill, alpha: 0.82 })
  }

  function drawFinEars(R, cy) {
    for (const side of [-1, 1]) {
      const x = side * R * 0.72
      const ear = [
        [x, cy - R * 0.02],
        [x + side * R * 0.28, cy - R * 0.28],
        [x + side * R * 0.46, cy - R * 0.34],
        [x + side * R * 0.4, cy - R * 0.08],
        [x + side * R * 0.48, cy + R * 0.1],
        [x + side * R * 0.26, cy + R * 0.16],
        [x, cy + R * 0.2],
      ]
      fillGradient(ear, [[0, DAN.hairDeep], [0.6, DAN.hair], [1, DAN.hairLight]], {
        alpha: 0.85, y1: cy - R * 0.4, y2: cy + R * 0.2, dots: 18,
      })
      brush(ear, { w: 2.1, color: DAN.line, close: true, alpha: 0.65, amp: 1.5 })
      // 内侧白膜与鳍条
      const membrane = [
        [x + side * R * 0.06, cy + R * 0.02],
        [x + side * R * 0.2, cy - R * 0.18],
        [x + side * R * 0.34, cy - R * 0.2],
        [x + side * R * 0.3, cy - R * 0.02],
        [x + side * R * 0.34, cy + R * 0.08],
        [x + side * R * 0.16, cy + R * 0.1],
      ]
      charFill(membrane, DAN.frill, { alpha: 0.78 })
      brush(membrane, { w: 1, color: DAN.lineSoft, close: true, alpha: 0.4 })
      for (let i = 0; i < 4; i += 1) {
        brush([
          [x + side * R * 0.08, cy + R * 0.01],
          [x + side * R * (0.18 + i * 0.06), cy - R * (0.14 - i * 0.06)],
        ], { w: 0.9, color: DAN.lineSoft, alpha: 0.4 })
      }
      // 珍珠耳坠 + 小鲸鱼挂饰
      brush([[x + side * R * 0.04, cy + R * 0.2], [x + side * R * 0.1, cy + R * 0.36]], { w: 0.8, color: DAN.lineSoft, alpha: 0.4 })
      for (let i = 0; i < 2; i += 1) {
        ctx.beginPath()
        ctx.fillStyle = DAN.pearl
        ctx.globalAlpha = 0.85
        ctx.arc(x + side * R * 0.1, cy + R * (0.38 + i * 0.1), 3.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  function drawStarPin(x, y, s) {
    const pts = [
      [x, y - 14 * s], [x + 4 * s, y - 3 * s], [x + 14 * s, y], [x + 4 * s, y + 3 * s],
      [x, y + 14 * s], [x - 4 * s, y + 3 * s], [x - 14 * s, y], [x - 4 * s, y - 3 * s],
    ]
    charFill(pts, DAN.gold, { alpha: 0.92 })
    brush(pts, { w: 1.2, color: DAN.lineSoft, close: true, alpha: 0.5 })
    brush([[x, y - 8 * s], [x, y + 8 * s]], { w: 0.8, color: DAN.frill, alpha: 0.6 })
  }

  function drawEye(x, y, R, kind, flip, lifted) {
    const sc = flip ? -1 : 1
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(sc, 1)
    if (kind === 'closed' || kind === 'happy') {
      brush([[-24, 2], [-10, kind === 'happy' ? -13 : -7], [10, kind === 'happy' ? -13 : -5], [24, 0]], { w: 4, color: DAN.line, amp: 1.2 })
      // 下睫毛
      brush([[-16, -1], [-8, 5], [0, 7]], { w: 1.2, color: DAN.lineSoft, alpha: 0.5 })
      ctx.restore()
      return
    }
    // 眼白
    const sclera = [
      [-25, -14], [-14, -23], [8, -24], [23, -12], [24, 4],
      [13, 19], [-4, 20], [-20, 10], [-26, -4],
    ]
    charFill(sclera, '#fcf8f2', { alpha: 0.98 })
    // 眼珠：深蓝外圈 → 青蓝内芯，不画成两颗死黑点
    const iris = ellipsePts(0, 1, 19, 21, 0, 32)
    ctx.save()
    ctx.clip(polyPath(iris))
    const grad = ctx.createRadialGradient(-4, -4, 2, 0, 1, 22)
    grad.addColorStop(0, '#8fd3ee')
    grad.addColorStop(0.34, '#4f9fd4')
    grad.addColorStop(0.72, '#244b98')
    grad.addColorStop(1, '#111d48')
    ctx.globalAlpha = 0.96
    ctx.fillStyle = grad
    ctx.fillRect(-40, -40, 80, 80)
    ctx.restore()
    brush(iris, { w: 1.8, color: DAN.line, close: true, alpha: 0.7 })
    // 上眼睑压线 + 下睫毛，眼睛才不是贴上去的玻璃球
    brush([[-22, -25], [-9, -31], [8, -29], [22, -20]], { w: 1.3, color: DAN.lineSoft, alpha: 0.35 })
    brush([[8, 18], [17, 15], [25, 7]], { w: 1.3, color: DAN.lineSoft, alpha: 0.45, amp: 0.8 })
    // 瞳孔
    const pupil = kind === 'small' ? ellipsePts(0, 3, 7, 9, 0) : ellipsePts(0, 2, 10, 13, 0)
    charFill(pupil, '#11152e', { alpha: 0.92 })
    // 高光：一大一小，像真的玻璃珠
    ctx.save()
    ctx.fillStyle = '#ffffff'
    ctx.globalAlpha = 0.96
    ctx.beginPath()
    ctx.arc(-7, -6, kind === 'small' ? 4 : 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 0.8
    ctx.beginPath()
    ctx.arc(8, 9, 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    if (kind === 'star') {
      for (let i = 0; i < 2; i += 1) {
        const sx = i ? 8 : -10
        const sy = i ? 9 : -12
        const r = i ? 7 : 10
        charFill([[sx, sy - r], [sx + r * 0.4, sy - r * 0.3], [sx + r, sy], [sx + r * 0.4, sy + r * 0.3], [sx, sy + r], [sx - r * 0.4, sy + r * 0.3], [sx - r, sy], [sx - r * 0.4, sy - r * 0.3]], DAN.gold, { alpha: 0.95 })
      }
    }
    if (kind === 'heart') {
      const heart = [[-8, -3], [-13, -12], [-2, -6], [0, -2], [2, -6], [13, -12], [8, -3], [0, 8]]
      charFill(heart, '#e47b83', { alpha: 0.85 })
      brush(heart, { w: 1, color: DAN.line, close: true, alpha: 0.4 })
    }
    // 上睫毛 / 眼线
    if (lifted) {
      // 半睁：眼皮压低
      ctx.save()
      ctx.globalAlpha = 0.96
      ctx.beginPath()
      ctx.clip(polyPath(sclera))
      ctx.fillStyle = DAN.skin
      ctx.rect(-40, -40, 80, 24)
      ctx.fill()
      ctx.restore()
      brush([[-27, -6], [-8, 0], [14, 2], [25, 8]], { w: 4.2, color: DAN.line, amp: 0.9 })
    } else {
      brush([[-27, -12], [-12, -23], [8, -24], [24, -13], [27, -4]], { w: 4.6, color: DAN.line, amp: 0.9 })
      // 外眼角三根小睫毛
      for (let i = 0; i < 3; i += 1) {
        brush([[22 + i * 2, -12 + i * 2], [30 + i * 2, -20 + i * 4]], { w: 1.1, color: DAN.line, alpha: 0.6 })
      }
    }
    // 下眼睑
    brush([[-18, 18], [-2, 22], [16, 16]], { w: 1.1, color: DAN.lineSoft, alpha: 0.45 })
    ctx.restore()
  }

  function drawFace(R, cy, mood) {
    const ex = R * 0.35
    const ey = cy + R * 0.12
    const ink = DAN.line
    const cfg = {
      happy: { eye: 'open', mouth: 'smile', brow: 0, cheek: 0.4 },
      excited: { eye: 'star', mouth: 'open', brow: -1, cheek: 0.45 },
      proud: { eye: 'half', mouth: 'smirk', brow: 2, cheek: 0.28 },
      calm: { eye: 'open', mouth: 'small', brow: 0, cheek: 0.3 },
      blank: { eye: 'small', mouth: 'o', brow: 0, cheek: 0.22 },
      sleepy: { eye: 'closed', mouth: 'small', brow: 1, cheek: 0.28 },
      wronged: { eye: 'wet', mouth: 'wavy', brow: -2, cheek: 0.4 },
      sad: { eye: 'down', mouth: 'flat', brow: -1, cheek: 0.3 },
    }[mood] || { eye: 'open', mouth: 'small', brow: 0, cheek: 0.3 }

    for (const side of [-1, 1]) {
      if (cfg.eye === 'down') {
        // 难过：眼尾下垂，瞳仁往下
        ctx.save()
        ctx.translate(side * ex, ey + 4)
        ctx.rotate(side * 0.12)
        drawEye(0, 0, R, 'open', side < 0, false)
        ctx.restore()
        brush([[side * ex - 24, ey + 8], [side * ex, ey + 16], [side * ex + 24, ey + 6]], { w: 2.6, color: ink, alpha: 0.65 })
      } else if (cfg.eye === 'half') {
        drawEye(side * ex, ey, R, 'open', side < 0, true)
        brush([[side * ex - 18, ey - 12], [side * ex + 18, ey - 8]], { w: 3.6, color: ink, alpha: 0.8 })
      } else if (cfg.eye === 'wet') {
        drawEye(side * ex, ey, R, 'open', side < 0, false)
        brush([[side * ex - 14, ey + 22], [side * ex - 8, ey + 38], [side * ex + 2, ey + 26]], { w: 2.2, color: '#7fb7d9', alpha: 0.7 })
      } else if (cfg.eye === 'star') {
        drawEye(side * ex, ey, R, 'star', side < 0, false)
      } else if (cfg.eye === 'small') {
        drawEye(side * ex, ey + 2, R, 'small', side < 0, false)
        brush([[side * ex - 20, ey - 14], [side * ex + 18, ey - 10]], { w: 2.4, color: ink, alpha: 0.65 })
      } else {
        drawEye(side * ex, ey, R, cfg.eye, side < 0, false)
      }
    }

    // 眉毛：细、轻，不抢眼睛
    if (cfg.brow || cfg.eye === 'half') {
      for (const side of [-1, 1]) {
        const bx = side * (ex + 4)
        const lift = (cfg.brow || 0) * 3.5
        brush([[bx - 16, ey - 27], [bx - 2, ey - 31 - lift], [bx + 16, ey - 26 - lift]], { w: 1.8, color: DAN.lineSoft, alpha: 0.55, amp: 1.2 })
      }
    }

    // 鼻子：一个小点，不画成鼻子轮廓
    ctx.save()
    ctx.fillStyle = DAN.skinShade
    ctx.globalAlpha = 0.55
    ctx.beginPath()
    ctx.arc(0, cy + R * 0.3, 2.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    // 嘴
    const my = cy + R * 0.47
    if (cfg.mouth === 'open') {
      const mouth = [[-15, my - 4], [0, my - 8], [16, my - 3], [12, my + 12], [0, my + 16], [-12, my + 10]]
      charFill(mouth, '#b84e5a', { alpha: 0.85 })
      brush(mouth, { w: 1.8, color: DAN.line, close: true, alpha: 0.55 })
      charFill(ellipsePts(0, my + 10, 8, 4, 0), '#e98b91', { alpha: 0.7 })
    } else if (cfg.mouth === 'smirk') {
      brush([[-14, my + 2], [4, my - 2], [17, my - 8]], { w: 2, color: DAN.line, amp: 1 })
      brush([[10, my - 7], [16, my - 6]], { w: 1.2, color: DAN.lineSoft, alpha: 0.4 })
    } else if (cfg.mouth === 'wavy') {
      brush([[-15, my], [-7, my - 6], [2, my + 4], [10, my - 2], [16, my + 1]], { w: 1.8, color: DAN.line, amp: 1.2 })
    } else if (cfg.mouth === 'flat') {
      brush([[-13, my + 4], [0, my + 1], [13, my + 4]], { w: 1.5, color: DAN.line, alpha: 0.7 })
    } else if (cfg.mouth === 'o') {
      brush(ellipsePts(0, my + 2, 8, 10, 0), { w: 1.8, color: DAN.line, close: true, alpha: 0.7 })
    } else {
      brush([[-12, my - 3], [0, my + 5], [12, my - 3]], { w: 1.8, color: DAN.line, amp: 1.1 })
      brush([[0, my + 5], [0, my + 9]], { w: 1, color: DAN.lineSoft, alpha: 0.4 })
    }

    // 腮红：斜线小排线，不是两块圆贴纸
    for (const side of [-1, 1]) {
      const cx = side * R * 0.49
      const cyy = cy + R * 0.34
      charFill(ellipsePts(cx, cyy, 19, 11, side * 0.08), DAN.blush, { alpha: cfg.cheek })
      for (let i = 0; i < 4; i += 1) {
        brush([[cx - 14 + i * 7, cyy + 6], [cx - 8 + i * 7, cyy - 5]], { w: 1, color: '#d77f83', alpha: 0.35 })
      }
    }

    // 表情附加：困的 Zzz、委屈/难过的泪、兴奋的小星星
    if (mood === 'sleepy') {
      for (let i = 0; i < 3; i += 1) {
        const s = 12 + i * 8
        const x = R * 0.68 + i * 18
        const y = cy - R * 0.55 - i * 18
        brush([[x, y], [x + s, y], [x + s * 0.7, y + s * 0.7], [x + s, y + s]], { w: 2, color: DAN.line, alpha: 0.55, amp: 0.8 })
      }
    }
    if (mood === 'wronged' || mood === 'sad') {
      for (const side of [-1, 1]) {
        brush([[side * ex - 3, ey + 26], [side * ex - 1, ey + 42]], { w: 1.2, color: '#7fb7d9', alpha: 0.6 })
      }
    }
    if (mood === 'excited') {
      for (let i = 0; i < 4; i += 1) {
        const a = -0.8 + i * 0.55
        const x = Math.cos(a) * R * 0.9
        const y = cy - R * 0.75 + Math.sin(a) * R * 0.16
        drawStarPin(x, y, 0.35)
      }
    }
  }

  // 表情包的道具只取一个语义符号，放在手边，不把整张 GIF 贴上去。
  function drawStickerMotif(R, bodyH, pose) {
    const motif = plan.sticker?.motif
    if (!motif || pose === 'back') return
    const x = R * 0.98
    const y = bodyH * 0.56
    if (motif === 'heart') {
      const heart = [[x - 16, y - 2], [x - 24, y - 18], [x - 4, y - 10], [x, y - 4], [x + 4, y - 10], [x + 24, y - 18], [x + 16, y - 2], [x, y + 16]]
      charFill(heart, '#e57d87', { alpha: 0.8 })
      brush(heart, { w: 1.5, color: DAN.line, close: true, alpha: 0.4 })
      brush([[x - 12, y - 10], [x - 7, y - 13], [x - 4, y - 10]], { w: 1.2, color: DAN.frill, alpha: 0.6 })
    } else if (motif === 'gift') {
      const box = rectPts(x - 24, y - 8, 48, 40)
      charFill(box, DAN.cyan, { alpha: 0.7 })
      brush(box, { w: 2, color: DAN.line, close: true, alpha: 0.45 })
      brush([[x - 26, y + 2], [x + 26, y + 2]], { w: 4, color: DAN.gold, alpha: 0.75 })
      brush([[x, y - 8], [x, y + 32]], { w: 4, color: DAN.gold, alpha: 0.75 })
      drawBow(x, y - 12, 0.5, DAN.gold, DAN.lineSoft)
      drawStarPin(x - 18, y - 18, 0.5)
    } else if (motif === 'mic') {
      const head = ellipsePts(x, y, 13, 22, 0.2)
      charFill(head, '#424762', { alpha: 0.85 })
      brush(head, { w: 2, color: DAN.line, close: true, alpha: 0.55 })
      brush([[x + 4, y + 18], [x - 4, y + 42], [x - 18, y + 46]], { w: 2.4, color: DAN.line, alpha: 0.7 })
      brush([[x - 2, y - 24], [x - 2, y - 34]], { w: 1, color: DAN.lineSoft, alpha: 0.35 })
    } else if (motif === 'bottle') {
      const body = [[x - 18, y - 4], [x + 18, y - 4], [x + 15, y + 30], [x - 15, y + 30]]
      charFill(body, DAN.frill, { alpha: 0.8 })
      brush(body, { w: 1.8, color: DAN.line, close: true, alpha: 0.45 })
      const nipple = ellipsePts(x, y - 12, 12, 9, 0)
      charFill(nipple, '#f0c3a0', { alpha: 0.8 })
      brush(nipple, { w: 1, color: DAN.lineSoft, close: true, alpha: 0.35 })
      brush([[x - 18, y + 10], [x + 18, y + 10]], { w: 1, color: DAN.hairLight, alpha: 0.4 })
    } else if (motif === 'tear') {
      const drop = [[x, y - 24], [x + 10, y - 6], [x + 6, y + 10], [x - 6, y + 10], [x - 10, y - 6]]
      charFill(drop, '#8fc5e0', { alpha: 0.8 })
      brush(drop, { w: 1.2, color: DAN.lineSoft, close: true, alpha: 0.35 })
    } else if (motif === 'star') {
      drawStarPin(x, y, 0.9)
      drawStarPin(x + 20, y + 18, 0.45)
    } else if (motif === 'shell' || motif === 'cup') {
      if (motif === 'shell') objShell(x, y, 0.55, DAN.lineSoft)
      else objCup(x, y, 0.55, DAN.lineSoft)
    }
  }

  /** 挥手的手臂最后再压一遍，确保不会被长发和袖子盖住。 */
  function drawWaveOverlay(R) {
    const sx = R * 0.68
    const top = R * 1.16
    const ex = R * 0.95
    const ey = R * 1.08
    const hx = R * 1.28
    const hy = -R * 0.16
    // 先把袖管画在头发上面，再把手臂接出来，避免只有一条粉色面条浮在长发外
    brush([[sx, top + 6], [ex, ey], [hx, hy + 14]], { w: 18, color: DAN.skin, amp: 1.4 })
    brush([[ex, ey], [hx, hy + 12]], { w: 14, color: DAN.skinHand, amp: 1.2 })
    brush([[ex - 5, ey - 7], [ex, ey + 4], [ex + 6, ey - 6]], { w: 1.1, color: DAN.lineSoft, alpha: 0.45 })
    const sleeve = ellipsePts(sx, top + 8, 27, 24, 0.08)
    fillGradient(sleeve, [[0, DAN.dressLight], [0.45, DAN.dress], [1, DAN.dressDark]], {
      alpha: 0.95, y1: top - 14, y2: top + 36, dots: 18,
    })
    brush(sleeve, { w: 1.9, color: DAN.line, close: true, alpha: 0.55, amp: 1.3 })
    charHatch(sleeve, DAN.dressDark, { gap: 11, angle: 1.0, alpha: 0.12, w: 0.8 })
    for (let i = -2; i <= 2; i += 1) {
      const lx = sx + i * R * 0.07
      const ly = top + R * 0.3 + Math.abs(i) * 2
      const lace = ellipsePts(lx, ly, R * 0.046, R * 0.028, 0, 16)
      charFill(lace, DAN.frill, { alpha: 0.96 })
      brush(lace, { w: 0.8, color: DAN.lineSoft, close: true, alpha: 0.32 })
    }
    const cuff = ellipsePts(hx, hy + 14, 13, 7, 0.06)
    charFill(cuff, DAN.frill, { alpha: 0.98 })
    brush(cuff, { w: 1.1, color: DAN.lineSoft, close: true, alpha: 0.4 })
    for (let i = -2; i <= 2; i += 1) {
      brush([[hx - 9 + i * 5, hy + 9], [hx - 8 + i * 5, hy + 19]], { w: 0.7, color: DAN.apronShade, alpha: 0.45 })
    }
    const hand = ellipsePts(hx, hy + 1, 14.5, 16, 0.12)
    charFill(hand, DAN.skinHand, { alpha: 0.98 })
    softShade(hand, DAN.skinShade, 0.28, { x: hx + 5, y: hy + 9, rx: 11, ry: 8 })
    brush(hand, { w: 1.5, color: DAN.line, close: true, alpha: 0.65 })
    for (let i = 0; i < 4; i += 1) {
      const fx = hx - 9 + i * 5.8
      brush([[fx, hy - 2], [fx + 2, hy - 18]], { w: 1.3, color: DAN.skinShade, alpha: 0.65 })
      brush([[fx, hy - 2], [fx + 2, hy - 18]], { w: 0.8, color: DAN.skinHand, alpha: 0.5 })
    }
    brush([[hx + 10, hy + 8], [hx + 16, hy - 2]], { w: 1.3, color: DAN.skinShade, alpha: 0.55 })
  }  // ---------------------------------------------------------------- 草稿层
  function drawSketch() {
    const alpha = 0.18 + (plan.draft || 0.3) * 0.2
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = '#8fa6b8'
    ctx.lineWidth = 1.6
    const c = compositionAnchor()
    // 头/身体的构图圆与轴线
    ctx.beginPath()
    ctx.arc(c.x, c.y - 60 * c.s, 100 * c.s, 0.2, Math.PI * 1.7)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(c.x - 90 * c.s, c.y + 130 * c.s)
    ctx.lineTo(c.x + 90 * c.s, c.y + 130 * c.s)
    ctx.stroke()
    // 地平线
    ctx.beginPath()
    ctx.moveTo(60, H - 120)
    ctx.lineTo(W - 60, H - 116)
    ctx.stroke()
    // 物件的定位圈不要画成一排靶子，留几笔很淡的起稿线就够了
    const slots = OBJ_SLOTS[plan.composition] || OBJ_SLOTS['left-low']
    ;(plan.objects || []).forEach((_, i) => {
      const slot = slots[i % slots.length]
      const sx = slot[0] * W
      const sy = slot[1] * H
      ctx.beginPath()
      ctx.moveTo(sx - 34, sy + 12)
      ctx.bezierCurveTo(sx - 18, sy - 8, sx + 10, sy - 16, sx + 32, sy - 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(sx - 26, sy + 28)
      ctx.lineTo(sx + 20, sy + 25)
      ctx.stroke()
    })
    ctx.restore()
    drawMarginStudies(c)
  }

  /** 速写本边角的小稿：和主画无关，但证明这是有人在纸上试笔。 */
  function drawMarginStudies(c) {
    const onLeft = c.x > W * 0.55
    const baseX = onLeft ? W * 0.08 : W * 0.84
    const baseY = H * (0.3 + (hash1(plan.seed, 41) - 0.5) * 0.1)
    ctx.save()
    ctx.globalAlpha = 0.42
    // 1) 鲸鱼背鳍/尾鳍的小结构
    brush([[baseX, baseY], [baseX + 42, baseY - 20], [baseX + 74, baseY + 2], [baseX + 58, baseY + 14], [baseX + 18, baseY + 12]], { w: 1.1, color: '#7b93a8', close: true, alpha: 0.5, amp: 1.1 })
    brush([[baseX + 52, baseY - 12], [baseX + 66, baseY - 34], [baseX + 78, baseY - 8]], { w: 0.9, color: '#7b93a8', alpha: 0.45 })
    brush([[baseX + 20, baseY + 22], [baseX + 54, baseY + 20]], { w: 0.7, color: '#7b93a8', alpha: 0.35 })
    // 2) 眼睛的结构草稿
    const ex = baseX + 24
    const ey = baseY + 96
    brush(ellipsePts(ex, ey, 22, 26, 0, 20), { w: 0.9, color: '#7b93a8', close: true, alpha: 0.4 })
    brush([[ex, ey - 24], [ex, ey + 18]], { w: 0.7, color: '#7b93a8', alpha: 0.3 })
    brush([[ex - 18, ey], [ex + 16, ey]], { w: 0.7, color: '#7b93a8', alpha: 0.3 })
    // 3) 贝壳螺旋
    const sx = baseX + 58
    const sy = baseY + 128
    for (let i = 0; i < 4; i += 1) {
      brush([[sx, sy], [sx + 6 + i * 6, sy - 8 - i * 2], [sx + 10 + i * 7, sy + 4 + i * 2]], { w: 0.7, color: '#7b93a8', alpha: 0.35 })
    }
    // 4) 手的小指节
    if (plan.pose === 'wave' || plan.pose === 'stand') {
      const hx = baseX + 8
      const hy = baseY + 178
      for (let i = 0; i < 4; i += 1) {
        brush([[hx + i * 5, hy], [hx + i * 5 + 2, hy + 24]], { w: 0.7, color: '#7b93a8', alpha: 0.3 })
      }
    }
    ctx.restore()
  }

  function compositionAnchor() {
    const id = plan.composition || 'left-low'
    const child = plan.character?.ageGroup !== 'teen'
    const total = child ? 380 : 470
    const s = child ? 1.45 : 1.25
    if (plan.pose === 'peek') return { x: W * 0.52, y: H * 0.86, s: 2.0, bust: true, peek: true }
    if (plan.pose === 'sleep') return { x: W * 0.58, y: H * 0.9 - 380 * 1.45, s: 1.45, rot: -3 }
    if (plan.pose === 'tummy') return { x: W * 0.54, y: H * 0.54, s: 1.55 }
    if (plan.pose === 'bike') return { x: W * 0.53, y: H * 0.37, s: 1.35 }
    if (plan.pose === 'chair') return { x: W * 0.54, y: H * 0.94 - total * 1.5, s: 1.5 }
    if (plan.pose === 'floor') return { x: W * 0.5, y: H * 0.94 - total * 1.5, s: 1.5 }
    if (plan.pose === 'hold') return { x: W * 0.5, y: H * 0.94 - total * 1.5, s: 1.5 }
    if (plan.pose === 'walk') {
      if (id === 'right-full') return { x: W * 0.72, y: H * 0.94 - total * 1.48, s: 1.48 }
      if (id === 'top-left') return { x: W * 0.3, y: H * 0.94 - total * 1.4, s: 1.4 }
      if (id === 'diagonal') return { x: W * 0.63, y: H * 0.94 - total * 1.4, s: 1.4, rot: -5 }
      return { x: W * 0.4, y: H * 0.94 - total * 1.48, s: 1.48 }
    }
    if (id === 'center-bust') return { x: W * 0.6, y: H * 0.31, s: 2.0, bust: true }
    if (id === 'right-full') return { x: W * 0.72, y: H * 0.94 - total * 1.55, s: 1.55 }
    if (id === 'top-left') return { x: W * 0.3, y: H * 0.94 - total * 1.42, s: 1.42 }
    if (id === 'diagonal') return { x: W * 0.63, y: H * 0.94 - total * 1.42, s: 1.42, rot: -6 }
    if (id === 'back-view') return { x: W * 0.5, y: H * 0.95 - total * 1.52, s: 1.52 }
    return { x: W * 0.33, y: H * 0.94 - total * 1.55, s: 1.55 }
  }

  // ---------------------------------------------------------------- 文字
  function wrapLines(lines, font, maxWidth) {
    // 短句优先按句换行，避免把「枕头」这种词拆开
    if (lines.length > 1 && lines.every((line) => ctx.measureText(line).width <= maxWidth * 1.18)) {
      return lines.slice(0, 5)
    }
    const text = lines.join('')
    const chars = [...text]
    const widths = chars.map((ch) => ctx.measureText(ch).width)
    const total = widths.reduce((a, b) => a + b, 0)
    const count = Math.max(1, Math.min(5, Math.ceil(total / maxWidth)))
    if (count === 1) return [text]
    const out = []
    let start = 0
    for (let li = 0; li < count; li += 1) {
      const remainingLines = count - li
      if (remainingLines === 1) {
        out.push(chars.slice(start).join(''))
        break
      }
      const remainingWidth = widths.slice(start).reduce((a, b) => a + b, 0)
      const target = remainingWidth / remainingLines
      let acc = 0
      let end = start
      while (end < chars.length && acc < target) {
        acc += widths[end]
        end += 1
        if (acc >= target && '，。！？、；：'.includes(chars[end] || '')) {
          acc += widths[end] || 0
          end += 1
          break
        }
      }
      // 尽量在标点处断行，别把「眼睛」拆成两半
      for (let delta = 1; delta <= 4; delta += 1) {
        for (const j of [end - delta, end + delta]) {
          if (j > start + 3 && j < chars.length && '，。！？、；：'.includes(chars[j - 1])) {
            end = j
            delta = 99
            break
          }
        }
      }
      out.push(chars.slice(start, end).join(''))
      start = end
    }
    return out.slice(0, 6)
  }

  function drawHandText(lines, box) {
    const size = 44
    ctx.save()
    ctx.font = `${size}px LongCang, "Long Cang", sans-serif`
    ctx.textBaseline = 'top'
    const maxWidth = box.w * W
    const wrapped = wrapLines(lines, ctx.font, maxWidth)
    const lineH = size * 1.42
    let x = box.x * W
    let y = box.y * H
    if (box.align === 'right') x = (box.x + box.w) * W
    ctx.fillStyle = P.ink
    for (let li = 0; li < wrapped.length; li += 1) {
      const line = wrapped[li]
      const chars = [...line]
      const widths = chars.map((ch) => ctx.measureText(ch).width)
      const spacing = 1.6
      const lineWidth = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1)
      let cursor = box.align === 'right' ? (box.x + box.w) * W - lineWidth : x
      for (let ci = 0; ci < chars.length; ci += 1) {
        const ch = chars[ci]
        const w = widths[ci]
        const jx = (hash1(li * 37 + cursor, 9) - 0.5) * 7
        const jy = (hash1(li * 53 + cursor, 11) - 0.5) * 10
        const rot = (hash1(li * 71 + cursor, 13) - 0.5) * 0.14
        const sc = 0.92 + hash1(li * 91 + cursor, 15) * 0.16
        ctx.save()
        ctx.translate(cursor + w / 2 + jx, y + lineH * li + jy + lineH / 2)
        ctx.rotate(rot)
        ctx.scale(sc, sc)
        ctx.globalAlpha = 0.92
        ctx.fillText(ch, -w / 2, -size / 2)
        ctx.restore()
        cursor += w + spacing
      }
    }
    ctx.restore()
    return wrapped.length
  }

  function drawSignature() {
    const text = String(plan.signature || '蛋蛋')
    ctx.save()
    ctx.font = '40px LongCang, "Long Cang", sans-serif'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = P.ink
    ctx.globalAlpha = 0.85
    ctx.translate(W - 92, H - 92)
    ctx.rotate(-0.06 + (hash1(plan.seed, 21) - 0.5) * 0.02)
    let x = 0
    for (const ch of text) {
      const w = ctx.measureText(ch).width
      ctx.save()
      ctx.translate(x, (hash1(x, 23) - 0.5) * 3)
      ctx.rotate((hash1(x, 25) - 0.5) * 0.08)
      ctx.fillText(ch, 0, 0)
      ctx.restore()
      x += w + 1
    }
    // 落款下划线
    ctx.globalAlpha = 0.25
    ctx.strokeStyle = P.ink
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(-x - 2, 10)
    ctx.lineTo(6, 8)
    ctx.stroke()
    ctx.restore()
  }

  // ---------------------------------------------------------------- 主流程
  function render() {
    ctx.clearRect(0, 0, W, H)
    background()
    drawSceneBackdrop()

    drawSketch()

    const hasScene = sceneItems().length > 0
    if (hasScene) {
      drawSceneLayer('sky')
      drawSceneLayer('far')
      drawSceneLayer('ground')
      drawSceneLayer('mid')
      const c = compositionAnchor()
      drawCharacter(c.x, c.y, c.s, c.rot || 0, { bust: c.bust })
      drawSceneLayer('front')
    } else {
      // 兼容没有 scene 的旧 plan
      const objs = plan.objects || []
      const slots = OBJ_SLOTS[plan.composition] || OBJ_SLOTS['left-low']
      const behind = objs.slice(0, Math.ceil(objs.length / 2))
      const front = objs.slice(Math.ceil(objs.length / 2))
      drawObjectsOn(behind, slots, 0)
      const c = compositionAnchor()
      drawCharacter(c.x, c.y, c.s, c.rot || 0, { bust: c.bust })
      drawObjectsOn(front, slots, behind.length)
    }

    const grain = grainCanvas()
    applyGrain(grain)
    dust(160, 0.12)

    // 橡皮 / 手指蹭痕
    ctx.save()
    ctx.globalAlpha = 0.35
    ctx.fillStyle = P.paper
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath()
      ctx.ellipse(rr(80, W - 80), rr(H * 0.3, H - 100), rr(20, 60), rr(10, 26), rr(0, 1), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()

    drawHandText(plan.copy?.lines || [], plan.textBox || { x: 0.06, y: 0.1, w: 0.42, align: 'left' })
    drawSignature()

    // 轻微的纸边阴影
    ctx.save()
    ctx.strokeStyle = 'rgba(70,58,44,0.25)'
    ctx.lineWidth = 3
    ctx.strokeRect(4, 4, W - 8, H - 8)
    ctx.restore()
  }

  function drawObjectsOn(ids, slots, offset) {
    const tints = [P.accent, P.second, P.hair, '#c9a36b', '#8fae9b']
    ids.forEach((id, i) => {
      const fn = OBJECT_DRAW[id]
      if (!fn) return
      if (plan.pose === 'sleep' && id === 'pillow') {
        fn(W * 0.42, H * 0.68, 1.15, tints[0])
        return
      }
      const slot = slots[(i + offset) % slots.length]
      const x = slot[0] * W + rr(-14, 14)
      const y = slot[1] * H + rr(-14, 14)
      fn(x, y, rr(0.88, 1.08), tints[(i + offset) % tints.length])
    })
  }

  async function preloadSprites() {
    const entries = Object.entries(SPRITE_FILES)
    await Promise.all(entries.map(([key, file]) => new Promise((resolve) => {
      const img = new Image()
      img.onload = () => { spriteCache.set(key, img); resolve() }
      img.onerror = () => resolve()
      img.src = `/assets/draw/sprites/${file}`
    })))
  }

  // 画面里只允许内心独白和落款，其他任何文字都不画。
  async function boot() {
    try {
      await preloadSprites()
      if (document.fonts && typeof document.fonts.load === 'function') {
        await document.fonts.load('56px LongCang')
        await document.fonts.ready
      }
      render()
      window.__ready = true
    } catch (err) {
      window.__error = String((err && err.message) || err)
      window.__ready = false
    }
  }

  boot()
})()

