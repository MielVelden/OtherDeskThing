#!/usr/bin/env python3
"""Generates the pixel-art PNGs in public/img/ (stdlib only, no Pillow).

    python3 tools/make-assets.py

Every image is drawn at 2 image pixels per "logical" pixel (8 for icons), and the
CSS shows it at 1 CSS px per logical pixel (2 for icons). That keeps the pixels
crisp on both retina (iPod 4th gen) and non-retina (iPod 3rd gen) screens, since
iOS 5/6 has no image-rendering: pixelated.
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'img')

PALETTE = {
    '.': (0, 0, 0, 0),           # transparent
    'K': (0, 0, 0, 255),         # ink
    'W': (255, 255, 255, 255),
    'T': (58, 168, 193, 255),    # desktop teal
    'Y': (255, 222, 77, 255),    # sun yellow
    'G': (185, 185, 201, 255),   # grey cloud
    'B': (58, 111, 240, 255),    # rain blue
    'C': (190, 230, 255, 255),   # ice blue
    'D': (34, 34, 34, 255),      # touch-icon background
}


def write_png(name, rows):
    h = len(rows)
    w = len(rows[0])
    raw = b''.join(b'\x00' + bytes(c for px in row for c in px) for row in rows)

    def chunk(kind, data):
        return (struct.pack('>I', len(data)) + kind + data
                + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(png)
    print('%-22s %3dx%-3d %5d bytes' % (name, w, h, len(png)))


def render(art, scale):
    """ASCII art -> RGBA rows, each art pixel becoming scale x scale pixels."""
    rows = []
    for line in art:
        row = []
        for ch in line:
            row.extend([PALETTE[ch]] * scale)
        for _ in range(scale):
            rows.append(list(row))
    return rows


def canvas(size=16):
    return [['.'] * size for _ in range(size)]


def stamp(cv, art, dx=0, dy=0, recolor=None):
    for y, line in enumerate(art):
        for x, ch in enumerate(line):
            if ch == '.':
                continue
            if recolor and ch in recolor:
                ch = recolor[ch]
            tx, ty = x + dx, y + dy
            if 0 <= ty < len(cv) and 0 <= tx < len(cv[0]):
                cv[ty][tx] = ch


def lines(cv):
    return [''.join(r) for r in cv]


# ---- patterns (2 image px per logical px) ----------------------------------

# Fish-scale desktop pattern, 8x8, in the spirit of the System 7 desktop patterns.
DESK = [
    'TTTTKTTT',
    'TTTTKTTT',
    'TTTKTKTT',
    'KKKTTTKK',
    'KTTTTTTT',
    'KTTTTTTT',
    'TKTTTTTK',
    'TTKKKKKT',
]

# Title-bar pinstripes: 1px ink, 1px white.
STRIPES = ['K', 'W']

# 50% checkerboard dither; transparent holes so the element's color shows through.
DITHER = ['K.', '.K']

# ---- weather icons, 16x16 (8 image px per logical px) ------------------------

SUN = [
    '................',
    '.......K........',
    '.......K........',
    '..K....K....K...',
    '...K..KKK..K....',
    '.....KYYYK......',
    '....KYYYYYK.....',
    '.KKKKYYYYYKKKK..',
    '....KYYYYYK.....',
    '.....KYYYK......',
    '...K..KKK..K....',
    '..K....K....K...',
    '.......K........',
    '.......K........',
]

MOON = [
    '................',
    '................',
    '.....KKKK.......',
    '...KKYYK........',
    '..KYYYK.........',
    '..KYYK..........',
    '.KYYYK..........',
    '.KYYYK..........',
    '.KYYYK..........',
    '.KYYYYK.........',
    '..KYYYYK.....K..',
    '..KYYYYYKKKKKK..',
    '...KKYYYYYYYK...',
    '.....KKKKKKK....',
]

CLOUD = [
    '......KKK......',
    '.....KWWWK.....',
    '...KKWWWWWKK...',
    '..KWWWWWWWWWK..',
    '.KKWWWWWWWWWKK.',
    'KWWWWWWWWWWWWWK',
    'KWWWWWWWWWWWWWK',
    'KWWWWWWWWWWWWWK',
    '.KKKKKKKKKKKKK.',
]

DROPS = [
    '..B...B...B.....',
    '.B...B...B......',
    '....B...B...B...',
    '...B...B...B....',
]

FLAKES = [
    '..K....K....K...',
    '.KCK..KCK..KCK..',
    '..K....K....K...',
    '....K....K......',
    '...KCK..KCK.....',
    '....K....K......',
]

BOLT = [
    '......KYK.......',
    '.....KYK........',
    '....KYYYK.......',
    '......KYK.......',
    '.....KYK........',
    '.....KK.........',
]

FOG = [
    '................',
    '................',
    '................',
    '..KKKKKKKKKK....',
    '................',
    '....KKKKKKKKKK..',
    '................',
    '.KKKKKKKKKKKK...',
    '................',
    '...KKKKKKKKKKK..',
    '................',
    '..KKKKKKKKK.....',
]


# ---- logo: white blocky "M", black outline, hard drop shadow -----------------

M_FILL = [
    'WWWW...WWWW',
    'WWWWW.WWWWW',
    'WWWWWWWWWWW',
    'WWW.WWW.WWW',
    'WWW..W..WWW',
    'WWW.....WWW',
    'WWW.....WWW',
    'WWW.....WWW',
    'WWW.....WWW',
]


def logo_art(size, dx, dy):
    """Fill + 1px outline (8-neighbourhood) + outline repeated 1px down-right as shadow."""
    fill = set()
    for y, line in enumerate(M_FILL):
        for x, ch in enumerate(line):
            if ch == 'W':
                fill.add((x + dx, y + dy))
    outline = set()
    for (x, y) in fill:
        for ox in (-1, 0, 1):
            for oy in (-1, 0, 1):
                p = (x + ox, y + oy)
                if p not in fill:
                    outline.add(p)
    cv = canvas(size)
    shape = fill | outline
    for (x, y) in shape:  # shadow first, so the letter sits on top of it
        if 0 <= y + 1 < size and 0 <= x + 1 < size:
            cv[y + 1][x + 1] = 'K'
    for (x, y) in outline:
        cv[y][x] = 'K'
    for (x, y) in fill:
        cv[y][x] = 'W'
    return lines(cv)


def touch_icon():
    """114x114 Home Screen icon: the logo on a dark tile (6 px per art pixel = 19x19 art)."""
    art = logo_art(19, 4, 4)
    rows = render([line.replace('.', 'D') for line in art], 6)
    return rows


def icon(name, layers):
    cv = canvas()
    for art, dx, dy, recolor in layers:
        stamp(cv, art, dx, dy, recolor)
    write_png('wx-%s.png' % name, render(lines(cv), 8))


def main():
    os.makedirs(OUT, exist_ok=True)
    write_png('desk.png', render(DESK, 2))
    write_png('stripes.png', render(STRIPES, 2))
    write_png('dither.png', render(DITHER, 2))
    # Menu bar logo: solid black, like the Apple logo in the System 7 menu bar.
    cv = canvas()
    stamp(cv, M_FILL, 2, 3, {'W': 'K'})
    write_png('logo.png', render(lines(cv), 2))
    write_png('apple-touch-icon.png', touch_icon())

    icon('sun', [(SUN, 0, 1, None)])
    icon('moon', [(MOON, 1, 1, None)])
    icon('partly', [(SUN, -3, -3, None), (CLOUD, 1, 6, None)])
    icon('partly-night', [(MOON, -1, -2, None), (CLOUD, 1, 6, None)])
    icon('cloudy', [(CLOUD, -1, 2, {'W': 'G'}), (CLOUD, 1, 6, None)])
    icon('rain', [(CLOUD, 0, 1, None), (DROPS, 0, 11, None)])
    icon('snow', [(CLOUD, 0, 0, None), (FLAKES, 0, 10, None)])
    icon('thunder', [(CLOUD, 0, 1, None), (BOLT, 0, 10, None)])
    icon('fog', [(FOG, 0, 1, None)])


if __name__ == '__main__':
    main()
