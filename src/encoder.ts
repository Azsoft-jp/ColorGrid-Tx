import { GridProfileId, GridProfile, GRID_PROFILES, PayloadMeta } from "./types";
import { isReservedCell, PALETTE_RGB, packTo3Bit } from "./utils";
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
  private currentChunkIndex = 0;
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

    // 2. 基準パレット描画
    for (let i = 0; i < 8; i++) {
      drawCell(profile.finderSize + i, 0, i);
    }

    // 3. 同期クロック描画
    drawCell(profile.finderSize, 1, this.clockState === 0 ? 0 : 7);

    // 今回のチャンクデータ準備
    const payloadBuffer = this.chunks[index] || new Uint8Array(0);
    
    // Header構成 (23 bytes)
    // magic: 0x43475458 (4)
    // version: 1 (1)
    // profileId: S=0, M=1, L=2, XL=3 (1)
    // gridSize: profile.size (2)
    // flags: 0 (1)
    // chunkIndex: index (2)
    // totalChunks: chunks.length (2)
    // payloadLength: payloadBuffer.length (2)
    // payloadChecksum: crc32 (4)
    // headerChecksum: crc32 (4) // 自身より前の19bytesのcrc32
    const header = new Uint8Array(23);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x43475458, false); // BigEndian
    view.setUint8(4, 1);
    const pIdx = ["S", "M", "L", "XL"].indexOf(this.options.profileId);
    view.setUint8(5, pIdx >= 0 ? pIdx : 1);
    view.setUint16(6, profile.size, false);
    view.setUint8(8, 0); // flags
    view.setUint16(9, index, false);
    view.setUint16(11, this.chunks.length, false);
    view.setUint16(13, payloadBuffer.length, false);
    
    const pCrc = payloadBuffer.length > 0 ? crc32(payloadBuffer) : 0;
    view.setUint32(15, pCrc, false);
    
    const hCrc = crc32(header.slice(0, 19));
    view.setUint32(19, hCrc, false);

    // Headerを3bit化して描画
    const header3bit = packTo3Bit(header);
    for (let i = 0; i < profile.headerCellCount; i++) {
        const val = i < header3bit.length ? header3bit[i] : 0; 
        drawCell(profile.finderSize + 1 + i, 1, val);
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
