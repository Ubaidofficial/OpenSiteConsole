#!/usr/bin/env python3
"""
Generates the pixel art used on the website (site/assets/art/*.png). Run: python3 site/art/make_art.py

Everything is drawn from code with a fixed palette and a fixed random seed, so the images are reproducible, tiny (a few KB
each) and stay crisp when the page scales them up with `image-rendering: pixelated`. Several images are sprite sheets: the page
steps through their frames to animate them (and shows frame 0 for people who ask for less motion).
"""
import os, random
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'art')
os.makedirs(OUT, exist_ok=True)

C = {  # the palette: paper and ink like the site, lime like the brand, plus sand and sky for the landscape
    'K': '0d0d0f', 'D': '55555d', 'G': '9a9a92', 'g': 'dadad2', 'W': 'fbfbf8', 'P': 'f6f5ef',
    'L': 'c6ff4a', 'l': '9bd62b', 'm': '5e9e0e', 'n': '2f6b00',
    's': 'e9dcc2', 't': 'd6c3a0', 'u': 'bca57e', 'v': '917b59', 'w': '6b5a40',
    'b': '8cc8f5', 'B': 'cfe8f7', 'c': 'e6f3fa', 'r': 'e5484d', 'o': 'f5a524', 'y': 'fff3b0',
    'h': 'b9d9b0', 'j': 'a2c98f', 'k': '86b873',
}

def rgb(ch):
    h = C[ch]
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)

class Img:
    def __init__(self, w, h, bg=None):
        self.w, self.h = w, h
        self.im = Image.new('RGBA', (w, h), rgb(bg) if bg else (0, 0, 0, 0))
        self.px = self.im.load()
    def put(self, x, y, ch, a=255):
        if 0 <= x < self.w and 0 <= y < self.h and ch != '.':
            r, g, b, _ = rgb(ch)
            self.px[x, y] = (r, g, b, a)
    def rect(self, x, y, w, h, ch):
        for j in range(h):
            for i in range(w):
                self.put(x + i, y + j, ch)
    def hline(self, x, y, w, ch): self.rect(x, y, w, 1, ch)
    def vline(self, x, y, h, ch): self.rect(x, y, 1, h, ch)
    def sprite(self, x, y, art, flip=False, only=None, scale=1):
        rows = [r for r in art.strip('\n').split('\n')]
        for j, row in enumerate(rows):
            if flip: row = row[::-1]
            for i, ch in enumerate(row):
                if ch != '.' and (only is None or ch in only): self.rect(x + i * scale, y + j * scale, scale, scale, ch)
    def dither(self, x0, y0, x1, y1, top, bot, bayer=((0, 8, 2, 10), (12, 4, 14, 6), (3, 11, 1, 9), (15, 7, 13, 5))):
        """Vertical gradient from colour `top` to `bot` using an ordered (Bayer) dither: the classic pixel-art look."""
        for y in range(y0, y1):
            t = (y - y0) / max(1, (y1 - y0 - 1))
            for x in range(x0, x1):
                self.put(x, y, bot if t * 16 > bayer[y % 4][x % 4] else top)
    def blend_rect(self, x, y, w, h, ch, density):
        """A checkerboard-ish dither of one colour over what is already there (density 0..16)."""
        bay = ((0, 8, 2, 10), (12, 4, 14, 6), (3, 11, 1, 9), (15, 7, 13, 5))
        for j in range(h):
            for i in range(w):
                if density > bay[(y + j) % 4][(x + i) % 4]: self.put(x + i, y + j, ch)
    def halo(self, cx, cy, r, ch, density):
        bay = ((0, 8, 2, 10), (12, 4, 14, 6), (3, 11, 1, 9), (15, 7, 13, 5))
        for y in range(-r, r + 1):
            for x in range(-r, r + 1):
                d = (x * x + y * y) ** .5
                if d <= r and density * (1 - d / r) * 1.6 > bay[(cy + y) % 4][(cx + x) % 4]: self.put(cx + x, cy + y, ch)
    def circle(self, cx, cy, r, ch):
        for y in range(-r, r + 1):
            for x in range(-r, r + 1):
                if x * x + y * y <= r * r + r // 2: self.put(cx + x, cy + y, ch)
    def line(self, x0, y0, x1, y1, ch, dotted=False):
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err, n = dx + dy, 0
        while True:
            if not dotted or n % 3 != 2: self.put(x0, y0, ch)
            if x0 == x1 and y0 == y1: break
            e2 = 2 * err
            if e2 >= dy: err += dy; x0 += sx
            if e2 <= dx: err += dx; y0 += sy
            n += 1
    def save(self, name):
        self.im.save(os.path.join(OUT, name), optimize=True)
        return os.path.getsize(os.path.join(OUT, name))

