import { GridProfile, GridProfileId, Point } from "./types";

export const PALETTE_RGB = [
  { r: 0, g: 0, b: 0 },       // 0: black
  { r: 0, g: 0, b: 255 },     // 1: blue
  { r: 0, g: 255, b: 0 },     // 2: green
  { r: 0, g: 255, b: 255 },   // 3: cyan
  { r: 255, g: 0, b: 0 },     // 4: red
  { r: 255, g: 0, b: 255 },   // 5: magenta
  { r: 255, g: 255, b: 0 },   // 6: yellow
  { r: 255, g: 255, b: 255 }, // 7: white
];

/**
 * データの書き込みを除外する予約セル判定！
 * ファインダーやパレット、ヘッダにはデータ被らせないようにするよ✨
 */
export function getHeaderCellIndex(x: number, y: number, profile: GridProfile): number {
  const G = profile.size;
  const F = profile.finderSize;
  const H = profile.headerCellCount;
  
  if (y >= F) return -1;
  if (x < F || x >= G - F) return -1;
  
  // y=0: パレット (x=F+1 ~ F+8)
  if (y === 0 && x >= F + 1 && x < F + 9) return -1;
  // y=1: クロック (x=F+1)
  if (y === 1 && x === F + 1) return -1;

  // タイミングパターン
  if (y === 6) return -1;
  
  let idx = 0;
  for (let cy = 0; cy <= y; cy++) {
    for (let cx = F + 1; cx < G - F - 1; cx++) {
      if (cy === 0 && cx >= F + 1 && cx < F + 9) continue;
      if (cy === 1 && cx === F + 1) continue;
      if (cy === 6) continue;
      
      if (cy === y && cx === x) {
        return idx < H ? idx : -1;
      }
      idx++;
    }
  }
  return -1;
}

export function getAlignmentCenters(size: number, profileId: GridProfileId): Point[] {
  if (profileId === "XS") {
    return [{ x: size - 6, y: size - 6 }];
  }
  const mid = Math.floor(size / 2);
  if (profileId === "S") {
    return [
      { x: mid, y: mid },
      { x: size - 6, y: size - 6 }
    ];
  }
  if (profileId === "M") {
    return [
      { x: mid, y: mid },
      { x: size - 6, y: mid },
      { x: mid, y: size - 6 },
      { x: size - 6, y: size - 6 }
    ];
  }
  // L, XL
  return [
    { x: mid, y: mid },
    { x: size - 6, y: mid },
    { x: mid, y: size - 6 },
    { x: size - 6, y: size - 6 },
    { x: Math.floor(size * 0.33), y: Math.floor(size * 0.66) },
    { x: Math.floor(size * 0.66), y: Math.floor(size * 0.33) }
  ];
}

export function isReservedCell(x: number, y: number, profile: GridProfile): boolean {
  const G = profile.size;
  const F = profile.finderSize;

  // 左上ファインダー + 1セルのセパレータ (Fまで)
  if (x <= F && y <= F) return true;
  // 右上ファインダー + セパレータ (G-F-1から)
  if (x >= G - F - 1 && y <= F) return true;
  // 左下ファインダー + セパレータ
  if (x <= F && y >= G - F - 1) return true;

  // セパレータ（ファインダー周囲1セルは常に白）
  // 左上ファインダー周囲
  if ((x === F && y <= F) || (y === F && x <= F)) return true;
  // 右上ファインダー周囲
  if ((x === G - F - 1 && y <= F) || (y === F && x >= G - F - 1)) return true;
  // 左下ファインダー周囲
  if ((x === F && y >= G - F - 1) || (y === G - F - 1 && x <= F)) return true;

  // タイミングパターン (x=6 と y=6, ファインダーパターンの間を結ぶ)
  if (y === 6 && x >= 7 && x < G - 7) return true;
  if (x === 6 && y >= 7 && y < G - 7) return true;

  // 複数アライメントパターン + 周囲セパレータ (7x7)
  const apCenters = getAlignmentCenters(G, profile.id);
  for (const ap of apCenters) {
    if (x >= ap.x - 3 && x <= ap.x + 3 && y >= ap.y - 3 && y <= ap.y + 3) {
      return true;
    }
  }

  // 基準パレット(8色): (F+1, 0) 〜 (F+8, 0)
  if (y === 0 && x >= F + 1 && x < F + 9) return true;

  // 同期クロック: (F+1, 1)
  if (y === 1 && x === F + 1) return true;

  // ヘッダ領域
  if (getHeaderCellIndex(x, y, profile) !== -1) return true;

  return false;
}

