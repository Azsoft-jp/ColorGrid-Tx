/**
 * 📷 カメラ劣化シミュレーション精度ベンチマーク！
 * エンコード画像に「実カメラで起きる劣化」（縮小・回転・ブラー・ノイズ・
 * コントラスト低下・色被り）を適用してからデコードし、成功率を測定するよ！✨
 *
 * 実行: npx tsx test_camera_sim.ts
 */
import { ColorGridEncoder } from "./src/encoder";
import { ColorGridDecoder } from "./src/decoder";
import { GridProfileId, GRID_PROFILES } from "./src/types";
import { isReservedCell, getBlocksConfig } from "./src/utils";
import crypto from "crypto";

/** エンコーダの rechunk と同一ロジックで1チャンクあたりのデータバイト数を計算 */
function calcDataBytesPerFrame(profileId: GridProfileId): number {
  const profile = GRID_PROFILES[profileId];
  let dataCells = 0;
  for (let y = 0; y < profile.size; y++) {
    for (let x = 0; x < profile.size; x++) {
      if (!isReservedCell(x, y, profile)) dataCells++;
    }
  }
  const totalBytesPerFrame = Math.floor(dataCells * 3 / 8);
  let dataBytesPerFrame = Math.floor(totalBytesPerFrame / 1.25);
  while (dataBytesPerFrame > 0) {
    const configs = getBlocksConfig(dataBytesPerFrame);
    const totalWithParity = dataBytesPerFrame + configs.reduce((sum, c) => sum + c.paritySize, 0);
    if (totalWithParity <= totalBytesPerFrame) break;
    dataBytesPerFrame--;
  }
  return dataBytesPerFrame;
}

// ---- Canvas モック（test_simulation.ts と同等）----
class MockCanvas {
  _width = 100;
  _height = 100;
  data: Uint8ClampedArray = new Uint8ClampedArray(0);
  fillStyle = "rgb(255, 255, 255)";
  imageSmoothingEnabled = false;

  get width() { return this._width; }
  set width(v: number) { this._width = v; this.checkBuffer(); }
  get height() { return this._height; }
  set height(v: number) { this._height = v; this.checkBuffer(); }

  checkBuffer() {
    const len = this._width * this._height * 4;
    if (this.data.length !== len) {
      this.data = new Uint8ClampedArray(len);
      this.data.fill(255);
    }
  }

  getContext(type: string) {
    if (type !== "2d") return null;
    return this;
  }

  fillRect(x: number, y: number, w: number, h: number) {
    let r = 255, g = 255, b = 255;
    if (this.fillStyle.startsWith("rgb")) {
      const match = this.fillStyle.match(/\d+/g);
      if (match) { r = +match[0]; g = +match[1]; b = +match[2]; }
    } else if (this.fillStyle.startsWith("#")) {
      const hex = this.fillStyle.slice(1);
      if (hex.length === 6) {
        r = parseInt(hex.slice(0, 2), 16);
        g = parseInt(hex.slice(2, 4), 16);
        b = parseInt(hex.slice(4, 6), 16);
      }
    }
    this.checkBuffer();
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const px = Math.floor(x + dx);
        const py = Math.floor(y + dy);
        if (px >= 0 && px < this._width && py >= 0 && py < this._height) {
          const idx = (py * this._width + px) * 4;
          this.data[idx] = r; this.data[idx + 1] = g; this.data[idx + 2] = b; this.data[idx + 3] = 255;
        }
      }
    }
  }

  getImageData(sx: number, sy: number, sw: number, sh: number) {
    const subset = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const srcIdx = ((sy + y) * this._width + (sx + x)) * 4;
        const dstIdx = (y * sw + x) * 4;
        subset[dstIdx] = this.data[srcIdx];
        subset[dstIdx + 1] = this.data[srcIdx + 1];
        subset[dstIdx + 2] = this.data[srcIdx + 2];
        subset[dstIdx + 3] = 255;
      }
    }
    return { width: sw, height: sh, data: subset } as unknown as ImageData;
  }
}

interface Img { width: number; height: number; data: Uint8ClampedArray; }