def sheet(frames):
    """Frames side by side in one image (the page steps through them)."""
    w, h = frames[0].w, frames[0].h
    out = Img(w * len(frames), h)
    for i, f in enumerate(frames): out.im.paste(f.im, (i * w, 0))
    return out

# ── sprites ───────────────────────────────────────────────────────────────────
GEM = """
...KKK...
..KLLLK..
.KLWLLlK.
KLWLLLllK
KLLLLLlmK
.KLLLlmK.
..KLllK..
...KmK...
....K....
"""
GEM_DIM = """
...KKK...
..KlllK..
.KlWllmK.
KlWllllmK
KlllllmmK
.KlllmmK.
..KlmmK..
...KmK...
....K....
"""
SPARK = """
...W...
...W...
...W...
WWWyWWW
...W...
...W...
...W...
"""
SPARK_S = """
.W.
WyW
.W.
"""
CLOUD = """
.....WWWW.........
...WWWWWWWW..WWW..
.WWWWWWWWWWWWWWWW.
WWWWWWWWWWWWWWWWWW
gWWWWWWWWWWWWWWWWg
.ggggggggggggggggg
"""
CLOUD_S = """
...WWW.......
.WWWWWWW.WW..
WWWWWWWWWWWWW
gWWWWWWWWWWWg
.gggggggggggg
"""
DRONE = """
.......K.......
.......K.......
..KKKKKKKKKKK..
.KDDDDDDDDDDDK.
KDDKKKKKKKKKDDK
KDDKLLLLLLLKDDK
KDDKLWLLLLLKDDK
KDDKKKKKKKKKDDK
.KDDDDDDDDDDDK.
..KKKKKKKKKKK..
.KK.........KK.
KDDK.......KDDK
.KK.........KK.
"""
FLOWER = """
.r.
ryr
.r.
.m.
.m.
"""
TUFT = """
m.m.m
mmmmm
"""
TREE = """
...mmm...
..mmlmm..
.mmlllmm.
mmlllllmm
mmmlllmmm
.mmmmmmm.
...www...
...www...
...www...
"""
CURSOR = """
K.........
KK........
KWK.......
KWWK......
KWWWK.....
KWWWWK....
KWWWWWK...
KWWWWWWK..
KWWWWKKKK.
KWKWWK....
KK.KWWK...
K..KWWK...
....KWWK..
....KKKK..
"""
PHONE = """
.KKKKKKKK.
KDDDDDDDDK
KDWWWWWWDK
KDWWWWWWDK
KDWWWWWWDK
KDWWWWWWDK
KDWWWWWWDK
KDWWWWWWDK
KDWWWWWWDK
KDWWWWWWDK
KDWWWWWWDK
KDDDDDDDDK
KDDDKKDDDK
.KKKKKKKK.
"""
LAPTOP = """
..KKKKKKKKKKKKKK..
.KDDDDDDDDDDDDDDK.
.KDWWWWWWWWWWWWDK.
.KDWWWWWWWWWWWWDK.
.KDWWWWWWWWWWWWDK.
.KDWWWWWWWWWWWWDK.
.KDWWWWWWWWWWWWDK.
.KDDDDDDDDDDDDDDK.
KKKKKKKKKKKKKKKKKK
KGGGGGGGGGGGGGGGGK
.KKKKKKKKKKKKKKKK.
"""
SIGN = """
.wwwwwwwww.
wttttttttw
wtKKtKKtKw
wtKtKtKtKw
wtKKtKtKKw
wttttttttw
.wwwwwwwww.
....w.w....
....w.w....
....w.w....
"""
# 3x5 pixel letters for little signs and ranks
FONT = {
    'S': '.##|#..|.#.|..#|##.', 'E': '###|#..|##.|#..|###', 'O': '###|#.#|#.#|#.#|###', 'B': '##.|#.#|##.|#.#|##.',
    'G': '.##|#..|#.#|#.#|.##', '?': '##.|..#|.#.|...|.#.', '1': '.#.|##.|.#.|.#.|###', '2': '##.|..#|.#.|#..|###',
    '8': '###|#.#|###|#.#|###', '5': '###|#..|##.|..#|##.', '#': '#.#|###|#.#|###|#.#', '+': '...|.#.|###|.#.|...', '-': '...|...|###|...|...',
    '0': '###|#.#|#.#|#.#|###', '4': '#.#|#.#|###|..#|..#', '6': '###|#..|###|#.#|###', '7': '###|..#|.#.|.#.|.#.', '9': '###|#.#|###|..#|###', '3': '##.|..#|.#.|..#|##.', 'x': '...|#.#|.#.|#.#|...',
}
def text(img, x, y, s, ch):
    for k, c in enumerate(s):
        g = FONT.get(c)
        if not g: continue
        for j, row in enumerate(g.split('|')):
            for i, v in enumerate(row):
                if v == '#': img.put(x + k * 4 + i, y + j, ch)

