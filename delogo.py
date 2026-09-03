"""Knock the white rectangle out from behind the circular logo mark.

Flood-fills transparency inward from the image border only, so the white
*inside* the ring (which the navy wordmark sits on) is preserved. Without this
the logo shows as a white box on any non-white surface.
"""
from collections import deque

from PIL import Image

SRC = "assets/img/logo.png"
DST = "assets/img/logo-trim.png"
NEAR_WHITE = 242  # every channel at or above this counts as background

im = Image.open(SRC).convert("RGBA")
w, h = im.size
px = im.load()


def is_bg(x, y):
    r, g, b, a = px[x, y]
    return a > 0 and r >= NEAR_WHITE and g >= NEAR_WHITE and b >= NEAR_WHITE


seen = [[False] * h for _ in range(w)]
q = deque()

for x in range(w):
    for y in (0, h - 1):
        if is_bg(x, y):
            q.append((x, y))
            seen[x][y] = True
for y in range(h):
    for x in (0, w - 1):
        if is_bg(x, y):
            q.append((x, y))
            seen[x][y] = True

cleared = 0
while q:
    x, y = q.popleft()
    r, g, b, _ = px[x, y]
    px[x, y] = (r, g, b, 0)
    cleared += 1
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < w and 0 <= ny < h and not seen[nx][ny] and is_bg(nx, ny):
            seen[nx][ny] = True
            q.append((nx, ny))

im.save(DST)
total = w * h
print(f"{DST}  {w}x{h}  cleared {cleared} px ({100*cleared/total:.1f}% of frame)")
print("interior white preserved:", not all(px[w // 2, y][3] == 0 for y in range(h // 2, h // 2 + 6)))
