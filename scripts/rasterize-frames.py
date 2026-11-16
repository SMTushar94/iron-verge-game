#!/usr/bin/env python3
"""
Minimal software rasterizer for IRON VERGE render-command frames.

The demo normally draws via Canvas2D in a browser. No browser is available in
this sandbox, so `scripts/snapshot-frames.mjs` dumps the *actual* RenderFrame
command buffers to JSON and this script rasterizes them to PNG.

Supported command kinds: fill, rect, circle, poly, line, text(bbox only),
gradient(approx). Anti-aliasing is 3x3 supersampled scanline coverage.
Purely dependency-free (zlib + struct).
"""
import json
import math
import struct
import sys
import zlib


# ----------------------------------------------------------------- utilities
def hex_to_rgba(color: str, alpha: float = 1.0):
    c = color.strip()
    if c.startswith("rgba(") or c.startswith("rgb("):
        nums = c[c.index("(") + 1:c.rindex(")")].split(",")
        r, g, b = (int(float(n)) for n in nums[:3])
        a = float(nums[3]) if len(nums) > 3 else 1.0
        return (r, g, b, a * alpha)
    if c.startswith("#"):
        h = c[1:]
        if len(h) == 3:
            h = "".join(ch * 2 for ch in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        return (r, g, b, alpha)
    named = {"white": (255, 255, 255), "black": (0, 0, 0)}
    if c in named:
        return (*named[c], alpha)
    return (255, 0, 255, alpha)  # magenta = unparseable, loud on purpose


class Canvas:
    def __init__(self, w, h, bg=(10, 20, 32)):
        self.w, self.h = w, h
        self.px = bytearray(bytes(bg) * (w * h))

    def blend(self, x, y, rgba, coverage=1.0):
        if coverage <= 0.001:
            return
        r, g, b, a = rgba
        a *= coverage
        if a <= 0.001:
            return
        if x < 0 or y < 0 or x >= self.w or y >= self.h:
            return
        i = (y * self.w + x) * 3
        inv = 1.0 - a
        p = self.px
        p[i] = int(p[i] * inv + r * a)
        p[i + 1] = int(p[i + 1] * inv + g * a)
        p[i + 2] = int(p[i + 2] * inv + b * a)

    # -- primitives ---------------------------------------------------------
    def fill_polygon(self, pts, rgba, stroke=None, stroke_w=0.0, ss=3):
        if len(pts) < 3:
            return
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x0, x1 = max(0, int(math.floor(min(xs))) - 2), min(self.w - 1, int(math.ceil(max(xs))) + 2)
        y0, y1 = max(0, int(math.floor(min(ys))) - 2), min(self.h - 1, int(math.ceil(max(ys))) + 2)
        if x1 < x0 or y1 < y0:
            return
        n = len(pts)
        step = 1.0 / ss
        offsets = [k * step for k in range(ss)]
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                cov = 0
                for oy in offsets:
                    py = y + oy
                    for ox in offsets:
                        pxx = x + ox
                        inside = False
                        j = n - 1
                        for i in range(n):
                            xi, yi = pts[i]
                            xj, yj = pts[j]
                            if (yi > py) != (yj > py):
                                xint = xi + (py - yi) * (xj - xi) / (yj - yi)
                                if pxx < xint:
                                    inside = not inside
                            j = i
                        if inside:
                            cov += 1
                if cov:
                    self.blend(x, y, rgba, cov / (ss * ss))
        if stroke is not None and stroke_w > 0:
            for i in range(n):
                a = pts[i]
                b = pts[(i + 1) % n]
                self.line(a[0], a[1], b[0], b[1], stroke, stroke_w)

    def line(self, x1, y1, x2, y2, rgba, w=1.0):
        r = max(0.5, w / 2.0)
        minx, maxx = int(min(x1, x2) - r - 1), int(max(x1, x2) + r + 1)
        miny, maxy = int(min(y1, y2) - r - 1), int(max(y1, y2) + r + 1)
        dx, dy = x2 - x1, y2 - y1
        length2 = dx * dx + dy * dy
        if length2 < 1e-9:
            length2 = 1e-9
        for y in range(max(0, miny), min(self.h - 1, maxy) + 1):
            for x in range(max(0, minx), min(self.w - 1, maxx) + 1):
                t = ((x - x1) * dx + (y - y1) * dy) / length2
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                px, py = x1 + dx * t, y1 + dy * t
                d = math.hypot(x - px, y - py)
                cov = r + 0.5 - d
                if cov > 0:
                    self.blend(x, y, rgba, min(1.0, cov))

    def rect(self, x, y, w, h, rgba, stroke=None, sw=1.0, rot=0.0):
        if rot:
            cx, cy = x + w / 2, y + h / 2
            c, s = math.cos(rot), math.sin(rot)
            pts = []
            for px, py in ((x, y), (x + w, y), (x + w, y + h), (x, y + h)):
                ddx, ddy = px - cx, py - cy
                pts.append((cx + ddx * c - ddy * s, cy + ddx * s + ddy * c))
            self.fill_polygon(pts, rgba, stroke, sw)
            return
        self.fill_polygon([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], rgba, stroke, sw)

    def circle(self, cx, cy, r, rgba, stroke=None, sw=1.0, fill=True):
        if r <= 0:
            return
        x0, x1 = max(0, int(cx - r - 1)), min(self.w - 1, int(cx + r + 1))
        y0, y1 = max(0, int(cy - r - 1)), min(self.h - 1, int(cy + r + 1))
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
                if fill and d <= r:
                    self.blend(x, y, rgba, min(1.0, r + 0.5 - d))
                elif stroke is not None and abs(d - r) <= max(0.5, sw / 2):
                    self.blend(x, y, stroke, 1.0)

    def save_png(self, path):
        raw = bytearray()
        for y in range(self.h):
            raw.append(0)
            raw.extend(self.px[y * self.w * 3:(y + 1) * self.w * 3])
        def chunk(tag, data):
            return (struct.pack(">I", len(data)) + tag + data +
                    struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
        png = (b"\x89PNG\r\n\x1a\n"
               + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
               + chunk(b"IEND", b""))
        with open(path, "wb") as f:
            f.write(png)


# ------------------------------------------------------------------- renderer
def draw_cmd(cv: Canvas, cmd, xf):
    """xf: (ox, oy, scale) applied to coordinates."""
    ox, oy, sc = xf
    k = cmd.get("k")
    a = cmd.get("a", 1.0)
    if a is None:
        a = 1.0
    fill = hex_to_rgba(cmd["fill"], a) if cmd.get("fill") else None
    stroke = hex_to_rgba(cmd["stroke"], a) if cmd.get("stroke") else None
    sw = (cmd.get("sw") or 0) * sc

    if k == "rect":
        cv.rect(ox + cmd["x"] * sc, oy + cmd["y"] * sc, cmd["w"] * sc, cmd["h"] * sc,
                fill or (0, 0, 0, 0), stroke, sw, cmd.get("rot", 0.0))
    elif k == "poly":
        pts = [(ox + p["x"] * sc, oy + p["y"] * sc) for p in cmd["pts"]]
        cv.fill_polygon(pts, fill or (0, 0, 0, 0), stroke, sw)
    elif k == "circle":
        cv.circle(ox + cmd["x"] * sc, oy + cmd["y"] * sc, cmd["r"] * sc,
                  fill or (0, 0, 0, 0), stroke, sw, fill is not None)
    elif k == "line":
        col = hex_to_rgba(cmd["color"], a)
        cv.line(ox + cmd["x1"] * sc, oy + cmd["y1"] * sc,
                ox + cmd["x2"] * sc, oy + cmd["y2"] * sc, col, max(1.0, (cmd.get("w") or 1) * sc))
    elif k == "arc":
        col = hex_to_rgba(cmd["color"], a)
        steps = max(8, int(abs(cmd["end"] - cmd["start"]) * cmd["r"] / 4))
        prev = None
        for i in range(steps + 1):
            t = cmd["start"] + (cmd["end"] - cmd["start"]) * i / steps
            p = (ox + (cmd["x"] + math.cos(t) * cmd["r"]) * sc,
                 oy + (cmd["y"] + math.sin(t) * cmd["r"]) * sc)
            if prev:
                cv.line(prev[0], prev[1], p[0], p[1], col, max(1.0, (cmd.get("w") or 1) * sc))
            prev = p
    elif k == "text":
        # No font rasterizer here: draw a baseline tick so text anchors are visible.
        cx = ox + cmd["x"] * sc
        cy = oy + cmd["y"] * sc
        size = (cmd.get("size") or 12) * sc
        cv.line(cx, cy, cx + len(str(cmd.get("text", ""))) * size * 0.45, cy,
                hex_to_rgba(cmd["color"], a * 0.5), 1.0)
    elif k == "gradient":
        c0 = hex_to_rgba(cmd["from"], a)
        c1 = hex_to_rgba(cmd["to"], a)
        y0, h = cmd["y"], cmd["h"]
        for row in range(int(h * sc)):
            t = row / max(1, int(h * sc) - 1)
            col = tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3)) + (c0[3],)
            cv.rect(ox + cmd["x"] * sc, oy + (y0 * sc) + row, cmd["w"] * sc, 1, col)


