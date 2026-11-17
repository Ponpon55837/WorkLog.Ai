/** Types for icon-svg.mjs, so TypeScript tests can import it. */
export interface FaviconGeometry {
  plate: {
    x: number;
    y: number;
    width: number;
    height: number;
    rx: number;
    fill: string;
    stroke: string;
    strokeWidth: number;
  };
  glyph: { stroke: string; strokeWidth: number; points: number[][]; line: number[] };
}
export declare function readFavicon(faviconSvg: string): FaviconGeometry;
export declare function buildDesktopIconSvg(faviconSvg: string): string;
export declare function buildTrayPlateSvg(faviconSvg: string): string;
export declare function buildTrayGlyphSvg(faviconSvg: string): string;
