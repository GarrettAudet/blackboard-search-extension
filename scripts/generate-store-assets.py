from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "assets" / "icons"
STORE_DIR = ROOT / "docs" / "store"


def font(size, bold=False):
    candidates = [
        "C:/Windows/Fonts/Inter.ttf",
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_brand_icon(draw, center, size):
    x, y = center
    r = size / 2
    shadow = (139, 92, 246, 80)
    draw.ellipse((x - r - 7, y - r + 9, x + r + 7, y + r + 16), fill=shadow)
    draw.ellipse((x - r, y - r, x + r, y + r), fill=(132, 83, 246), outline=(183, 148, 255), width=max(2, int(size * 0.025)))
    draw.ellipse((x - r + size * 0.13, y - r + size * 0.08, x + r - size * 0.28, y + r - size * 0.46), fill=(255, 255, 255, 34))

    scale = size / 128
    px = x - 31 * scale
    py = y - 35 * scale
    back = [
        (px + 20 * scale, py + 10 * scale),
        (px + 58 * scale, py + 10 * scale),
        (px + 70 * scale, py + 22 * scale),
        (px + 70 * scale, py + 78 * scale),
        (px + 22 * scale, py + 78 * scale),
        (px + 12 * scale, py + 68 * scale),
        (px + 12 * scale, py + 18 * scale),
    ]
    page = [
        (px + 10 * scale, py + 0 * scale),
        (px + 56 * scale, py + 0 * scale),
        (px + 72 * scale, py + 16 * scale),
        (px + 72 * scale, py + 76 * scale),
        (px + 18 * scale, py + 76 * scale),
        (px + 4 * scale, py + 62 * scale),
        (px + 4 * scale, py + 7 * scale),
    ]
    draw.polygon(back, fill=(255, 255, 255, 62), outline=(255, 255, 255, 170))
    draw.polygon(page, fill=(255, 255, 255, 50), outline=(255, 255, 255, 240))
    draw.line((px + 20 * scale, py + 22 * scale, px + 52 * scale, py + 22 * scale), fill=(255, 255, 255, 235), width=max(2, int(5 * scale)))
    draw.line((px + 20 * scale, py + 36 * scale, px + 46 * scale, py + 36 * scale), fill=(255, 255, 255, 235), width=max(2, int(5 * scale)))
    lens_r = 17 * scale
    lx, ly = px + 60 * scale, py + 64 * scale
    draw.ellipse((lx - lens_r, ly - lens_r, lx + lens_r, ly + lens_r), outline=(255, 255, 255, 245), width=max(3, int(7 * scale)))
    draw.line((lx + 12 * scale, ly + 12 * scale, lx + 29 * scale, ly + 29 * scale), fill=(255, 255, 255, 245), width=max(3, int(7 * scale)))


def make_icon(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img, "RGBA")
    draw_brand_icon(draw, (size / 2, size / 2), size * 0.86)
    img.save(path)


def text(draw, xy, value, fill, size=24, bold=False, max_width=None):
    f = font(size, bold)
    if max_width:
        words = value.split()
        lines = []
        line = ""
        for word in words:
            candidate = f"{line} {word}".strip()
            if draw.textlength(candidate, font=f) <= max_width or not line:
                line = candidate
            else:
                lines.append(line)
                line = word
        if line:
            lines.append(line)
        x, y = xy
        for line in lines:
            draw.text((x, y), line, fill=fill, font=f)
            y += int(size * 1.45)
        return y
    draw.text(xy, value, fill=fill, font=f)
    return xy[1] + int(size * 1.35)


def source_card(draw, box, tag, title, excerpt, score):
    rounded(draw, box, 16, (15, 11, 25), (52, 41, 80), 2)
    x1, y1, x2, _ = box
    rounded(draw, (x1 + 22, y1 + 18, x1 + 88, y1 + 50), 15, (54, 34, 95))
    text(draw, (x1 + 42, y1 + 22), tag, (194, 166, 255), 18, True)
    text(draw, (x2 - 95, y1 + 22), f"score {score}", (166, 154, 194), 17)
    text(draw, (x1 + 22, y1 + 70), title, (246, 242, 255), 24, True, x2 - x1 - 44)
    text(draw, (x1 + 22, y1 + 114), excerpt, (178, 166, 206), 18, False, x2 - x1 - 44)
    text(draw, (x1 + 22, y1 + 178), "Open source", (183, 148, 255), 18, True)


def shell(draw):
    W, H = 1280, 800
    draw.rectangle((0, 0, W, H), fill=(8, 7, 15))
    for y in range(0, H, 6):
        draw.line((0, y, W, y), fill=(255, 255, 255, 8), width=1)
    draw.rectangle((0, 0, W, 96), fill=(12, 10, 20))
    draw.line((0, 96, W, 96), fill=(46, 36, 70), width=2)
    draw_brand_icon(draw, (64, 48), 62)
    text(draw, (112, 23), "Blackboard Search", (246, 242, 255), 30, True)
    text(draw, (112, 58), "214 resources indexed", (170, 161, 195), 19, True)
    draw.ellipse((98, 63, 110, 75), fill=(32, 212, 155))
    for i, symbol in enumerate(["↻", "⚙"]):
        x = 1125 + i * 72
        rounded(draw, (x, 23, x + 48, 71), 12, (18, 14, 29), (60, 47, 88), 2)
        text(draw, (x + 13, 28), symbol, (194, 166, 255), 26, True)


def make_chat_screenshot(path):
    W, H = 1280, 800
    img = Image.new("RGB", (W, H), (8, 7, 15))
    draw = ImageDraw.Draw(img, "RGBA")
    shell(draw)

    text(draw, (72, 132), "Ask questions across your indexed Blackboard resources and PDFs.", (246, 242, 255), 24)
    rounded(draw, (650, 178, 1118, 240), 17, (139, 92, 246))
    text(draw, (690, 195), "What are the current to-do tasks?", (255, 255, 255), 23, True)

    answer = (
        "The current to-do tasks for the Class of 2026-2027 Pre-program are:\n\n"
        "1. Complete the 2026-27 Capstone Preliminary Interest Survey by 23:59 on June 23, 2026 (UTC+8).\n"
        "2. Submit the Prerequisite Course Exemption Application by 23:59 on June 30, 2026 (UTC+8), if applicable.\n\n"
        "Both items are listed in the Blackboard To Do section."
    )
    y = 280
    for line in answer.split("\n"):
        text(draw, (72, y), line, (246, 242, 255), 22, False, 1040)
        y += 34 if line else 20

    rounded(draw, (72, 528, 210, 574), 23, (35, 24, 58), (68, 46, 104), 2)
    text(draw, (99, 540), "Sources (2)", (194, 166, 255), 19, True)
    source_card(
        draw,
        (72, 604, 594, 764),
        "[1] page",
        "To Do - Class of 2026-2027 Pre-program",
        "Review the 2026-27 Partner Organizations Proposed Topics and fill out the Capstone Preliminary Interest Survey...",
        598,
    )
    source_card(
        draw,
        (620, 604, 1142, 764),
        "[2] page",
        "Prerequisite Course Exemption Application",
        "Students who wish to be exempted from the course should submit the Course Exemption Application by the deadline...",
        560,
    )
    img.save(path, quality=95)


def make_setup_screenshot(path):
    W, H = 1280, 800
    img = Image.new("RGB", (W, H), (8, 7, 15))
    draw = ImageDraw.Draw(img, "RGBA")
    shell(draw)
    rounded(draw, (64, 130, 1216, 704), 18, (19, 16, 32), (52, 41, 80), 2)
    text(draw, (96, 166), "Setup", (246, 242, 255), 31, True)
    text(draw, (1030, 172), "API key saved", (170, 161, 195), 22)

    fields = [
        ("API provider", "OpenAI"),
        ("Model", "gpt-4.1-mini"),
        ("API key", "Stored locally in Chrome"),
    ]
    y = 226
    for label, value in fields:
        text(draw, (96, y), label, (170, 161, 195), 22)
        rounded(draw, (96, y + 38, 1118, y + 100), 10, (10, 8, 17), (52, 41, 80), 2)
        text(draw, (124, y + 54), value, (246, 242, 255) if label != "API key" else (142, 131, 166), 22)
        y += 128

    note = (
        "API answering sends your question and top matched Blackboard snippets to the selected provider. "
        "Your index and API key stay local in Chrome storage."
    )
    text(draw, (96, 596), note, (194, 184, 220), 21, False, 920)
    rounded(draw, (96, 666, 1118, 732), 12, (139, 92, 246))
    text(draw, (538, 684), "Save setup", (255, 255, 255), 22, True)
    img.save(path, quality=95)


def main():
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128, 512):
        make_icon(size, ICON_DIR / f"icon{size}.png")
    make_icon(128, STORE_DIR / "store-icon-128.png")
    make_chat_screenshot(STORE_DIR / "screenshot-chat-sources.png")
    make_setup_screenshot(STORE_DIR / "screenshot-setup.png")


if __name__ == "__main__":
    main()
