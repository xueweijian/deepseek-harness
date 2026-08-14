#!/usr/bin/env node
/**
 * Regenerates the desktop app icon set from the web frontend's whale favicon.
 *
 * Source of truth: apps/web/public/favicon.svg (DeepSeek whale glyph,
 * fill-rule="nonzero"). Renders a dark rounded-square tile with a white glyph
 * using only Node builtins: SVG path flattening -> supersampled nonzero
 * scanline fill -> area-weighted downscale -> PNG encode -> ICO assembly.
 * Deterministic and idempotent: reruns produce byte-identical outputs.
 *
 * Usage: node desktop/scripts/make-icons.mjs
 *
 * Outputs:
 *   desktop/build/icon.ico          entries 16/24/32/48/64/128/256 (PNG-compressed)
 *   desktop/build/icon.png          512x512 RGBA
 *   desktop/build/icons/256x256.png 256x256 RGBA
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(SCRIPT_DIR, '..');
const SOURCE_SVG = join(DESKTOP_DIR, '..', 'apps', 'web', 'public', 'favicon.svg');
const BUILD_DIR = join(DESKTOP_DIR, 'build');

/** Master rasterization resolution; every output size is downscaled from it. */
const SUPERSAMPLE = 2048;
/** Tile corner radius as a fraction of the canvas size. */
const TILE_RADIUS_RATIO = 0.225;
/** Glyph bounding-box fit as a fraction of the canvas size (contain fit). */
const GLYPH_FIT_RATIO = 0.66;
/** Dark slate tile, echoing the favicon's dark-mode presentation. */
const BG_COLOR = [0x1e, 0x23, 0x30];
const FG_COLOR = [0xff, 0xff, 0xff];
/** Bezier subdivisions per curve; 2048/50 units means chord error stays sub-pixel. */
const CURVE_STEPS = 64;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICON_PNG_SIZE = 512;

/**
 * Extracts the first path data attribute from an SVG document.
 *
 * @param {string} svgText SVG source.
 * @param {string} sourcePath Path named in failure messages.
 * @returns {string} Path `d` attribute value.
 */
function extractPathData(svgText, sourcePath) {
  const match = /<path[^>]*\bd="([^"]+)"/.exec(svgText);
  if (!match) throw new Error(`no <path d="..."> found in ${sourcePath}`);
  return match[1];
}

/**
 * Parses an SVG path into flat polylines (x0,y0,x1,y1,...) in user units,
 * flattening cubic beziers and closing every subpath for filling.
 * Supports M m L l H h V v C c Z z and fails loudly on anything else.
 *
 * @param {string} d Path data.
 * @returns {number[][]} Flat coordinate arrays, one per subpath.
 */
function pathToPolylines(d) {
  const tokens = d.match(/[MmLlHhVvCcZz][^MmLlHhVvCcZz]*/g) ?? [];
  const polylines = [];
  let poly = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const numbers = (text) =>
    text.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
  const lineTo = (x, y) => {
    poly.push(x, y);
    cx = x;
    cy = y;
  };
  const curveTo = (c1x, c1y, c2x, c2y, x, y) => {
    const x0 = cx;
    const y0 = cy;
    for (let i = 1; i <= CURVE_STEPS; i++) {
      const t = i / CURVE_STEPS;
      const u = 1 - t;
      lineTo(
        u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
        u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
      );
    }
  };
  for (const token of tokens) {
    const cmd = token[0];
    const a = numbers(token.slice(1));
    switch (cmd) {
      case 'M':
      case 'm': {
        for (let i = 0; i + 1 < a.length; i += 2) {
          const x = cmd === 'M' ? a[i] : cx + a[i];
          const y = cmd === 'M' ? a[i + 1] : cy + a[i + 1];
          if (i === 0) {
            if (poly.length > 1) polylines.push(poly);
            poly = [x, y];
            sx = x;
            sy = y;
            cx = x;
            cy = y;
          } else {
            lineTo(x, y);
          }
        }
        break;
      }
      case 'L':
      case 'l': {
        for (let i = 0; i + 1 < a.length; i += 2) {
          lineTo(cmd === 'L' ? a[i] : cx + a[i], cmd === 'L' ? a[i + 1] : cy + a[i + 1]);
        }
        break;
      }
      case 'H':
      case 'h': {
        for (let i = 0; i < a.length; i++) lineTo(cmd === 'H' ? a[i] : cx + a[i], cy);
        break;
      }
      case 'V':
      case 'v': {
        for (let i = 0; i < a.length; i++) lineTo(cx, cmd === 'V' ? a[i] : cy + a[i]);
        break;
      }
      case 'C':
      case 'c': {
        for (let i = 0; i + 5 < a.length; i += 6) {
          if (cmd === 'C') curveTo(a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5]);
          else
            curveTo(
              cx + a[i], cy + a[i + 1], cx + a[i + 2], cy + a[i + 3], cx + a[i + 4], cy + a[i + 5],
            );
        }
        break;
      }
      case 'Z':
      case 'z': {
        if (poly.length > 1) {
          lineTo(sx, sy);
          polylines.push(poly);
        }
        poly = [];
        cx = sx;
        cy = sy;
        break;
      }
      default:
        throw new Error(`unsupported SVG path command: ${cmd}`);
    }
  }
  if (poly.length > 1) polylines.push(poly);
  return polylines;
}