def ridge(img, base, amp, freq, seed, colour, step=1, x0=0, x1=None):
    """A hilly skyline: filled below a sum of sines, as a bar-chart-like pixel ridge."""
    rnd = random.Random(seed)
    ph = [rnd.random() * 6.28 for _ in range(3)]
    import math
    for x in range(x0, x1 or img.w):
        y = base + amp * (math.sin(x * freq + ph[0]) * .6 + math.sin(x * freq * 2.3 + ph[1]) * .3 + math.sin(x * freq * 4.1 + ph[2]) * .1)
        for yy in range(int(y), img.h): img.put(x, yy, colour)

# ── the hero diorama: a dig site with gems buried in the soil ────────────────
W, H = 320, 240
GEMS = [(46, 172), (112, 196), (190, 164), (246, 200), (150, 216), (284, 170)]
GROUND = 136

def diorama(frame):
    im = Img(W, H)
    im.dither(0, 0, W, 70, 'B', 'c'); im.dither(0, 70, W, GROUND, 'c', 'P')
    # the sun, with a dithered halo
    im.halo(240, 48, 44, 'y', 9)
    im.circle(240, 48, 17, 'l'); im.circle(240, 48, 15, 'L'); im.circle(235, 43, 5, 'y')
    ridge(im, 104, 10, .02, 3, 'h'); ridge(im, 116, 9, .035, 7, 'j')
    ridge(im, 126, 6, .05, 11, 'k')
    # the ground: grass, then layers of soil
    for y in range(GROUND, H):
        d = y - GROUND
        col = 'm' if d < 3 else 'l' if d < 6 else 's' if d < 24 else 't' if d < 58 else 'u' if d < 92 else 'v'
        im.hline(0, y, W, col)
    rnd = random.Random(5)
    for _ in range(420):  # pebbles and grains, darker in the deeper layers
        x, y = rnd.randrange(W), rnd.randrange(GROUND + 7, H)
        d = y - GROUND
        im.put(x, y, 'u' if d < 40 else 'v' if d < 80 else 'w')
    for _ in range(120):
        x, y = rnd.randrange(W), rnd.randrange(GROUND + 7, H)
        im.put(x, y, 's' if y - GROUND < 56 else 't')
    for x in range(0, W, 7): im.put(x + rnd.randrange(3), GROUND - 1, 'm')  # grass blades
    for x in (14, 70, 132, 196, 226, 292): im.sprite(x, GROUND - 2, TUFT)
    for x, k in ((24, 0), (106, 1), (214, 2), (300, 3)): im.sprite(x, GROUND - 5, FLOWER)
    im.sprite(284, GROUND - 9, TREE); im.sprite(8, GROUND - 9, TREE)
    # the sign
    im.rect(166, GROUND - 22, 26, 13, 'w'); im.rect(167, GROUND - 21, 24, 11, 't'); im.rect(177, GROUND - 9, 4, 8, 'w'); text(im, 171, GROUND - 19, 'SEO', 'K')
    # the scanner drone and its beam; the beam's dither shifts a little each frame so it shimmers
    dx = (0, 1, 2, 1)[frame]
    bay = ((0, 8, 2, 10), (12, 4, 14, 6), (3, 11, 1, 9), (15, 7, 13, 5))
    for r in range(0, 84):
        half = 4 + r // 2
        for x in range(-half, half + 1):
            edge = abs(x) >= half - 1
            fade = 1 - r / 90
            if edge and (r + frame) % 2 == 0 or (not edge and 11 * fade * (1 - abs(x) / (half + 1)) + 3 > bay[(GROUND + r) % 4][(96 + x + frame) % 4]):
                im.put(96 + x, GROUND + 6 + r, 'L' if edge else 'y')
    im.sprite(81 + dx, 104 - (1 if frame in (1, 2) else 0), DRONE, scale=2)
    # buried gems: dim in the soil, each one catching the light in turn
    for i, (gx, gy) in enumerate(GEMS):
        lit = (i + frame) % 4 == 0 or (i * 2 + frame) % 5 == 0
        im.halo(gx + 9, gy + 9, 20, 'L', 6 if lit else 2)
        im.sprite(gx, gy, GEM if lit else GEM_DIM, scale=2)
        if lit:
            im.sprite(gx - 8 + (frame % 2), gy - 8, SPARK_S, scale=2)
            im.sprite(gx + 19, gy - 4 - (frame % 3) * 2, SPARK_S, scale=1)
    return im

