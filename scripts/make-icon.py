# -*- coding: utf-8 -*-
"""
生成应用图标母版 1024x1024:深蓝渐变圆角底 + 上涨K线 + 比特币 ₿ 徽章
输出 brand/icon-1024.png,再由 `pnpm tauri icon` 生成全套尺寸。
"""
from PIL import Image, ImageDraw, ImageFont

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# ---- 圆角渐变底(深蓝金融风) ----
R = 200
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
top = (11, 18, 32)      # #0B1220
bot = (29, 43, 79)      # #1D2B4F
for y in range(S):
    t = y / (S - 1)
    gd.line([(0, y), (S, y)], fill=(
        int(top[0] + (bot[0] - top[0]) * t),
        int(top[1] + (bot[1] - top[1]) * t),
        int(top[2] + (bot[2] - top[2]) * t),
        255,
    ))
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S, S], radius=R, fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)

# ---- K线(4根,低到高,最后大阳线) ----
# (x中心, 影线顶y, 实体顶y, 实体底y, 影线底y, 实体宽, 颜色, 是阳线)
candles = [
    (250, 560, 600, 720, 780, 86, (239, 68, 68), False),   # 红
    (402, 470, 510, 660, 720, 86, (34, 197, 94), True),    # 绿
    (554, 530, 560, 640, 700, 86, (248, 113, 113), False), # 红回调
    (706, 300, 340, 520, 570, 100, (74, 222, 128), True),  # 大阳线
]
LW = 16  # 影线宽
for cx, hi, bt, bb, lo, bw, col, _ in candles:
    d.rounded_rectangle([cx - LW // 2, hi, cx + LW // 2, lo], radius=LW // 2, fill=col)
    d.rounded_rectangle([cx - bw // 2, bt, cx + bw // 2, bb], radius=18, fill=col)

# ---- 上涨趋势线(点缀,细线+箭头) ----
tl = (125, 210, 250)
d.line([(210, 700), (700, 360)], fill=tl, width=14)
# 箭头
d.polygon([(700, 360), (640, 358), (676, 420)], fill=tl)

# ---- ₿ 徽章(右上角橙色圆 + 白B + 两道横杠) ----
bx, by, br = 790, 210, 150
d.ellipse([bx - br, by - br, bx + br, by + br], fill=(247, 147, 26))  # #F7931A
try:
    font = ImageFont.truetype("C:/Windows/Fonts/ariblk.ttf", 190)
except OSError:
    font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 190)
tb = d.textbbox((0, 0), "B", font=font)
d.text((bx - (tb[2] - tb[0]) / 2 - tb[0] + 8, by - (tb[3] - tb[1]) / 2 - tb[1] - 6), "B",
       font=font, fill=(255, 255, 255))
# ₿ 的两道竖穿横杠(叠在 B 左侧竖笔画上)
for gy in (-34, 34):
    d.rectangle([bx - 96, by + gy - 10, bx - 20, by + gy + 10], fill=(247, 147, 26))

img.save("brand/icon-1024.png")
print("saved brand/icon-1024.png", img.size)
