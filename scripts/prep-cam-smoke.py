from PIL import Image, ImageFilter, ImageEnhance
from pathlib import Path

src_dir = Path(
    r"C:\Users\codyk\.cursor\projects\c-Users-codyk-OneDrive-Desktop-website\assets"
)
out_dir = Path(r"C:\Users\codyk\OneDrive\Desktop\website\public\widgets\smoke")
out_dir.mkdir(parents=True, exist_ok=True)

mapping = {
    "cam-smoke-plate-a.png": "plate-a.png",
    "cam-smoke-plate-b.png": "plate-b.png",
    "cam-smoke-plate-c.png": "plate-c.png",
}

for src_name, out_name in mapping.items():
    im = Image.open(src_dir / src_name).convert("RGB")
    gray = im.convert("L")
    gray = gray.point(lambda p: 0 if p < 18 else min(255, int((p - 18) * 1.35)))
    gray = gray.filter(ImageFilter.GaussianBlur(0.8))
    gray = ImageEnhance.Brightness(gray).enhance(1.1)
    rgba = Image.new("RGBA", im.size)
    solid = Image.new("RGB", im.size, (236, 240, 246))
    rgba.paste(solid)
    rgba.putalpha(gray)
    out = out_dir / out_name
    rgba.save(out, "PNG", optimize=True)
    alpha = list(gray.getdata())
    nz = sum(1 for v in alpha if v > 10)
    print(out.name, rgba.size, f"nz%={100 * nz / len(alpha):.1f}", "maxA", max(alpha))

print("done", out_dir)