def clouds():
    im = Img(320, 64)
    im.sprite(20, 14, CLOUD); im.sprite(150, 30, CLOUD_S); im.sprite(250, 6, CLOUD); im.sprite(96, 44, CLOUD_S)
    return im

# ── the ridge strip behind the dashboard, in two layers that move at different speeds ──
def strip(far):
    im = Img(480, 150)
    if far:
        im.dither(0, 0, 480, 150, 'B', 'c')
        ridge(im, 92, 16, .012, 21, 'h'); ridge(im, 112, 12, .02, 25, 'j')
        im.sprite(60, 36, CLOUD); im.sprite(200, 20, CLOUD_S); im.sprite(300, 50, CLOUD)
    else:
        ridge(im, 120, 10, .03, 31, 'k')
        for y in range(132, 150):
            im.hline(0, y, 480, 'm' if y < 135 else 'l' if y < 138 else 's')
        rnd = random.Random(9)
        for x in range(0, 480, 6): im.put(x + rnd.randrange(3), 131, 'm')
        for x in (30, 120, 260, 340, 430): im.sprite(x, 128, TUFT)
        for x in (70, 210, 300, 400): im.sprite(x, 126, FLOWER)
        im.sprite(14, 123, TREE); im.sprite(452, 123, TREE)
    return im

# ── eight small scenes, one per kind of hidden win (2 frames each) ───────────────
import math
SW, SH = 160, 110

def scene(tint='P'):
    im = Img(SW, SH, tint)
    for y in range(6, SH, 10):
        for x in range(6, SW, 10): im.put(x, y, 'g')
    return im

def ring(im, cx, cy, r, ch, squash=1.0):
    for a in range(0, 360, 3):
        im.put(int(cx + r * math.cos(math.radians(a))), int(cy + r * math.sin(math.radians(a)) * squash), ch)

def thick(im, a, b, ch):
    for o in (0, 1): im.line(a[0], a[1] + o, b[0], b[1] + o, ch)

def lost(f):
    """A line that climbed and then fell off a cliff; the dotted ghost is where it was heading."""
    im = scene('P')
    im.vline(12, 8, 88, 'G'); im.hline(12, 96, 136, 'G')
    pts = [(14, 82), (34, 66), (52, 44), (70, 22), (92, 30), (112, 88), (146, 90)]
    for a, b in zip(pts, pts[1:]): thick(im, a, b, 'K')
    thick(im, (70, 22), (146, 8), 'm') if False else im.line(70, 22, 146, 8, 'm', dotted=True)
    im.line(70, 23, 146, 9, 'm', dotted=True)
    for i, (cx, cy) in enumerate(((100, 44), (112, 56), (124, 40))):  # clicks falling off the cliff
        y = cy + 10 * f + i * 3
        im.circle(cx, y, 4, 'K'); im.circle(cx, y, 3, 'L'); im.put(cx - 1, y - 1, 'y')
    for x, y in ((120, 86), (126, 84), (114, 87)): im.rect(x, y, 2, 2, 'r')
    return im