// ---- シード付き擬似乱数（再現性のため）----
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function gaussianPair(rng: () => number): number {
  // Box-Muller
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---- 劣化フィルタ群 ----

/** 回転＋シアー＋スケールをまとめた逆写像バイリニアワープ。背景はグレー。 */
function warp(src: Img, scale: number, rotDeg: number, shear: number, pad: number): Img {
  const rot = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const dstW = Math.round(src.width * scale) + pad * 2;
  const dstH = Math.round(src.height * scale) + pad * 2;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const cxD = dstW / 2, cyD = dstH / 2;
  const cxS = src.width / 2, cyS = src.height / 2;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      // 逆変換: dst中心基準 → 回転戻し → シアー戻し → スケール戻し → src座標
      const dx = x - cxD, dy = y - cyD;
      const rx = (cos * dx + sin * dy);
      const ry = (-sin * dx + cos * dy);
      const ux = (rx - shear * ry) / scale + cxS;
      const uy = ry / scale + cyS;
      const di = (y * dstW + x) * 4;
      if (ux < 0 || uy < 0 || ux >= src.width - 1 || uy >= src.height - 1) {
        out[di] = 190; out[di + 1] = 190; out[di + 2] = 195; out[di + 3] = 255;
        continue;
      }
      const x0 = Math.floor(ux), y0 = Math.floor(uy);
      const fx = ux - x0, fy = uy - y0;
      for (let c = 0; c < 3; c++) {
        const i00 = (y0 * src.width + x0) * 4 + c;
        const i10 = i00 + 4;
        const i01 = i00 + src.width * 4;
        const i11 = i01 + 4;
        out[di + c] =
          src.data[i00] * (1 - fx) * (1 - fy) +
          src.data[i10] * fx * (1 - fy) +
          src.data[i01] * (1 - fx) * fy +
          src.data[i11] * fx * fy;
      }
      out[di + 3] = 255;
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/** 分離型ガウスぼかし */
function blur(img: Img, sigma: number): Img {
  if (sigma <= 0) return img;
  const radius = Math.max(1, Math.ceil(sigma * 2));
  const kernel: number[] = [];
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v); ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

  const { width, height } = img;
  const tmp = new Float32Array(width * height * 3);
  const out = new Uint8ClampedArray(width * height * 4);
  // horizontal
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k));
        const i = (y * width + xx) * 4;
        const w = kernel[k + radius];
        r += img.data[i] * w; g += img.data[i + 1] * w; b += img.data[i + 2] * w;
      }
      const t = (y * width + x) * 3;
      tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = b;
    }
  }
  // vertical
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k));
        const t = (yy * width + x) * 3;
        const w = kernel[k + radius];
        r += tmp[t] * w; g += tmp[t + 1] * w; b += tmp[t + 2] * w;
      }
      const o = (y * width + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** コントラスト圧縮＋チャンネル色被り＋ガンマ */
function tone(img: Img, black: number, white: number, cast: [number, number, number], gamma: number): Img {
  const out = new Uint8ClampedArray(img.data.length);
  const range = white - black;
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = img.data[i + c] / 255;
      v = Math.pow(v, gamma);
      v = (black + v * range) * cast[c];
      out[i + c] = Math.max(0, Math.min(255, v));
    }
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

/** ガウスノイズ付加 */
function addNoise(img: Img, sigma: number, rng: () => number): Img {
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      out[i + c] = Math.max(0, Math.min(255, img.data[i + c] + gaussianPair(rng) * sigma));
    }
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

// ---- シナリオ定義 ----
interface Scenario {
  name: string;
  targetCellWidth: number; // 縮小後の1セルのピクセル数
  rotDeg: number;
  shear: number;
  blurSigma: number;
  noiseSigma: number;
  black: number;
  white: number;
  cast: [number, number, number];
  gamma: number;
}

const SCENARIOS: Scenario[] = [
  { name: "easy   (cw6.0 rot1° blur0.5 noise4) ", targetCellWidth: 6.0, rotDeg: 1, shear: 0.01, blurSigma: 0.5, noiseSigma: 4, black: 25, white: 225, cast: [1.0, 1.0, 1.0], gamma: 1.0 },
  { name: "typical(cw4.5 rot2° blur0.8 noise6) ", targetCellWidth: 4.5, rotDeg: 2, shear: 0.02, blurSigma: 0.8, noiseSigma: 6, black: 40, white: 205, cast: [1.05, 1.0, 0.92], gamma: 0.95 },
  { name: "hard   (cw3.2 rot4° blur1.0 noise8) ", targetCellWidth: 3.2, rotDeg: 4, shear: 0.03, blurSigma: 1.0, noiseSigma: 8, black: 50, white: 190, cast: [1.08, 1.0, 0.88], gamma: 0.9 },
  { name: "extreme(cw2.6 rot6° blur1.2 noise10)", targetCellWidth: 2.6, rotDeg: 6, shear: 0.04, blurSigma: 1.2, noiseSigma: 10, black: 55, white: 180, cast: [1.1, 1.0, 0.85], gamma: 0.88 },
];

const PROFILES: GridProfileId[] = ["XS", "S", "M", "L"];
const CHUNKS_PER_CASE = 4;
const FRAMES_PER_CHUNK = 3;
const RENDER_CELL_SIZE = 8;

async function main() {
  console.log("📷 カメラ劣化シミュレーション ベンチマーク開始！");
  let grandTotal = 0;
  let grandOk = 0;
  const rows: string[] = [];

  for (const scenario of SCENARIOS) {
    for (const profileId of PROFILES) {
      const canvas = new MockCanvas() as unknown as HTMLCanvasElement;
      const encoder = new ColorGridEncoder(canvas, {
        profileId,
        cellSize: RENDER_CELL_SIZE,
        marginCells: 4,
        fps: 10,
      });
      // データ量: CHUNKS_PER_CASE チャンクに分かれるサイズを作る
      const per = calcDataBytesPerFrame(profileId);
      const dataLen = per * CHUNKS_PER_CASE - Math.floor(per / 2);
      const rngData = makeRng(0xC061 + profileId.charCodeAt(0));
      const payload = new Uint8Array(dataLen);
      for (let i = 0; i < dataLen; i++) payload[i] = Math.floor(rngData() * 256);
      encoder.setData(payload, { type: "file", filename: "t.bin" });

      const totalChunks = encoder.getStats().totalChunks;
      const testChunks = Math.min(totalChunks, CHUNKS_PER_CASE);
      const decoder = new ColorGridDecoder();
      decoder.debugMode = false;

      let okCount = 0;
      const failPhases: string[] = [];

      for (let ci = 0; ci < testChunks; ci++) {
        encoder.renderChunk(ci);
        const ctx = canvas.getContext("2d") as any;
        const rendered = ctx.getImageData(0, 0, canvas.width, canvas.height) as Img;

        const scale = scenario.targetCellWidth / RENDER_CELL_SIZE;
        let chunkOk = false;
        let lastReason = "";
        for (let f = 0; f < FRAMES_PER_CHUNK; f++) {
          const rng = makeRng(ci * 7919 + f * 104729 + scenario.targetCellWidth * 1000);
          let img = warp(rendered, scale, scenario.rotDeg, scenario.shear, 24);
          img = blur(img, scenario.blurSigma);
          img = tone(img, scenario.black, scenario.white, scenario.cast, scenario.gamma);
          img = addNoise(img, scenario.noiseSigma, rng);
          const res = decoder.decodeFrame(img as unknown as ImageData);
          if (res.ok && res.chunk && res.chunk.chunkIndex === ci) {
            const expected = payload.slice(ci * per, ci * per + res.chunk.payload.length);
            const gotHash = crypto.createHash("sha1").update(res.chunk.payload).digest("hex");
            const expHash = crypto.createHash("sha1").update(expected).digest("hex");
            if (gotHash === expHash) {
              chunkOk = true;
              break;
            } else {
              lastReason = "payload mismatch (CRC passed but data differs?)";
            }
          } else if (!res.ok) {
            const failed = res.debug?.phaseLogs?.filter(p => !p.ok).map(p => p.phase);
            lastReason = failed && failed.length > 0 ? [...new Set(failed)].join(",") : (res.reason || "").split("\n")[0].slice(0, 60);
          }
        }
        if (chunkOk) okCount++;
        else failPhases.push(`c${ci}:${lastReason}`);
      }

      grandTotal += testChunks;
      grandOk += okCount;
      const rate = ((okCount / testChunks) * 100).toFixed(0).padStart(3);
      const line = `${scenario.name} | ${profileId.padEnd(2)} | ${okCount}/${testChunks} (${rate}%)${failPhases.length > 0 ? "  fails → " + failPhases.join(" ; ") : ""}`;
      rows.push(line);
      console.log(line);
    }
  }

  console.log("\n===== 総合結果 =====");
  console.log(`成功: ${grandOk}/${grandTotal} (${((grandOk / grandTotal) * 100).toFixed(1)}%)`);
}

main();
