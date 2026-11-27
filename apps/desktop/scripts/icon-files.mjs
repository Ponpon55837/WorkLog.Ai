import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ICON_FILES } from "../electron-builder.config.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REQUIRED_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const REQUIRED_ICNS_TYPES = ["ic04", "ic05", "ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"];
const TRAY_FILES = [
  ["tray.png", 32],
  ["trayTemplate.png", 16],
  ["trayTemplate@2x.png", 32],
];

function pngSize(png) {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("an icon entry is not a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function readIcoSizes(file) {
  if (file.readUInt16LE(0) !== 0 || file.readUInt16LE(2) !== 1) throw new Error("not an ICO file");
  const sizes = [];
  for (let index = 0; index < file.readUInt16LE(4); index += 1) {
    const entry = 6 + index * 16;
    const declared = file.readUInt8(entry) || 256;
    const length = file.readUInt32LE(entry + 8);
    const offset = file.readUInt32LE(entry + 12);
    if (offset + length > file.length) throw new Error("an ICO entry runs past the end of the file");
    const { width, height } = pngSize(file.subarray(offset, offset + length));
    if (width !== declared || height !== declared)
      throw new Error(`ICO entry ${declared} holds a ${width}x${height} PNG`);
    sizes.push(declared);
  }
  return sizes;
}

/** Entry types and pixel sizes of an ICNS, in file order. */
export function readIcnsEntries(file) {
  if (file.toString("ascii", 0, 4) !== "icns") throw new Error("not an ICNS file");
  if (file.readUInt32BE(4) !== file.length) throw new Error("the ICNS length field does not match the file size");
  const entries = [];
  for (let offset = 8; offset < file.length;) {
    const length = file.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > file.length) throw new Error("an ICNS entry runs past the end of the file");
    const { width } = pngSize(file.subarray(offset + 8, offset + length));
    entries.push({ type: file.toString("ascii", offset, offset + 4), size: width });
    offset += length;
  }
  return entries;
}

/** Throws unless every icon file the builder config points at exists and has the structure its platform needs. */
export function verifyIconFiles() {
  for (const path of Object.values(ICON_FILES)) {
    if (!existsSync(path))
      throw new Error(`icon file missing: ${path} (run pnpm --filter @work-intelligence/desktop generate-icons)`);
  }
  const icoSizes = readIcoSizes(readFileSync(ICON_FILES.ico));
  for (const size of REQUIRED_ICO_SIZES) {
    if (!icoSizes.includes(size)) throw new Error(`icon.ico has no ${size}px entry`);
  }
  const icnsTypes = readIcnsEntries(readFileSync(ICON_FILES.icns)).map((entry) => entry.type);
  for (const type of REQUIRED_ICNS_TYPES) {
    if (!icnsTypes.includes(type)) throw new Error(`icon.icns has no ${type} entry`);
  }
  for (const [name, expected] of TRAY_FILES) {
    const path = join(dirname(ICON_FILES.png), name);
    if (!existsSync(path))
      throw new Error(`tray icon missing: ${path} (run pnpm --filter @work-intelligence/desktop generate-icons)`);
    const size = pngSize(readFileSync(path));
    if (size.width !== expected || size.height !== expected)
      throw new Error(`${name} is ${size.width}x${size.height}, expected ${expected}x${expected}`);
  }
  const { width, height } = pngSize(readFileSync(ICON_FILES.png));
  if (width !== 1024 || height !== 1024) throw new Error(`icon.png is ${width}x${height}, expected 1024x1024`);
  return { icoSizes, icnsTypes };
}