/**
 * Computes the bounding box of flat polylines.
 *
 * @param {number[][]} polylines Flat coordinate arrays.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}} Bounds.
 */
function boundingBox(polylines) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polylines) {
    for (let i = 0; i < poly.length; i += 2) {
      if (poly[i] < minX) minX = poly[i];
      if (poly[i] > maxX) maxX = poly[i];
      if (poly[i + 1] < minY) minY = poly[i + 1];
      if (poly[i + 1] > maxY) maxY = poly[i + 1];
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Scales polylines so their bounding box contain-fits a centered square of
 * `SUPERSAMPLE * GLYPH_FIT_RATIO` pixels.
 *
 * @param {number[][]} polylines Flat coordinate arrays in user units.
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} box Bounds.
 * @returns {number[][]} Transformed flat coordinate arrays in master pixels.
 */
function fitToTile(polylines, box) {
  const fit = SUPERSAMPLE * GLYPH_FIT_RATIO;
  const scale = Math.min(fit / (box.maxX - box.minX), fit / (box.maxY - box.minY));
  const tx = SUPERSAMPLE / 2 - (scale * (box.minX + box.maxX)) / 2;
  const ty = SUPERSAMPLE / 2 - (scale * (box.minY + box.maxY)) / 2;
  return polylines.map((poly) => {
    const out = new Array(poly.length);
    for (let i = 0; i < poly.length; i += 2) {
      out[i] = poly[i] * scale + tx;
      out[i + 1] = poly[i + 1] * scale + ty;
    }
    return out;
  });
}

/**
 * Converts closed polylines to a flat edge table (x1,y1,x2,y2 quadruples),
 * dropping horizontal edges, which never cross a scanline.
 *
 * @param {number[][]} polylines Flat coordinate arrays.
 * @returns {Float64Array} Edge coordinates.
 */
function buildEdges(polylines) {
  const quads = [];
  for (const poly of polylines) {
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x1 = poly[i * 2];
      const y1 = poly[i * 2 + 1];
      const x2 = poly[j * 2];
      const y2 = poly[j * 2 + 1];
      if (y1 !== y2) quads.push(x1, y1, x2, y2);
    }
  }
  return Float64Array.from(quads);
}

/**
 * Fills a binary coverage mask using scanline sampling with the nonzero
 * winding rule, matching the SVG fill-rule of the source glyph.
 *
 * @param {Float64Array} edges Edge table from {@link buildEdges}.
 * @param {number} size Canvas width/height in pixels.
 * @returns {Uint8Array} `size * size` coverage mask (0 or 255).
 */
function rasterizeNonzero(edges, size) {
  const mask = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const yc = y + 0.5;
    const xs = [];
    const ws = [];
    for (let e = 0; e < edges.length; e += 4) {
      const y1 = edges[e + 1];
      const y2 = edges[e + 3];
      if ((y1 <= yc && yc < y2) || (y2 <= yc && yc < y1)) {
        const x1 = edges[e];
        const x2 = edges[e + 2];
        xs.push(x1 + ((yc - y1) * (x2 - x1)) / (y2 - y1));
        ws.push(y2 > y1 ? 1 : -1);
      }
    }
    if (xs.length === 0) continue;
    const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
    let winding = 0;
    let spanStart = 0;
    const row = y * size;
    for (const i of order) {
      const before = winding;
      winding += ws[i];
      if (before === 0 && winding !== 0) {
        spanStart = xs[i];
      } else if (before !== 0 && winding === 0) {
        const from = Math.max(0, Math.ceil(spanStart - 0.5));
        const to = Math.min(size, Math.ceil(xs[i] - 0.5));
        mask.fill(255, row + from, row + to);
      }
    }
  }
  return mask;
}

/**
 * Fills a binary coverage mask for a centered rounded square, sampling pixel
 * centers against the corner-circle distance field.
 *
 * @param {number} size Canvas width/height in pixels.
 * @param {number} radiusRatio Corner radius as a fraction of `size`.
 * @returns {Uint8Array} `size * size` coverage mask (0 or 255).
 */
function rasterizeRoundedSquare(size, radiusRatio) {
  const mask = new Uint8Array(size * size);
  const half = size / 2;
  const radius = size * radiusRatio;
  const straight = half - radius;
  for (let y = 0; y < size; y++) {
    const py = Math.abs(y + 0.5 - half);
    const row = y * size;
    let from = 0;
    let to = size;
    if (py > straight) {
      const dy = py - straight;
      if (dy > radius) continue;
      const dx = Math.sqrt(radius * radius - dy * dy);
      from = Math.ceil(half - straight - dx - 0.5);
      to = Math.ceil(half + straight + dx - 0.5);
    }
    mask.fill(255, row + Math.max(0, from), row + Math.min(size, to));
  }
  return mask;
}

