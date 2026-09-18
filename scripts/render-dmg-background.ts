// Maintainer-only asset regeneration; ordinary source builds use committed PNGs.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync("assets/dmg-background.svg", "utf8");
const font = readFileSync(
  "node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2",
).toString("base64");
const browser = await chromium.launch();
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({
      viewport: { width: 560, height: 400 },
      deviceScaleFactor: scale,
    });
    await page.route("**/*", (route) => route.abort());
    await page.setContent(
      `<style>@font-face { font-family: 'Instrument Sans'; font-style: normal; font-weight: 100 900; src: url(data:font/woff2;base64,${font}); } body { margin: 0; }</style>${svg}`,
    );
    await page.evaluate(() => document.fonts.ready);
    if (
      !(await page.evaluate(() =>
        document.fonts.check('600 22px "Instrument Sans"'),
      ))
    )
      throw new Error("Installer font did not load.");
    await page.screenshot({
      path: `assets/dmg-background${scale === 2 ? "@2x" : ""}.png`,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

const hash = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(
  "assets/dmg-artwork.json",
  `${JSON.stringify(
    {
      source: hash("assets/dmg-background.svg"),
      font: hash(
        "node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2",
      ),
      png: hash("assets/dmg-background.png"),
      retinaPng: hash("assets/dmg-background@2x.png"),
    },
    null,
    2,
  )}\n`,
);
