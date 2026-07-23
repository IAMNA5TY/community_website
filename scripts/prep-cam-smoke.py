from PIL import Image, ImageFilter, ImageEnhance, ImageOps
from pathlib import Path

src_dir = Path(
    r"C:\Users\codyk\.cursor\projects\c-Users-codyk-OneDrive-Desktop-website\assets"
)
out_dir = Path(r"C:\Users\codyk\OneDrive\Desktop\website\public\widgets\smoke")
out_dir.mkdir(parents=True, exist_ok=True)

mapping = {
    "cam-smoke-dense-a.png": "plate-a.png",
    "cam-smoke-dense-b.png": "plate-b.png",
    "cam-smoke-plate-b.png": "plate-c.png",  # wispy accent
}


def to_smoke_rgba(im: Image.Image) -> Image.Image:
    gray = im.convert("L")
    # Lift shadows so dark smoke still contributes alpha
    gray = ImageOps.autocontrast(gray, cutoff=1)
    gray = gray.point(lambda p: 0 if p < 10 else min(255, int((p - 10) * 1.55)))
    gray = ImageEnhance.Brightness(gray).enhance(1.25)
    gray = ImageEnhance.Contrast(gray).enhance(1.15)
    gray = gray.filter(ImageFilter.GaussianBlur(0.6))

    # Soft cool-white smoke color
    rgb = Image.new("RGB", im.size, (245, 248, 252))
    rgba = Image.merge("RGBA", (*rgb.split(), gray))
    return rgba


for src_name, out_name in mapping.items():
    im = Image.open(src_dir / src_name).convert("RGB")
    rgba = to_smoke_rgba(im)
    out = out_dir / out_name
    rgba.save(out, "PNG", optimize=True)
    alpha = rgba.split()[3]
    hist = alpha.histogram()
    nz = sum(hist[12:])
    strong = sum(hist[100:])
    print(
        out.name,
        rgba.size,
        f"nz%={100 * nz / (rgba.width * rgba.height):.1f}",
        f"strong%={100 * strong / (rgba.width * rgba.height):.1f}",
        "maxA",
        max(i for i, v in enumerate(hist) if v),
    )

print("done", out_dir)