def rising(f):
    """Bars climbing, with a sprout pushing out of the tallest one."""
    im = scene('c')
    im.hline(12, 96, 136, 'G')
    for i, h in enumerate((10, 16, 24, 36, 54)):
        x = 20 + i * 26
        im.rect(x, 96 - h, 18, h, 'l'); im.rect(x, 96 - h, 18, 2, 'L')
        im.vline(x, 96 - h, h, 'K'); im.vline(x + 17, 96 - h, h, 'K'); im.hline(x, 96 - h, 18, 'K')
    top, st = 96 - 54, 14 + 8 * f
    im.rect(128, top - st, 3, st, 'n')
    im.sprite(118, top - st - 4, "..mm.\n.mLLm\nmLLLm\n.mmm.", scale=2)
    im.sprite(132, top - st + 6, "mm..\nmLLm\n.mLm\n..mm", scale=2)
    if f: im.sprite(106, top - st - 16, SPARK_S, scale=2); im.sprite(146, top - st - 6, SPARK_S)
    for k in range(3): im.line(24 + k * 26, 90 - k * 9, 40 + k * 26, 82 - k * 12 - f, 'm', dotted=True)
    return im

def edge(f):
    """A results list with our page in row 8, hopping up a row."""
    im = scene('P')
    ours = 7 if f else 8
    for i in range(1, 11):
        y, wd = 8 + (i - 1) * 9, 118 - i * 5
        im.rect(18, y, wd, 7, 'L' if i == ours else 'W')
        im.hline(18, y, wd, 'K'); im.hline(18, y + 6, wd, 'K'); im.vline(18, y, 7, 'K'); im.vline(18 + wd - 1, y, 7, 'K')
        if i < 10: text(im, 22, y + 1, str(i), 'K')
        im.rect(30, y + 2, wd - 30, 1, 'm' if i == ours else 'g')
    y8 = 8 + (ours - 1) * 9
    im.sprite(138, y8 - 2 - f * 2, "..K..\n.KLK.\nKLLLK\n..K..", scale=2)
    for k in range(5): im.rect(148, 70 - k * 9, 1, 3, 'm')
    if f: im.sprite(126, 4, SPARK_S, scale=2)
    return im

def bingg(f):
    """Two podiums: one side ranks us near the top, the other far down."""
    im = scene('B')
    im.hline(12, 98, 136, 'K')
    im.rect(26, 38, 44, 60, 'b'); im.rect(26, 38, 44, 3, 'W')
    im.hline(26, 38, 44, 'K'); im.vline(26, 38, 60, 'K'); im.vline(69, 38, 60, 'K')
    im.rect(92, 80, 44, 18, 'g'); im.rect(92, 80, 44, 3, 'W')
    im.hline(92, 80, 44, 'K'); im.vline(92, 80, 18, 'K'); im.vline(135, 80, 18, 'K')
    for ch, x, y, sc in (('B', 41, 56, 4), ('G', 107, 84, 3)):
        for k, row in enumerate(FONT[ch].split('|')):
            for i, v in enumerate(row):
                if v == '#': im.rect(x + i * sc, y + k * sc, sc, sc, 'K')
    im.sprite(36, 18 - f * 2, GEM, scale=2)
    im.sprite(102, 62, GEM_DIM, scale=2)
    if f: im.sprite(24, 12, SPARK_S, scale=2); im.sprite(58, 16, SPARK_S)
    for k in range(4): im.rect(76 + k * 4, 60 + k * 3 - f, 2, 2, 'm')
    return im

def gem(f):
    """A ladder, and a gem stuck at rung 8 under a magnifier."""
    im = scene('P')
    im.rect(56, 6, 4, 98, 'w'); im.rect(100, 6, 4, 98, 'w')
    for i in range(10):
        im.rect(60, 10 + i * 10, 40, 4, 'u'); im.hline(60, 10 + i * 10, 40, 't')
    gy = 10 + 7 * 10 - 6
    im.halo(80, gy + 9, 26, 'L', 8 + f * 3)
    im.sprite(71, gy, GEM, scale=2)
    ring(im, 80, gy + 9, 22, 'K'); ring(im, 80, gy + 9, 21, 'K')
    for k in range(7): im.rect(96 + k * 2, gy + 25 + k * 2, 4, 4, 'w')
    if f: im.sprite(52, gy - 14, SPARK_S, scale=2); im.sprite(104, gy - 8, SPARK_S)
    return im

