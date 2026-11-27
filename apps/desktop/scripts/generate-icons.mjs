#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildDesktopIconSvg, buildTrayGlyphSvg, buildTrayPlateSvg } from "./icon-svg.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const buildDirectory = join(scriptsDirectory, "..", "build");
const faviconFile = join(scriptsDirectory, "..", "..", "web", "public", "favicon.svg");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// The @2x entries repeat a pixel size on purpose.
const ICNS_ENTRIES = [
  ["ic04", 16],
  ["ic05", 32],
  ["ic11", 32],
  ["ic07", 128],
  ["ic12", 64],
  ["ic08", 256],
  ["ic13", 256],
  ["ic09", 512],
  ["ic14", 512],
  ["ic10", 1024],
];
const MASTER_SIZE = 1024;
const TRAY_SIZE = 32;
const TRAY_TEMPLATE_SIZE = 16;

async function renderPngs(svg, sizes) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const images = new Map();
    for (const size of sizes) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
      );
      images.set(size, await page.screenshot({ omitBackground: true, type: "png" }));
    }
    return images;
  } finally {
    await browser.close();
  }
}

/** ICO with PNG-compressed entries (Windows Vista and later); a stored size of 0 means 256. */
export function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, index) => {
    const entry = index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entry);
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ png }) => png)]);
}

/** ICNS: the "icns" magic, the total length, then one big-endian (type, length, PNG) record per entry. */
export function packIcns(records) {
  const body = records.map(({ type, png }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + body.reduce((total, record) => total + record.length, 0), 4);
  return Buffer.concat([header, ...body]);
}

async function main() {
  const favicon = readFileSync(faviconFile, "utf8");
  const svg = buildDesktopIconSvg(favicon);
  writeFileSync(join(buildDirectory, "icon.svg"), svg);
  const sizes = [...new Set([...ICO_SIZES, ...ICNS_ENTRIES.map(([, size]) => size), MASTER_SIZE])];
  const images = await renderPngs(svg, sizes);
  const png = (size) => images.get(size);
  const trayPlate = (await renderPngs(buildTrayPlateSvg(favicon), [TRAY_SIZE])).get(TRAY_SIZE);
  const glyph = await renderPngs(buildTrayGlyphSvg(favicon), [TRAY_TEMPLATE_SIZE, TRAY_TEMPLATE_SIZE * 2]);

  writeFileSync(join(buildDirectory, "icon.png"), png(MASTER_SIZE));
  writeFileSync(join(buildDirectory, "tray.png"), trayPlate);
  writeFileSync(join(buildDirectory, "trayTemplate.png"), glyph.get(TRAY_TEMPLATE_SIZE));
  writeFileSync(join(buildDirectory, "trayTemplate@2x.png"), glyph.get(TRAY_TEMPLATE_SIZE * 2));
  writeFileSync(join(buildDirectory, "icon.ico"), packIco(ICO_SIZES.map((size) => ({ size, png: png(size) }))));
  writeFileSync(
    join(buildDirectory, "icon.icns"),
    packIcns(ICNS_ENTRIES.map(([type, size]) => ({ type, png: png(size) }))),
  );
  process.stdout.write(`icons written to ${buildDirectory}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
