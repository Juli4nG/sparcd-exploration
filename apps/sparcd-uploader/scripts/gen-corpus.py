# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow", "piexif"]
# ///

from __future__ import annotations

import io
import sys
from pathlib import Path

import piexif
from PIL import Image


def base_jpeg() -> bytes:
    image = Image.new("RGB", (64, 48), (96, 128, 160))
    exif = {
        "Exif": {
            piexif.ExifIFD.DateTimeOriginal: "2026:07:01 12:00:00",
        },
    }
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=82, exif=piexif.dump(exif))
    return out.getvalue()


def main() -> None:
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 17_000
    corpus = Path("corpus")
    corpus.mkdir(exist_ok=True)
    base = base_jpeg()

    for i in range(count):
        (corpus / f"IMG_{i:05d}.jpg").write_bytes(base + i.to_bytes(4, "big"))

    print(f"wrote {count} JPEGs to {corpus}/ ({len(base)} base bytes + 4 unique bytes each)")


if __name__ == "__main__":
    main()