def friction(f):
    """A button nobody can use, and a cursor hammering it."""
    im = scene('P')
    im.rect(20, 40, 72, 28, 'L'); im.rect(21, 41, 70, 2, 'y')
    im.hline(20, 40, 72, 'K'); im.hline(20, 67, 72, 'K'); im.vline(20, 40, 28, 'K'); im.vline(91, 40, 28, 'K')
    im.rect(34, 51, 44, 4, 'K'); im.rect(40, 58, 32, 2, 'm')
    cx, cy = 104, 54
    for r in ((7, 14) if not f else (10, 18)): ring(im, cx, cy, r, 'r', .8)
    for k, (dx, dy) in enumerate(((-18, -12), (16, -14), (-20, 12), (20, 14))):
        if (k + f) % 2 == 0: im.rect(cx + dx, cy + dy, 2, 2, 'r')
    im.sprite(cx - 1, cy - 1, CURSOR)
    if f: im.sprite(124, 18, "r.r\n.r.\nr.r", scale=2)
    return im

def phone(f):
    """The same site on a laptop and on a phone, ranked very differently."""
    im = scene('c')
    im.hline(10, 98, 140, 'K')
    im.sprite(14, 62, LAPTOP, scale=3)
    im.sprite(108, 50, PHONE, scale=3)
    for x, top, num, base in ((38, 10, '5', 62), (118, 36, '15', 56)):
        im.vline(x, top, base - top, 'G')
        wave = f if x > 100 else 0
        col = 'L' if x < 100 else 'o'
        im.rect(x, top, 22, 14, col); im.hline(x, top, 22, 'K'); im.hline(x, top + 13, 22, 'K'); im.vline(x + 21, top, 14, 'K')
        text(im, x + 4 + wave, top + 4, num, 'K')
    for k in range(5): im.rect(74, 30 + k * 6, 2, 3, 'm')
    return im

def leak(f):
    """A bucket of visitors with holes in it."""
    im = scene('B')
    im.rect(40, 30, 80, 6, 'D'); im.rect(44, 36, 72, 56, 'g'); im.rect(44, 62, 72, 30, 'b'); im.rect(44, 62, 72, 2, 'B')
    im.vline(44, 36, 56, 'K'); im.vline(115, 36, 56, 'K'); im.hline(44, 92, 72, 'K'); im.hline(40, 30, 80, 'K')
    for x in (60, 80, 100): im.rect(x, 90, 4, 3, 'K')
    for i, x in enumerate((62, 82, 102)):
        y = min(94 + ((f * 5 + i * 3) % 12), 104)
        im.rect(x, y, 3, 4, 'b'); im.hline(x, y, 3, 'K')
    for i, x in enumerate((54, 76, 98)):  # visitors arriving at the top
        y = 6 + ((f * 6 + i * 5) % 18)
        im.circle(x + 4, y, 3, 'K'); im.circle(x + 4, y, 2, 'L')
    return im

SCENES = [('lost', lost), ('rising', rising), ('edge', edge), ('bing', bingg), ('gem', gem), ('friction', friction), ('phone', phone), ('leak', leak)]

# ── many sites, one dashboard ─────────────────────────────────────────────────
HOUSE = """
.....RR.....
...RRRRRR...
.RRRRRRRRRR.
RRRRRRRRRRRR
.KKKKKKKKKK.
.KWWWWWWWWK.
.KWWKKWWWWK.
.KWWKKWWWWK.
.KWWKKWWWWK.
.KKKKKKKKKK.
"""
def house(im, x, y, roof, scale=2):
    rows = HOUSE.strip('\n').split('\n')
    for j, row in enumerate(rows):
        for i, ch in enumerate(row):
            if ch != '.': im.rect(x + i * scale, y + j * scale, scale, scale, roof if ch == 'R' else ch)