export function getColorGridMask(maskPattern: number, x: number, y: number): number {
  switch (maskPattern) {
    case 0: return (x + y) & 7;
    case 1: return (x * 3 + y) & 7;
    case 2: return (x + y * 3) & 7;
    case 3: return (x * y) & 7;
    case 4: return ((Math.floor(x / 2) + Math.floor(y / 3)) & 7);
    case 5: return ((x * y + x + y) & 7);
    case 6: return (((x * 5) ^ (y * 3)) & 7);
    case 7: return (((x + y) * 3 + (x * y)) & 7);
    default: return 0;
  }
}

export interface BlockConfig {
  dataSize: number;
  paritySize: number;
}

export function getBlocksConfig(payloadLength: number): BlockConfig[] {
  const MAX_BLOCK_DATA_SIZE = 96;
  const blockCount = Math.ceil(payloadLength / MAX_BLOCK_DATA_SIZE);
  if (blockCount <= 1) {
    return [{ dataSize: payloadLength, paritySize: Math.ceil(payloadLength * 0.25) }];
  }
  const baseSize = Math.floor(payloadLength / blockCount);
  const remainder = payloadLength % blockCount;
  const configs: BlockConfig[] = [];
  for (let b = 0; b < blockCount; b++) {
    const dSize = baseSize + (b < remainder ? 1 : 0);
    configs.push({
      dataSize: dSize,
      paritySize: Math.ceil(dSize * 0.25)
    });
  }
  return configs;
}

/**
 * Byte配列(8bit)を、3bitずつの配列(値0〜7)にパッキングする処理！
 */
export function packTo3Bit(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (let i = 0; i < data.length; i++) {
    bitBuffer = (bitBuffer << 8) | data[i];
    bitCount += 8;
    while (bitCount >= 3) {
      bitCount -= 3;
      out.push((bitBuffer >>> bitCount) & 0x7);
    }
    bitBuffer &= (1 << bitCount) - 1;
  }
  if (bitCount > 0) {
    out.push((bitBuffer << (3 - bitCount)) & 0x7);
  }
  return new Uint8Array(out);
}

/**
 * 3bit列から元の8bit配列にアンパッキング！
 */
export function unpackFrom3Bit(data: Uint8Array, originalByteLength: number): Uint8Array {
  const out = new Uint8Array(originalByteLength);
  let outIdx = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  for (let i = 0; i < data.length; i++) {
    bitBuffer = (bitBuffer << 3) | (data[i] & 0x7);
    bitCount += 3;
    while (bitCount >= 8) {
      bitCount -= 8;
      if (outIdx < originalByteLength) {
        out[outIdx++] = (bitBuffer >>> bitCount) & 0xFF;
      }
    }
    bitBuffer &= (1 << bitCount) - 1;
  }
  return out;
}

export type Unpack3BitResult = {
  bytes: Uint8Array;
  erasureBytePositions: number[];
  erasureCellCount: number;
};

export function unpackFrom3BitWithErasures(values: number[], byteLen: number): Unpack3BitResult {
  const out = new Uint8Array(byteLen);
  const erasures = new Set<number>();
  let erasureCellCount = 0;
  let bitPos = 0;

  for (const v of values) {
    const byteA = Math.floor(bitPos / 8);
    const byteB = Math.floor((bitPos + 2) / 8);

    if (v < 0 || v > 7) {
      erasureCellCount++;
      if (byteA < byteLen) erasures.add(byteA);
      if (byteB < byteLen) erasures.add(byteB);
      bitPos += 3;
      if (bitPos >= byteLen * 8) break;
      continue;
    }

    for (let b = 2; b >= 0; b--) {
      const bit = (v >> b) & 1;
      const byteIndex = Math.floor(bitPos / 8);
      const bitOffset = 7 - (bitPos % 8);
      if (byteIndex < byteLen) {
        out[byteIndex] |= bit << bitOffset;
      }
      bitPos++;
      if (bitPos >= byteLen * 8) break;
    }

    if (bitPos >= byteLen * 8) break;
  }

  return {
    bytes: out,
    erasureBytePositions: [...erasures].sort((a, b) => a - b),
    erasureCellCount
  };
}
