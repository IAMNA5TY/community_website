# Cinematic Stream LUTs

Movie-style 3D LUTs tuned for a dark gym / home-studio stream: warm key light on skin, magenta LED accents, deep shadows.

## Files

| File | Strength | Best for |
|------|----------|----------|
| `cinematic-stream-teal-orange.cube` | Full | Strong cinematic look, VODs / highlight clips |
| `cinematic-stream-teal-orange-soft.cube` | ~55% | Live streams (safer default) |

## Look

- **Teal & orange** split: cooler shadows, warmer highlights / skin
- Magenta / purple LED accents pulled toward **teal / cyan**
- Skin midtones protected and slightly warmed
- Soft **matte blacks** (lifted crushed shadows)
- Gentle filmic S-curve + mild midtone desaturation
- Soft highlight roll-off so whites (tank top, LEDs) don’t clip harshly

## OBS setup

1. Right-click your **webcam** (or main camera) source → **Filters**
2. Click **+** → **Apply LUT**
3. Browse to one of the `.cube` files in this folder
4. Set **Amount**:
   - Soft LUT: start at **100%**
   - Full LUT: start at **70–85%**, then taste
5. Keep the LUT **only on the camera**, not on the whole scene (overlays stay clean)

### Tips

- White-balance the camera first (neutral / slightly warm), then apply the LUT
- If face looks too orange, lower Amount or use the soft LUT
- If background LEDs still feel too pink, bump Amount or switch to the full LUT
- Pair with a soft key light from the front; avoid stacking extra OBS Color Correction on top unless needed

## Regenerate

```bash
python3 scripts/generate-cinematic-lut.py
```

Edit `scripts/generate-cinematic-lut.py` to tweak contrast, teal push, skin warmth, or blend strength, then re-run.