def many(f):
    im = Img(240, 130, 'P')
    for y in range(6, 130, 10):
        for x in range(6, 240, 10): im.put(x, y, 'g')
    im.rect(86, 34, 68, 46, 'D'); im.rect(88, 36, 64, 38, 'W')
    im.hline(86, 34, 68, 'K'); im.hline(86, 79, 68, 'K'); im.vline(86, 34, 46, 'K'); im.vline(153, 34, 46, 'K'); im.rect(88, 36, 64, 6, 'g')
    for i, h in enumerate((6, 10, 8, 16, 22, 28)):
        im.rect(94 + i * 9, 72 - h, 6, h, 'L' if i == 5 else 'l'); im.hline(94 + i * 9, 72 - h, 6, 'K')
    im.rect(116, 80, 8, 8, 'D'); im.rect(106, 88, 28, 4, 'K')
    sites = ((16, 14, 'r'), (176, 12, 'b'), (8, 78, 'o'), (196, 74, 'L'), (100, 100, 'D'))
    ends = ((112, 38), (128, 38), (96, 66), (144, 66), (120, 92))
    for (sx, sy, roof), (ex, ey) in zip(sites, ends):
        house(im, sx, sy, roof)
        a, b = (sx + 12, sy + 20), (ex, ey + 6)
        im.line(a[0], a[1], b[0], b[1], 'G', dotted=True)
        for k in range(2):  # data packets travelling along the line
            t = ((f * 0.25) + k * 0.5) % 1
            px, py = int(a[0] + (b[0] - a[0]) * t) - 1, int(a[1] + (b[1] - a[1]) * t) - 1
            im.rect(px, py, 3, 3, 'L'); im.hline(px, py, 3, 'K')
    if f % 2: im.sprite(150, 28, SPARK_S, scale=2)
    return im

# ── an agent talking to SEOConsole ────────────────────────────────────────────
def agent(f):
    im = Img(240, 110, 'P')
    for y in range(6, 110, 10):
        for x in range(6, 240, 10): im.put(x, y, 'g')
    im.rect(10, 20, 82, 62, 'W'); im.rect(11, 21, 80, 8, 'g')
    im.hline(10, 20, 82, 'K'); im.hline(10, 81, 82, 'K'); im.vline(10, 20, 62, 'K'); im.vline(91, 20, 62, 'K')
    for i, cc in enumerate('rol'): im.rect(15 + i * 6, 24, 3, 3, cc)
    im.rect(16, 36, 46, 7, 'g'); im.rect(30, 48, 54, 7, 'L'); im.hline(30, 48, 54, 'K'); im.hline(30, 54, 54, 'K'); im.rect(16, 60, 38, 7, 'g')
    if f % 2: im.rect(58, 70, 3, 5, 'K')
    im.rect(168, 26, 50, 52, 'g'); im.rect(168, 26, 50, 4, 'W')
    im.hline(168, 26, 50, 'K'); im.vline(168, 26, 52, 'K'); im.vline(217, 26, 52, 'K'); im.hline(168, 77, 50, 'K')
    for y in (36, 48, 60): im.hline(168, y, 50, 'K'); im.rect(172, y + 3, 8, 3, 'L')
    im.sprite(194, 38, GEM_DIM if f % 2 else GEM)
    im.line(94, 52, 166, 52, 'K', dotted=True)
    for k in range(3):
        x = int(96 + 68 * (((f * 0.25) + k / 3) % 1))
        im.rect(x - 2, 49, 5, 5, 'L'); im.hline(x - 2, 49, 5, 'K'); im.hline(x - 2, 53, 5, 'K'); im.vline(x - 2, 49, 5, 'K'); im.vline(x + 2, 49, 5, 'K')
    if f in (1, 3): im.sprite(120, 64, SPARK_S, scale=2)
    return im

if __name__ == '__main__':
    print('diorama', sheet([diorama(f) for f in range(4)]).save('dig-site.png'))
    print('clouds', clouds().save('clouds.png'))
    print('strip far', strip(True).save('ridge-far.png'))
    print('strip near', strip(False).save('ridge-near.png'))
    for name, fn in SCENES: print('scene', name, sheet([fn(0), fn(1)]).save(f'scene-{name}.png'))
    print('many', sheet([many(f) for f in range(4)]).save('many-sites.png'))
    print('agent', sheet([agent(f) for f in range(4)]).save('agent-link.png'))
