import { ColorGridEncoder } from "./src/encoder";
import { ColorGridDecoder } from "./src/decoder";
import crypto from "crypto";

// HTMLCanvasElement と CanvasRenderingContext2D の簡易モック
class MockCanvas {
  _width = 100;
  _height = 100;
  data: Uint8ClampedArray = new Uint8ClampedArray(0);
  fillStyle = "rgb(255, 255, 255)";
  imageSmoothingEnabled = false;

  get width() {
    return this._width;
  }
  set width(v: number) {
    this._width = v;
    this.checkBuffer();
  }

  get height() {
    return this._height;
  }
  set height(v: number) {
    this._height = v;
    this.checkBuffer();
  }

  checkBuffer() {
    const len = this._width * this._height * 4;
    if (this.data.length !== len) {
      this.data = new Uint8ClampedArray(len);
      this.data.fill(255); // 白で初期化するよ✨
    }
  }

  getContext(type: string) {
    if (type !== '2d') return null;
    return this;
  }

  fillRect(x: number, y: number, w: number, h: number) {
    let r = 255, g = 255, b = 255;
    if (this.fillStyle.startsWith("rgb")) {
      const match = this.fillStyle.match(/\d+/g);
      if (match) {
        r = parseInt(match[0]);
        g = parseInt(match[1]);
        b = parseInt(match[2]);
      }
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
          this.data[idx] = r;
          this.data[idx + 1] = g;
          this.data[idx + 2] = b;
          this.data[idx + 3] = 255;
        }
      }
    }
  }

  getImageData(sx: number, sy: number, sw: number, sh: number) {
    const subset = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const srcX = Math.floor(sx + x);
        const srcY = Math.floor(sy + y);
        const srcIdx = (srcY * this._width + srcX) * 4;
        const dstIdx = (y * sw + x) * 4;
        if (srcX >= 0 && srcX < this._width && srcY >= 0 && srcY < this._height) {
          subset[dstIdx] = this.data[srcIdx];
          subset[dstIdx + 1] = this.data[srcIdx + 1];
          subset[dstIdx + 2] = this.data[srcIdx + 2];
          subset[dstIdx + 3] = this.data[srcIdx + 3];
        } else {
          subset[dstIdx] = 255;
          subset[dstIdx + 1] = 255;
          subset[dstIdx + 2] = 255;
          subset[dstIdx + 3] = 255;
        }
      }
    }
    return {
      width: sw,
      height: sh,
      data: subset
    } as unknown as ImageData;
  }
}

async function runTest() {
  console.log("🔥 シミュレーションテスト開始するよ！");

  // 1. ダミーデータの作成（500KB）
  const size = 500 * 1024;
  const dummyData = crypto.randomBytes(size);
  console.log(`🔑 500KBのランダムバイナリを作成したよ。長さ: ${dummyData.length} bytes`);

  // 2. エンコーダのセットアップ
  const canvas = new MockCanvas() as unknown as HTMLCanvasElement;
  const encoder = new ColorGridEncoder(canvas, {
    profileId: "M",
    cellSize: 5,
    marginCells: 4,
    fps: 10
  });

  encoder.setData(dummyData, { type: "file", filename: "tmp.dat", mimeType: "application/octet-stream" });
  console.log(`📦 データ分割完了：${encoder.getStats().totalChunks} チャンクに分かれたよ。`);

  // 1枚目（chunk 0）を描画してみてテスト
  console.log("🎨 1枚目のチャンク（0番目）を描画するよ！");
  encoder.renderChunk(0);

  // 3. デコーダのセットアップ
  const ctx = canvas.getContext('2d') as any;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const decoder = new ColorGridDecoder();

  console.log("🔍 デコードを実行するよ！");
  const res = decoder.decodeFrame(imageData);

  if (res.ok) {
    console.log("✨ デコード大成功ーーーー！！！！！ヤバい！");
    console.log(`チャンクインデックス: ${res.chunk?.chunkIndex} / ${res.chunk?.totalChunks}`);
    console.log(`ペイロード長: ${res.chunk?.payload.length} bytes`);
    
    // サンプリングしたセルのうち、ヘッダセルの座標と、期待される中心座標をいくつか出してみる
    if (res.debug && res.debug.corners) {
       console.log("Detected Corners:", res.debug.corners);
    }
  } else {
    console.log("😭 デコード失敗しちゃった、、、マジ無理。");
    console.log(`理由: ${res.reason}`);
    if (res.debug) {
      console.log("Debug Info:", {
        finderPoints: res.debug.finderPoints,
        corners: res.debug.corners,
        clockValue: res.debug.clockValue,
        estimatedGridSize: res.debug.estimatedGridSize,
        detectedProfileId: res.debug.detectedProfileId
      });
    }
  }
}

runTest();
