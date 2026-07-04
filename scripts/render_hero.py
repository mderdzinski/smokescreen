from __future__ import annotations

import struct
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "assets" / "_hero.html"
OUTPUT = ROOT / "docs" / "assets" / "hero.png"
OPERATOR_IMAGE = ROOT / "docs" / "assets" / "operator-clean.png"
WIDTH = 900
HEIGHT = 300
MAX_BYTES = 200 * 1024
REQUIRED_FONTS = {"Silkscreen", "IBM Plex Mono", "IBM Plex Sans"}


def png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as image:
        header = image.read(24)

    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a valid PNG")

    return struct.unpack(">II", header[16:24])


def ensure_inputs() -> None:
    missing = [path for path in (SOURCE, OPERATOR_IMAGE) if not path.exists()]
    if missing:
        paths = ", ".join(str(path.relative_to(ROOT)) for path in missing)
        raise FileNotFoundError(f"Missing required hero asset(s): {paths}")


def install_chromium() -> None:
    print("Playwright Chromium is missing; installing it now...", file=sys.stderr)
    subprocess.run(
        [sys.executable, "-m", "playwright", "install", "chromium"],
        check=True,
    )


def render_once() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(
                viewport={"width": WIDTH, "height": HEIGHT},
                device_scale_factor=1,
            )
            page.set_default_timeout(60_000)
            page.goto(SOURCE.resolve().as_uri(), wait_until="networkidle")
            page.evaluate("document.fonts ? document.fonts.ready : Promise.resolve()")
            page.locator("img").evaluate_all(
                """images => Promise.all(images.map((image) => {
                    if (image.complete && image.naturalWidth > 0) {
                        return Promise.resolve();
                    }
                    return new Promise((resolve, reject) => {
                        image.addEventListener("load", resolve, { once: true });
                        image.addEventListener("error", reject, { once: true });
                    });
                }))"""
            )

            loaded_fonts = set(
                page.evaluate(
                    """() => Array.from(document.fonts)
                        .filter((font) => font.status === "loaded")
                        .map((font) => font.family.replace(/['"]/g, ""))"""
                )
            )
            missing_fonts = REQUIRED_FONTS - loaded_fonts
            if missing_fonts:
                missing = ", ".join(sorted(missing_fonts))
                raise RuntimeError(f"Google font(s) did not load: {missing}")

            banner = page.locator("#banner")
            banner.wait_for(state="visible")
            box = banner.bounding_box()
            if box is None:
                raise RuntimeError("Could not determine #banner dimensions")
            if round(box["width"]) != WIDTH or round(box["height"]) != HEIGHT:
                actual = f"{round(box['width'])}x{round(box['height'])}"
                raise RuntimeError(
                    f"#banner rendered at {actual}, expected {WIDTH}x{HEIGHT}"
                )

            banner.screenshot(path=str(OUTPUT))
        finally:
            browser.close()


def render() -> None:
    try:
        render_once()
    except PlaywrightError as exc:
        if "Executable doesn't exist" not in str(exc):
            raise
        install_chromium()
        render_once()


def verify_output() -> None:
    dimensions = png_dimensions(OUTPUT)
    if dimensions != (WIDTH, HEIGHT):
        actual = f"{dimensions[0]}x{dimensions[1]}"
        raise RuntimeError(
            f"{OUTPUT.relative_to(ROOT)} is {actual}, expected {WIDTH}x{HEIGHT}"
        )

    size = OUTPUT.stat().st_size
    if size > MAX_BYTES:
        raise RuntimeError(
            f"{OUTPUT.relative_to(ROOT)} is {size} bytes, expected under {MAX_BYTES}"
        )

    print(
        f"Rendered {OUTPUT.relative_to(ROOT)} at {WIDTH}x{HEIGHT} "
        f"({size:,} bytes)"
    )


def main() -> None:
    ensure_inputs()
    render()
    verify_output()


if __name__ == "__main__":
    main()
