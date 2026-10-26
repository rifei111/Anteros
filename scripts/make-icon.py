#!/usr/bin/env python3
"""生成 Anteros 应用图标（icon.ico + icon.png）。

用法（仓库根目录）：
    python scripts/make-icon.py
    python scripts/make-icon.py --out-dir packages/client/build

依赖：Python 3.10+ 与 Pillow（`python -m pip install pillow`）。
输出：
    packages/client/build/icon.png  — 256x256 预览/渲染进程用
    packages/client/build/icon.ico  — 16/32/48/64/128/256 六尺寸（Windows 安装包与窗口图标）

设计：
    深色圆角底（Windows 11 观感）+ 金色 A 字（Anteros 首字母，窄腰、圆头笔画，兼有弓形意象）
    + 背后一圈记忆光点（10 个点，象征可召回的记忆片段，不是真实数据）。
    全部矢量几何绘制，不依赖字体，所以任何机器上生成结果一致。
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 1024  # 母版尺寸，最后用 LANCZOS 缩小，保证小尺寸边缘干净
BG_TOP = (26, 35, 54)
BG_BOTTOM = (11, 16, 26)
GOLD_TOP = (246, 212, 122)
GOLD_BOTTOM = (214, 148, 42)
RING = (137, 189, 214)
DOT_GOLD = (240, 196, 92)
DOT_CYAN = (126, 196, 224)


def _vgrad(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    img = Image.new("RGB", (1, size))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img.resize((size, size), Image.Resampling.BILINEAR)


def _rounded_mask(size: int, inset: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((inset, inset, size - inset, size - inset), radius=radius, fill=255)
    return mask


def _draw_memory_ring(canvas: Image.Image) -> None:
    overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    cx = cy = S // 2
    radius = 330
    # 细环：很淡，避免抢主体
    d.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=(*RING, 46), width=3)
    # 10 个记忆光点，大小/亮度错落，表示记忆权重不同
    dots = [
        (90, 10, 255), (126, 7, 210), (162, 9, 240), (198, 5, 150),
        (234, 8, 225), (270, 6, 180), (306, 9, 235), (342, 5, 140),
    ]
    import math

    for deg, r, alpha in dots:
        a = math.radians(deg)
        x = cx + math.cos(a) * radius
        y = cy + math.sin(a) * radius
        color = DOT_GOLD if deg % 20 < 10 else DOT_CYAN
        d.ellipse((x - r, y - r, x + r, y + r), fill=(*color, alpha))
    canvas.alpha_composite(overlay)


def _draw_a(canvas: Image.Image) -> None:
    """金色 A：两条腿 + 横梁，圆头，窄腰。用 mask 上渐变。"""
    apex = (512, 258)
    leg_l = (332, 792)
    leg_r = (692, 792)
    bar_l = (404, 606)
    bar_r = (620, 606)
    stroke = 92

    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    for pts in ([apex, leg_l], [apex, leg_r], [bar_l, bar_r]):
        md.line(pts, fill=255, width=stroke, joint="curve")
    for x, y in (apex, leg_l, leg_r, bar_l, bar_r):
        md.ellipse((x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2), fill=255)

    # 外发光
    glow = mask.filter(ImageFilter.GaussianBlur(30))
    gold = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = _vgrad(S, GOLD_TOP, GOLD_BOTTOM).convert("RGBA")
    gold.paste(grad, (0, 0), mask)
    glow_layer = Image.new("RGBA", (S, S), (240, 196, 92, 0))
    glow_layer.putalpha(glow.point(lambda v: min(120, v // 2)))
    canvas.alpha_composite(glow_layer)
    canvas.alpha_composite(gold)

    # 顶点一颗小光点，作为"人格/意识"的视觉锚点（纯装饰）
    spark = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(spark)
    sd.ellipse((apex[0] - 14, apex[1] - 34, apex[0] + 14, apex[1] + 14), fill=(255, 236, 178, 235))
    canvas.alpha_composite(spark.filter(ImageFilter.GaussianBlur(3)))


def render_master() -> Image.Image:
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 底：圆角深色渐变 + 细金色描边内框
    mask = _rounded_mask(S, 56, 210)
    bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bg.paste(_vgrad(S, BG_TOP, BG_BOTTOM), (0, 0), mask)
    canvas.alpha_composite(bg)
    frame = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle((84, 84, S - 84, S - 84), radius=176, outline=(242, 193, 78, 58), width=3)
    canvas.alpha_composite(frame)

    _draw_memory_ring(canvas)
    _draw_a(canvas)
    return canvas


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 Anteros 图标")
    parser.add_argument(
        "--out-dir",
        default=str(Path(__file__).resolve().parent.parent / "packages" / "client" / "build"),
        help="输出目录，默认为 packages/client/build",
    )
    args = parser.parse_args()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    master = render_master()
    icon_png = master.resize((256, 256), Image.Resampling.LANCZOS)
    png_path = out_dir / "icon.png"
    icon_png.save(png_path, format="PNG", optimize=True)

    ico_path = out_dir / "icon.ico"
    # 多尺寸 ICO：Windows 会按 DPI/场景自动挑选合适尺寸
    icon_png.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"[make-icon] 已生成 {png_path}")
    print(f"[make-icon] 已生成 {ico_path}（16/32/48/64/128/256）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
