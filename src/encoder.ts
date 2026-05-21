import { GridProfileId, GridProfile, GRID_PROFILES, PayloadMeta } from "./types";
import { isReservedCell, getHeaderCellIndex, PALETTE_RGB, packTo3Bit } from "./utils";
import { crc32 } from "./checksum";
import { ReedSolomon } from "./rs";

export interface EncoderOptions {
  profileId: GridProfileId;
  cellSize: number;
  marginCells: number;
  fps: number;
}

const DEFAULT_ENCODER_OPTIONS: EncoderOptions = {
  profileId: "M",
  cellSize: 5,
  marginCells: 4,
  fps: 10,
};

export class ColorGridEncoder {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private options: EncoderOptions;
  
  private data: Uint8Array = new Uint8Array(0);
  private meta?: PayloadMeta;
  private chunks: Uint8Array[] = [];
  
  private isStreaming = false;
  public currentChunkIndex = 0;
  private timerId: number | null = null;
  private clockState = 0; // 0 or 1
  private rs = new ReedSolomon();

  constructor(canvas: HTMLCanvasElement, options?: Partial<EncoderOptions>) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context が取れないマジ無理😭");
    this.ctx = ctx;
    this.options = { ...DEFAULT_ENCODER_OPTIONS, ...options };
  }

  setProfile(profileId: GridProfileId): void {
    this.options.profileId = profileId;
    this.rechunk();
  }

  setCellSize(cellSize: number): void {
    this.options.cellSize = cellSize;
  }

  setMarginCells(marginCells: number): void {
    this.options.marginCells = marginCells;
  }

  setData(data: Uint8Array, meta?: PayloadMeta): void {
    this.data = data;
    this.meta = meta;
    this.rechunk();
  }

  /**
   * カパシティ計算してデータチャンクに分割するよ！
   */
  private rechunk() {
    const profile = GRID_PROFILES[this.options.profileId];
    
    // データ入れられるセルの数を数える
    let dataCells = 0;
    for (let y = 0; y < profile.size; y++) {
      for (let x = 0; x < profile.size; x++) {
        if (!isReservedCell(x, y, profile)) dataCells++;
      }
    }

    // 3bit = 0.375 byte
    // パリティを約25% (パリティ長: ceil(k * 0.25)) 付ける
    // つまりデータ部分は実質的に全体の約80%になる（厳密には式で出す）
    const totalBytesPerFrame = Math.floor(dataCells * 3 / 8);
    // RS用に k + ceil(k * 0.25) <= totalBytesPerFrame になるように k を探す
    const dataBytesPerFrame = Math.floor(totalBytesPerFrame / 1.25);
    const parityBytes = totalBytesPerFrame - dataBytesPerFrame;

    this.chunks = [];
    if (this.data.length === 0) return;

    for (let i = 0; i < this.data.length; i += dataBytesPerFrame) {
      this.chunks.push(this.data.slice(i, i + dataBytesPerFrame));
    }
  }

  /**
   * 1チャンクをCanvasに描画するコア部分！
   */
  renderChunk(index: number): void {
    if (this.chunks.length > 0 && index >= this.chunks.length) {
      index = 0;
      this.currentChunkIndex = 0;
    }
    const profile = GRID_PROFILES[this.options.profileId];
    const { cellSize, marginCells } = this.options;
    const marginPx = marginCells * cellSize;
    const sizePx = profile.size * cellSize;

    this.canvas.width = sizePx + marginPx * 2;
    this.canvas.height = sizePx + marginPx * 2;

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.fillStyle = "#ffffff";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // グリッド全体の描画を簡単にするため、オフセット付きで描画関数を用意
    const drawCell = (x: number, y: number, colorIndex: number) => {
      const c = PALETTE_RGB[colorIndex];
      this.ctx.fillStyle = `rgb(${c.r}, ${c.g}, ${c.b})`;
      this.ctx.fillRect(marginPx + x * cellSize, marginPx + y * cellSize, cellSize, cellSize);
    };

    // 1. ファインダー描画
    this.drawFinder(0, 0, drawCell);
    this.drawFinder(profile.size - profile.finderSize, 0, drawCell);
    this.drawFinder(0, profile.size - profile.finderSize, drawCell);

    // タイミングパターン描画
    for (let x = profile.finderSize; x < profile.size - profile.finderSize; x++) {
      drawCell(x, 6, x % 2 === 0 ? 0 : 7); // 0=黒, 7=白
    }
    for (let y = profile.finderSize; y < profile.size - profile.finderSize; y++) {
      drawCell(6, y, y % 2 === 0 ? 0 : 7);
    }

    // アライメントパターン描画
    const apC = profile.size - 6;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const ax = apC + dx;
        const ay = apC + dy;
        let color = 7; // セパレータ＆中間は白
        if (Math.abs(dx) === 2 || Math.abs(dy) === 2) {
          if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) color = 0; // 外枠
        } else if (Math.abs(dx) === 0 && Math.abs(dy) === 0) {
          color = 0; // 中心
        }
        drawCell(ax, ay, color);
      }
    }

    // セパレータ描画（ファインダーの周りを白で塗る）
    // 雖然isReservedCellに該当するためデータは置かれないが、白く塗る処理を追加
    for (let y = 0; y < profile.size; y++) {
      for (let x = 0; x < profile.size; x++) {
        // セパレータの判定を簡易的に（ここは予約セル全般がどうせデータ置かれないので描画しても良いが、明示的にセパレータと枠を白にするならこれ）
        // ただ下で dIdx のループで !isReservedCell のときはデータを描き、それ以外の背景は白にしてあるので特別な処理は不要かも。
        // でも念の為ここでパレットやクロックを描画する前に背景白だからいいか。
      }
    }

    // 2. 基準パレット描画
    for (let i = 0; i < 8; i++) {
      drawCell(profile.finderSize + 1 + i, 0, i);
    }

    // 3. 同期クロック描画
    drawCell(profile.finderSize + 1, 1, this.clockState === 0 ? 0 : 7);

    // 今回のチャンクデータ準備
    const payloadBuffer = this.chunks[index] || new Uint8Array(0);
    
    // Header構成 (12 bytes)
    // magic: 0xC6 (1)
    // profileId: XS=0, S=1, M=2, L=3, XL=4 (1)
    // chunkIndex: index (2)
    // totalChunks: chunks.length (2)
    // payloadLength: payloadBuffer.length (2)
    // payloadChecksum: crc32 (4)
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    view.setUint8(0, 0xC6);  // Magic baby✨
    const pIdx = ["XS", "S", "M", "L", "XL"].indexOf(this.options.profileId);
    view.setUint8(1, pIdx >= 0 ? pIdx : 2); // Default to M
    view.setUint16(2, index, false);
    view.setUint16(4, this.chunks.length, false);
    view.setUint16(6, payloadBuffer.length, false);
    const pCrc = payloadBuffer.length > 0 ? crc32(payloadBuffer) : 0;
    view.setUint32(8, pCrc, false);

    // ヘッダに ReedSolomon をかける！(12 bytes parity => 合計24 bytes = 192 bits = 64 cells)
    const encodedHeader = this.rs.encode(header, 12);

    // Headerを3bit化して描画
    const header3bit = packTo3Bit(encodedHeader);
    for (let y = 0; y < profile.finderSize; y++) {
      for (let x = profile.finderSize; x < profile.size - profile.finderSize; x++) {
        const hIdx = getHeaderCellIndex(x, y, profile);
        if (hIdx !== -1) {
           const val = hIdx < header3bit.length ? header3bit[hIdx] : 0; 
           drawCell(x, y, val);
        }
      }
    }

    // PayloadのRSエンコードと3bit化
    let payload3bit = new Uint8Array(0);
    if (payloadBuffer.length > 0) {
      const parityBytes = Math.ceil(payloadBuffer.length * 0.25);
      const encodedPayload = this.rs.encode(payloadBuffer, parityBytes);
      payload3bit = packTo3Bit(encodedPayload);
    }

    // 予約領域以外にデータセルを順番に配置
    let dIdx = 0;
    for (let y = 0; y < profile.size; y++) {
      for (let x = 0; x < profile.size; x++) {
        if (!isReservedCell(x, y, profile)) {
          const val = dIdx < payload3bit.length ? payload3bit[dIdx] : 7; // 余らすところは白(7)
          drawCell(x, y, val);
          dIdx++;
        }
      }
    }
  }

  private drawFinder(ox: number, oy: number, drawCell: (x: number, y: number, c: number) => void) {
    // 7x7 ファインダー
    // 外周(黒0)、内側(白7)、中央3x3(黒0)
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        let col = 0; // black
        if (x === 0 || x === 6 || y === 0 || y === 6) {
          col = 0;
        } else if (x === 1 || x === 5 || y === 1 || y === 5) {
          col = 7; // white
        } else {
          col = 0;
        }
        drawCell(ox + x, oy + y, col);
      }
    }
  }

  startStreaming(fps: number): void {
    if (this.isStreaming) return;
    this.options.fps = fps;
    this.isStreaming = true;
    this.currentChunkIndex = 0;
    
    // FPS間隔で描画更新
    const tick = () => {
      this.clockState = 1 - this.clockState;
      this.renderChunk(this.currentChunkIndex);
      this.currentChunkIndex++;
      if (this.currentChunkIndex >= Math.max(1, this.chunks.length)) {
        this.currentChunkIndex = 0;
      }
      if (this.isStreaming) {
        this.timerId = window.setTimeout(tick, 1000 / this.options.fps);
      }
    };
    tick();
  }

  stopStreaming(): void {
    this.isStreaming = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  // UI側に情報を出す用
  getStats() {
    return {
      totalChunks: this.chunks.length || 1,
      profile: this.options.profileId,
      cellSize: this.options.cellSize
    };
  }
}
