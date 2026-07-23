"""Build a short looping transparent smoke WebP for OBS."""
from pathlib import Path
from PIL import Image, ImageFilter, ImageEnhance, ImageOps, ImageChops

ROOT = Path(__file__).resolve().parents[1]
ASSETS = Path(
    r"C:\Users\codyk\.cursor\projects\c-Users-codyk-OneDrive-Desktop-website\assets"
)
OUT = ROOT / "public" / "widgets" / "smoke"
OUT.mkdir(parents=True, exist_ok=True)

SRC = [
    ASSETS / "cam-smoke-dense-a.png",
    ASSETS / "cam-smoke-dense-b.png",
]


def to_alpha(im: Image.Image) -> Image.Image:
    gray = ImageOps.autocontrast(im.convert("L"), cutoff=1)
    gray = gray.point(lambda p: 0 if p < 12 else min(255, int((p - 12) * 1.5)))
    gray = ImageEnhance.Brightness(gray).enhance(1.2)
    gray = gray.filter(ImageFilter.GaussianBlur(0.7))
    rgb = Image.new("RGB", im.size, (245, 248, 252))
    return Image.merge("RGBA", (*rgb.split(), gray))


plates = [to_alpha(Image.open(p).convert("RGB")) for p in SRC]
# Working size for the loop strip
W, H = 640, 360
plates = [p.resize((W, H), Image.Resampling.LANCZOS) for p in plates]

frames = []
N = 24
for i in range(N):
    t = i / N
    # Scroll + crossfade for a living loop
    a = plates[0]
    b = plates[1]
    ox = int((t * W) % W)
    oy = int((-t * H * 0.35) % H)

    def scroll(im, x, y):
        # wrap scroll
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.paste(im, (-x, -y), im)
        canvas.paste(im, (W - x, -y), im)
        canvas.paste(im, (-x, H - y), im)
        canvas.paste(im, (W - x, H - y), im)
        return canvas

    fa = scroll(a, ox, oy)
    fb = scroll(b, (ox * 2) % W, (oy + 40) % H)
    # Crossfade
    fade = 0.5 + 0.5 * __import__("math").sin(t * __import__("math").pi * 2)
    mixed = Image.blend(fa, fb, fade * 0.55)
    # Soften a touch
    mixed = mixed.filter(ImageFilter.GaussianBlur(0.4))
    frames.append(mixed)

# Save animated WebP (alpha) + also a GIF fallback (binary-ish alpha)
loop_path = OUT / "smoke-loop.webp"
frames[0].save(
    loop_path,
    save_all=True,
    append_images=frames[1:],
    duration=70,
    loop=0,
    lossless=False,
    quality=80,
    method=6,
)
print("wrote", loop_path, "frames", len(frames))

# Still plates for canvas layering
plates[0].save(OUT / "plate-a.png")
plates[1].save(OUT / "plate-b.png")
print("updated plate-a/b")