def render(frame, out_path, vw=960, vh=540, scale=1.0):
    cv = Canvas(int(vw * scale), int(vh * scale))
    cam = frame.get("camera")
    for cmd in frame["screen"]:
        draw_cmd(cv, cmd, (0, 0, scale))
    if cam:
        z = cam.get("zoom", 1.0) * scale
        cx = (vw / 2 + cam.get("shakeX", 0)) * scale
        cy = (vh / 2 + cam.get("shakeY", 0)) * scale
        for cmd in frame["world"]:
            draw_cmd(cv, cmd, (cx - cam["x"] * z, cy - cam["y"] * z, z))
    for cmd in frame["overlay"]:
        draw_cmd(cv, cmd, (0, 0, scale))
    cv.save_png(out_path)
    return out_path


def contact_sheet(paths, out_path, cols=2):
    """Stack rendered PNGs into one sheet. Re-renders rather than decoding PNG."""
    raise NotImplementedError


def render_sheet(frames, out_path, cols=2, scale=0.6):
    """Rasterize several frames into a single grid image (no PNG decoding needed)."""
    vw, vh = 960, 540
    sw, sh = int(vw * scale), int(vh * scale)
    rows = (len(frames) + cols - 1) // cols
    sheet = Canvas(sw * cols, sh * rows, bg=(6, 12, 20))
    for idx, fr in enumerate(frames):
        tile = Canvas(sw, sh)
        cam = fr.get("camera")
        for cmd in fr["screen"]:
            draw_cmd(tile, cmd, (0, 0, scale))
        if cam:
            z = cam.get("zoom", 1.0) * scale
            cx = (vw / 2 + cam.get("shakeX", 0)) * scale
            cy = (vh / 2 + cam.get("shakeY", 0)) * scale
            for cmd in fr["world"]:
                draw_cmd(tile, cmd, (cx - cam["x"] * z, cy - cam["y"] * z, z))
        for cmd in fr["overlay"]:
            draw_cmd(tile, cmd, (0, 0, scale))
        ox = (idx % cols) * sw
        oy = (idx // cols) * sh
        for y in range(sh):
            src = y * sw * 3
            dst = ((oy + y) * sheet.w + ox) * 3
            sheet.px[dst:dst + sw * 3] = tile.px[src:src + sw * 3]
        # 1px frame divider
        for y in range(sh):
            sheet.px[(((oy + y) * sheet.w) + ox) * 3:(((oy + y) * sheet.w) + ox) * 3 + 3] = b"\x2c\x46\x58"
    sheet.save_png(out_path)
    return out_path


if __name__ == "__main__":
    with open(sys.argv[1]) as f:
        frames = json.load(f)
    out = sys.argv[2]
    scale = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    if "{}" in out:
        for i, fr in enumerate(frames):
            print(f"wrote {render(fr, out.replace('{}', str(i)), scale=scale)}")
    else:
        print(f"wrote {render_sheet(frames, out, cols=2, scale=scale)}")
