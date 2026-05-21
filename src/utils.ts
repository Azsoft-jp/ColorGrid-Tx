import { GridProfile, GridProfileId } from "./types";

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
export function isReservedCell(x: number, y: number, profile: GridProfile): boolean {
  const G = profile.size;
  const F = profile.finderSize;
  const H = profile.headerCellCount;

  // 左上ファインダー
  if (x < F && y < F) return true;
  // 右上ファインダー
  if (x >= G - F && y < F) return true;
  // 左下ファインダー
  if (x < F && y >= G - F) return true;

  // 基準パレット(8色): (7, 0) 〜 (14, 0)
  if (y === 0 && x >= F && x < F + 8) return true;

  // 同期クロック: (7, 1)
  if (y === 1 && x === F) return true;

  // ヘッダ領域: (8, 1) 〜 (8+H-1, 1) に横並び！
  // (もしHが大きくてもひとまず横1列と仮定するみ。超えそうな場合は折り返し必要だけど
  // 今回の最大Header=56でも size=89 なら横に収まるっしょ✌️)
  if (y === 1 && x > F && x <= F + H) return true;

  return false;
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
  }
  return out;
}
