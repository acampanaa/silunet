"""Extract the three SILUNET brand lockups from the supplied PNG sheet."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "logo.png"
OUTPUT = ROOT / "public" / "assets"
BACKGROUND = (15, 16, 27)

# The source is a heavily dithered palette PNG. Resizing each known region first
# averages the dither back into the intended flat colors before keying.
VARIANTS = {
    "silunet-wordmark-wide.png": {
        "crop": (1120, 1000, 10120, 3040),
        "working_width": 1800,
        "final_width": 1600,
        "square": False,
    },
    "silunet-wordmark-compact.png": {
        "crop": (1240, 3700, 7560, 5420),
        "working_width": 1400,
        "final_width": 1200,
        "square": False,
    },
    "silunet-mark.png": {
        "crop": (8040, 3440, 10040, 5560),
        "working_width": 900,
        "final_width": 512,
        "square": True,
    },
}


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    value = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return value * value * (3.0 - 2.0 * value)


def remove_background(image: Image.Image) -> Image.Image:
    rgb = np.asarray(image, dtype=np.float32)
    background = np.asarray(BACKGROUND, dtype=np.float32)
    distance = np.linalg.norm(rgb - background, axis=2)

    normalized = np.clip((distance - 1.0) / 11.0, 0.0, 1.0)
    alpha = normalized * normalized * (3.0 - 2.0 * normalized)

    # Quantization creates colored dust throughout nominally empty areas. Keep
    # only distance components that contain a strong brand pixel. Dark wires
    # survive because they connect to cyan/pink artwork; isolated flecks do not.
    candidate = (distance >= 7.0).astype(np.uint8)
    label_count, labels, stats, _ = cv2.connectedComponentsWithStats(
        candidate,
        connectivity=8,
    )
    keep = np.zeros(label_count, dtype=bool)
    strong = distance >= 24.0
    for label in range(1, label_count):
        component = labels == label
        keep[label] = stats[label, cv2.CC_STAT_AREA] >= 18 and np.any(
            strong & component
        )
    alpha *= keep[labels]
    alpha[alpha < 0.30] = 0.0

    # Recover foreground RGB from its blend with the original navy canvas.
    safe_alpha = np.maximum(alpha[..., None], 0.08)
    foreground = (
        rgb - (1.0 - alpha[..., None]) * background
    ) / safe_alpha
    foreground = np.clip(foreground, 0, 255).astype(np.uint8)
    alpha_u8 = np.round(alpha * 255).astype(np.uint8)
    foreground[alpha_u8 == 0] = 0

    return Image.fromarray(np.dstack((foreground, alpha_u8)), mode="RGBA")


def trim_and_pad(image: Image.Image, square: bool) -> Image.Image:
    alpha = image.getchannel("A")
    bbox = alpha.point(lambda value: 255 if value >= 8 else 0).getbbox()
    if bbox is None:
        raise RuntimeError("No foreground pixels found while extracting logo.")

    trimmed = image.crop(bbox)
    padding = max(12, round(max(trimmed.size) * 0.025))

    if square:
        side = max(trimmed.width, trimmed.height) + padding * 2
        canvas = Image.new("RGBA", (side, side))
        canvas.alpha_composite(
            trimmed,
            ((side - trimmed.width) // 2, (side - trimmed.height) // 2),
        )
        return canvas

    canvas = Image.new(
        "RGBA",
        (trimmed.width + padding * 2, trimmed.height + padding * 2),
    )
    canvas.alpha_composite(trimmed, (padding, padding))
    return canvas


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    source = Image.open(SOURCE).convert("RGB")

    for filename, config in VARIANTS.items():
        region = source.crop(config["crop"])
        height = round(region.height * config["working_width"] / region.width)
        region = region.resize(
            (config["working_width"], height),
            Image.Resampling.LANCZOS,
        )
        extracted = trim_and_pad(
            remove_background(region),
            square=config["square"],
        )
        final_height = round(extracted.height * config["final_width"] / extracted.width)
        extracted = extracted.resize(
            (config["final_width"], final_height),
            Image.Resampling.LANCZOS,
        )
        extracted.save(OUTPUT / filename, optimize=True)
        print(
            f"{filename}: {extracted.width}x{extracted.height}, "
            f"alpha={extracted.getchannel('A').getextrema()}"
        )


if __name__ == "__main__":
    main()
