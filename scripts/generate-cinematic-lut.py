#!/usr/bin/env python3
"""
Generate a cinematic 3D LUT (.cube) tuned for a dark gym/stream setup:
- Warm key light on skin
- Magenta/purple LED accents in the background
- High contrast, deep shadows

Look goals (movie cinematic):
- Classic teal & orange split
- Cooler / more cyan background accents (pull magenta LEDs toward teal)
- Preserve and slightly warm midtone skin
- Soft matte blacks (lift crushed shadows)
- Gentle S-curve contrast + mild midtone desat for a filmic feel
"""

from __future__ import annotations

import math
from pathlib import Path

SIZE = 33  # OBS / StreamFX friendly; also works in Resolve, Premiere, etc.
DOMAIN_MIN = 0.0
DOMAIN_MAX = 1.0


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if x < lo else hi if x > hi else x


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    t = clamp((x - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def luminance(r: float, g: float, b: float) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def s_curve(x: float, contrast: float = 1.18, pivot: float = 0.42) -> float:
    """Soft filmic contrast around a mid-low pivot (good for dim streams)."""
    x = clamp(x)
    # Power contrast around pivot
    if x < pivot:
        t = x / pivot
        t = t ** (1.0 / max(contrast, 1e-6))
        return t * pivot
    t = (x - pivot) / (1.0 - pivot)
    t = t ** contrast
    return pivot + t * (1.0 - pivot)


def lift_gamma_gain(x: float, lift: float, gamma: float, gain: float) -> float:
    """Simple lift/gamma/gain on a single channel (0-1)."""
    y = x * gain + lift
    y = clamp(y)
    if gamma != 1.0:
        y = y ** (1.0 / gamma)
    return clamp(y)


def rgb_to_hsv(r: float, g: float, b: float) -> tuple[float, float, float]:
    mx = max(r, g, b)
    mn = min(r, g, b)
    d = mx - mn
    h = 0.0
    if d > 1e-8:
        if mx == r:
            h = ((g - b) / d) % 6.0
        elif mx == g:
            h = (b - r) / d + 2.0
        else:
            h = (r - g) / d + 4.0
        h /= 6.0
    s = 0.0 if mx < 1e-8 else d / mx
    return h, s, mx


def hsv_to_rgb(h: float, s: float, v: float) -> tuple[float, float, float]:
    h = h % 1.0
    i = int(h * 6.0)
    f = h * 6.0 - i
    p = v * (1.0 - s)
    q = v * (1.0 - f * s)
    t = v * (1.0 - (1.0 - f) * s)
    i %= 6
    if i == 0:
        return v, t, p
    if i == 1:
        return q, v, p
    if i == 2:
        return p, v, t
    if i == 3:
        return p, q, v
    if i == 4:
        return t, p, v
    return v, p, q


def hue_distance(a: float, b: float) -> float:
    d = abs(a - b) % 1.0
    return min(d, 1.0 - d)


def grade(r: float, g: float, b: float) -> tuple[float, float, float]:
    # --- 1) Soft exposure / matte blacks ---------------------------------
    # Lift crushed blacks slightly, tame extreme highlights a touch.
    # Keep black lift modest so live streams don't look milky/blue-muddy.
    lift, gamma, gain = 0.018, 0.97, 0.985
    r = lift_gamma_gain(r, lift, gamma, gain)
    g = lift_gamma_gain(g, lift * 1.05, gamma, gain)
    b = lift_gamma_gain(b, lift * 1.15, gamma, gain)  # slight cool lift in shadows

    # --- 2) Filmic S-curve per channel (keeps color separation) ----------
    r = s_curve(r, contrast=1.14, pivot=0.42)
    g = s_curve(g, contrast=1.12, pivot=0.42)
    b = s_curve(b, contrast=1.15, pivot=0.42)

    # --- 3) Teal & orange split-toning -----------------------------------
    # Shadows → teal/cyan, highlights → warm orange. Protect mid skin.
    lum = luminance(r, g, b)
    shadow_w = 1.0 - smoothstep(0.06, 0.38, lum)
    highlight_w = smoothstep(0.50, 0.90, lum)
    mid_w = 1.0 - shadow_w - highlight_w * 0.65
    mid_w = clamp(mid_w)

    # Shadow teal push (subtle — LEDs handle most of the cool accent)
    r = clamp(r - 0.032 * shadow_w)
    g = clamp(g + 0.012 * shadow_w)
    b = clamp(b + 0.042 * shadow_w)

    # Highlight warm orange push
    r = clamp(r + 0.048 * highlight_w)
    g = clamp(g + 0.016 * highlight_w)
    b = clamp(b - 0.028 * highlight_w)

    # Midtone warmth (skin-friendly)
    r = clamp(r + 0.024 * mid_w)
    g = clamp(g + 0.008 * mid_w)
    b = clamp(b - 0.010 * mid_w)

    # --- 4) Hue-targeted shifts (magenta LEDs → cooler cyan/teal) --------
    # Preserve value so bright LED points stay punchy after the hue swing.
    lum_before_hsv = luminance(r, g, b)
    h, s, v = rgb_to_hsv(r, g, b)
    v_before = v

    # Magenta / hot-pink ~ 0.83–0.95 → shift toward teal (~0.48–0.55)
    magenta_center = 0.90
    magenta_w = (1.0 - hue_distance(h, magenta_center) / 0.12)
    magenta_w = clamp(magenta_w)
    magenta_w *= smoothstep(0.15, 0.55, s) * smoothstep(0.12, 0.45, v)

    # Purple ~ 0.75–0.82 → mild cool shift
    purple_center = 0.78
    purple_w = (1.0 - hue_distance(h, purple_center) / 0.10)
    purple_w = clamp(purple_w)
    purple_w *= smoothstep(0.12, 0.50, s) * smoothstep(0.10, 0.40, v)

    # Apply hue shift toward teal (0.50)
    teal = 0.50
    if magenta_w > 0:
        # Move hue toward teal, keep vibrancy for accent pop
        h = (h + (teal - h) * 0.48 * magenta_w) % 1.0
        s = clamp(s * (1.0 + 0.18 * magenta_w))
        v = clamp(v_before * (1.0 + 0.06 * magenta_w))
    if purple_w > 0:
        h = (h + (teal - h) * 0.30 * purple_w) % 1.0
        s = clamp(s * (1.0 + 0.10 * purple_w))
        v = clamp(max(v, v_before * (1.0 + 0.03 * purple_w)))

    # Skin / orange protection: boost warmth slightly in skin hue band
    skin_center = 0.06  # red-orange
    skin_w = (1.0 - hue_distance(h, skin_center) / 0.08)
    skin_w = clamp(skin_w)
    skin_w *= smoothstep(0.08, 0.35, s) * smoothstep(0.18, 0.55, v)
    if skin_w > 0:
        # Nudge toward warm orange (~0.08) and a touch more sat
        warm = 0.08
        h = (h + (warm - h) * 0.22 * skin_w) % 1.0
        s = clamp(s * (1.0 + 0.07 * skin_w))
        v = clamp(v * (1.0 + 0.015 * skin_w))

    r, g, b = hsv_to_rgb(h, s, v)

    # Restore luminance for hue-shifted LED accents (HSV alone darkens teal vs magenta)
    accent_w = max(magenta_w, purple_w * 0.7)
    if accent_w > 0.01:
        lum_after = luminance(r, g, b)
        if lum_after > 1e-6:
            target_lum = lerp(lum_after, lum_before_hsv * 1.05, accent_w)
            scale = target_lum / lum_after
            # Cap scale so we don't blow out a single channel
            peak = max(r, g, b)
            if peak * scale > 1.0:
                scale = 1.0 / peak
            r = clamp(r * scale)
            g = clamp(g * scale)
            b = clamp(b * scale)

    # --- 5) Midtone desaturation (filmic, not washed out) ----------------
    lum2 = luminance(r, g, b)
    desat = 0.10 * (1.0 - abs(lum2 - 0.45) * 2.0)
    desat = clamp(desat, 0.0, 0.12)
    # Don't desaturate saturated accents (LEDs)
    accent_protect = smoothstep(0.45, 0.75, max(r, g, b) - min(r, g, b))
    desat *= 1.0 - 0.85 * accent_protect
    r = lerp(r, lum2, desat)
    g = lerp(g, lum2, desat)
    b = lerp(b, lum2, desat)

    # --- 6) Soft highlight roll-off (print film feel) --------------------
    peak = max(r, g, b)
    if peak > 0.93:
        soft = 0.93 + (peak - 0.93) * 0.60
        scale = soft / peak
        r *= scale
        g *= scale
        b *= scale

    return clamp(r), clamp(g), clamp(b)


def write_cube(
    path: Path,
    *,
    title: str,
    blend: float = 1.0,
    header_notes: list[str] | None = None,
) -> None:
    """Write a .cube file. `blend` mixes graded result with identity (1 = full look)."""
    notes = header_notes or [
        "Tuned for dark gym streams with magenta LED accents + warm key light.",
        "Compatible with OBS (LUT filter), StreamFX, Resolve, Premiere, etc.",
    ]
    lines = [f"# {title}"]
    lines.extend(f"# {n}" for n in notes)
    lines.extend(
        [
            f'TITLE "{title}"',
            f"LUT_3D_SIZE {SIZE}",
            f"DOMAIN_MIN {DOMAIN_MIN:.6f} {DOMAIN_MIN:.6f} {DOMAIN_MIN:.6f}",
            f"DOMAIN_MAX {DOMAIN_MAX:.6f} {DOMAIN_MAX:.6f} {DOMAIN_MAX:.6f}",
        ]
    )

    # .cube order: R varies fastest, then G, then B
    for bi in range(SIZE):
        b = bi / (SIZE - 1)
        for gi in range(SIZE):
            g = gi / (SIZE - 1)
            for ri in range(SIZE):
                r = ri / (SIZE - 1)
                gr, gg, gb = grade(r, g, b)
                if blend < 1.0:
                    gr = lerp(r, gr, blend)
                    gg = lerp(g, gg, blend)
                    gb = lerp(b, gb, blend)
                lines.append(f"{clamp(gr):.6f} {clamp(gg):.6f} {clamp(gb):.6f}")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {path} ({SIZE}^3 = {SIZE ** 3} entries, blend={blend:.2f})")


def write_preview_samples() -> None:
    """Print a few diagnostic samples so we can sanity-check the grade."""
    samples = {
        "black": (0.0, 0.0, 0.0),
        "shadow": (0.08, 0.08, 0.09),
        "skin_mid": (0.62, 0.42, 0.32),
        "white_tank": (0.95, 0.95, 0.96),
        "magenta_led": (0.75, 0.12, 0.55),
        "purple_led": (0.45, 0.10, 0.55),
        "mid_gray": (0.45, 0.45, 0.45),
    }
    print("\nSample transforms (in → out):")
    for name, rgb in samples.items():
        out = grade(*rgb)
        print(
            f"  {name:12s}  "
            f"({rgb[0]:.3f},{rgb[1]:.3f},{rgb[2]:.3f}) → "
            f"({out[0]:.3f},{out[1]:.3f},{out[2]:.3f})"
        )


if __name__ == "__main__":
    out_dir = Path(__file__).resolve().parents[1] / "luts"
    out_dir.mkdir(parents=True, exist_ok=True)

    write_cube(
        out_dir / "cinematic-stream-teal-orange.cube",
        title="Cinematic Stream TealOrange",
        blend=1.0,
        header_notes=[
            "Full cinematic look: teal shadows, warm skin/highlights, matte blacks.",
            "Pulls magenta LED accents toward cooler teal while protecting skin tones.",
            "Use on your webcam / game capture in OBS. Start intensity ~80–100%.",
        ],
    )
    write_cube(
        out_dir / "cinematic-stream-teal-orange-soft.cube",
        title="Cinematic Stream TealOrange Soft",
        blend=0.55,
        header_notes=[
            "Softer live-safe blend of the cinematic look (~55% strength).",
            "Better default for long streams / bright key light. Bump OBS intensity if needed.",
        ],
    )
    write_preview_samples()