/**
 * Area-weighted downscale of a coverage mask to any smaller square size.
 *
 * @param {Uint8Array} src Source mask.
 * @param {number} srcSize Source width/height.
 * @param {number} dstSize Destination width/height (<= `srcSize`).
 * @returns {Uint8Array} `dstSize * dstSize` coverage mask (0..255).
 */
function downsample(src, srcSize, dstSize) {
  if (dstSize === srcSize) return src;
  const dst = new Uint8Array(dstSize * dstSize);
  const k = srcSize / dstSize;
  for (let j = 0; j < dstSize; j++) {
    const y0 = j * k;
    const y1 = y0 + k;
    const j0 = Math.floor(y0);
    const j1 = Math.min(srcSize, Math.ceil(y1));
    for (let i = 0; i < dstSize; i++) {
      const x0 = i * k;
      const x1 = x0 + k;
      const i0 = Math.floor(x0);
      const i1 = Math.min(srcSize, Math.ceil(x1));
      let acc = 0;
      for (let jj = j0; jj < j1; jj++) {
        const wy = Math.min(y1, jj + 1) - Math.max(y0, jj);
        const base = jj * srcSize;
        for (let ii = i0; ii < i1; ii++) {
          const wx = Math.min(x1, ii + 1) - Math.max(x0, ii);
          acc += src[base + ii] * wx * wy;
        }
      }
      dst[j * dstSize + i] = Math.round(acc / (k * k));
    }
  }
  return dst;
}

/**
 * Composites tile and glyph coverage into straight-alpha RGBA pixels: the
 * glyph blends foreground over background; alpha is the tile coverage.
 *
 * @param {Uint8Array} tile Tile coverage mask (0..255).
 * @param {Uint8Array} glyph Glyph coverage mask (0..255).
 * @param {number} size Canvas width/height.
 * @returns {Buffer} `size * size * 4` RGBA pixels.
 */
function composeRGBA(tile, glyph, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const g = glyph[p] / 255;
    const i = p * 4;
    out[i] = Math.round(BG_COLOR[0] + (FG_COLOR[0] - BG_COLOR[0]) * g);
    out[i + 1] = Math.round(BG_COLOR[1] + (FG_COLOR[1] - BG_COLOR[1]) * g);
    out[i + 2] = Math.round(BG_COLOR[2] + (FG_COLOR[2] - BG_COLOR[2]) * g);
    out[i + 3] = tile[p];
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * CRC-32 of a buffer, as used by PNG chunk trailing fields.
 *
 * @param {Buffer} buffer Bytes to checksum.
 * @returns {number} Checksum.
 */
function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encodes an uncompressed-filter RGBA raster as a PNG image.
 *
 * @param {Buffer} rgba `size * size * 4` straight-alpha pixels.
 * @param {number} size Image width/height.
 * @returns {Buffer} Complete PNG file bytes.
 */
function encodePNG(rgba, size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])));
    return Buffer.concat([head, data, crc]);
  };
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Assembles a Windows ICO container around PNG-compressed entries.
 *
 * @param {Map<number, Buffer>} pngBySize PNG payloads keyed by square size.
 * @returns {Buffer} Complete ICO file bytes.
 */
function assembleICO(pngBySize) {
  const sizes = [...pngBySize.keys()];
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const e = 6 + 16 * index;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header[e + 2] = 0;
    header[e + 3] = 0;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    const png = pngBySize.get(size);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...sizes.map((size) => pngBySize.get(size))]);
}

const svgText = readFileSync(SOURCE_SVG, 'utf8');
const pathData = extractPathData(svgText, SOURCE_SVG);
const polylines = pathToPolylines(pathData);
const fitted = fitToTile(polylines, boundingBox(polylines));
const glyphMaster = rasterizeNonzero(buildEdges(fitted), SUPERSAMPLE);
const tileMaster = rasterizeRoundedSquare(SUPERSAMPLE, TILE_RADIUS_RATIO);

/**
 * Renders one output size by downscaling both master masks and compositing.
 *
 * @param {number} size Output width/height.
 * @returns {Buffer} PNG file bytes.
 */
function renderSize(size) {
  const tile = downsample(tileMaster, SUPERSAMPLE, size);
  const glyph = downsample(glyphMaster, SUPERSAMPLE, size);
  return encodePNG(composeRGBA(tile, glyph, size), size);
}

mkdirSync(join(BUILD_DIR, 'icons'), { recursive: true });
const pngBySize = new Map();
for (const size of [...ICO_SIZES, ICON_PNG_SIZE]) pngBySize.set(size, renderSize(size));

const outputs = [
  [join(BUILD_DIR, 'icon.ico'), assembleICO(new Map(ICO_SIZES.map((s) => [s, pngBySize.get(s)])))],
  [join(BUILD_DIR, 'icon.png'), pngBySize.get(ICON_PNG_SIZE)],
  [join(BUILD_DIR, 'icons', '256x256.png'), pngBySize.get(256)],
];
for (const [file, bytes] of outputs) {
  writeFileSync(file, bytes);
  console.log(`${file} (${bytes.length} bytes)`);
}
