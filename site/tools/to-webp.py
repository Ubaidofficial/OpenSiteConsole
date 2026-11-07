"""Converts the captures in site/tools/out into the WebP files the page loads: a large one (at most 2160 px wide) and a 1080 px one.
Needs Pillow. Run from the repository root after capture-shots.cjs."""
import os
from PIL import Image

SRC, DST = 'site/tools/out', 'site/assets/shots'
for f in sorted(os.listdir(SRC)):
    if not f.endswith('.png'):
        continue
    name, im = f[:-4], Image.open(os.path.join(SRC, f)).convert('RGB')
    for width, suffix in ((min(2160, im.width), ''), (1080, '-1080')):
        out = os.path.join(DST, f'{name}{suffix}.webp')
        im.resize((width, round(im.height * width / im.width)), Image.LANCZOS).save(out, 'WEBP', quality=82, method=6)
        print(out, os.path.getsize(out) // 1024, 'KB')
