import { GridProfileId, GridProfile, GRID_PROFILES, PayloadMeta } from "./types";
import { isReservedCell, getHeaderCellIndex, PALETTE_RGB, packTo3Bit, getAlignmentCenters, getColorGridMask, getBlocksConfig } from "./utils";
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
  
  // 双方向モードなどで、特定のチャンクのみをクロック変滅させながら固定放出する用のプロパティだよ！✨
  public forceChunkIndex: number | null = null;
  public forceChunkList: number[] | null = null;
  private forceChunkListIndex = 0;
  
  // 今どのチャンクを送ってるかをUIに伝えるためのコールバックだよ！✨
  public onChunkChange?: (index: number, total: number) => void;

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
    const totalBytesPerFrame = Math.floor(dataCells * 3 / 8);
    
    // 新ブロック分割(1ブロック最大96バイト)の構成に合わせて、
    // パリティを含めた合計バイト数が totalBytesPerFrame 以下になる最大データバイト数 k を探索！
    let dataBytesPerFrame = Math.floor(totalBytesPerFrame / 1.25);
    while (dataBytesPerFrame > 0) {
      const configs = getBlocksConfig(dataBytesPerFrame);
      const totalWithParity = dataBytesPerFrame + configs.reduce((sum, c) => sum + c.paritySize, 0);
      if (totalWithParity <= totalBytesPerFrame) {
        break;
      }
      dataBytesPerFrame--;
    }

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

    // 複数アライメントパターン描画！✨
    const apList = getAlignmentCenters(profile.size, this.options.profileId);
    for (const ap of apList) {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const ax = ap.x + dx;
          const ay = ap.y + dy;
          let color = 7; // 白
          if (Math.abs(dx) === 2 || Math.abs(dy) === 2) {
            if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) color = 0; // 黒
          } else if (Math.abs(dx) === 0 && Math.abs(dy) === 0) {
            color = 0; // 黒
          }
          drawCell(ax, ay, color);
        }
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

    // PayloadのRSエンコード（新ブロック化＆インターリーブ方式）と3bit化
    // 評価時に使うため事前に算出＆保持！
    let payload3bit = new Uint8Array(0);
    if (payloadBuffer.length > 0) {
      const configs = getBlocksConfig(payloadBuffer.length);
      const dataBlocks: Uint8Array[] = [];
      const parityBlocks: Uint8Array[] = [];
      let offset = 0;
      for (const config of configs) {
        const part = payloadBuffer.slice(offset, offset + config.dataSize);
        offset += config.dataSize;
        dataBlocks.push(part);
        const par = this.rs.encode(part, config.paritySize);
        const parityPart = par.slice(config.dataSize);
        parityBlocks.push(parityPart);
      }

      const interleaved: number[] = [];
      const maxDataLen = Math.max(...dataBlocks.map(b => b.length));
      for (let i = 0; i < maxDataLen; i++) {
        for (const b of dataBlocks) {
          if (i < b.length) interleaved.push(b[i]);
        }
      }

      const maxParityLen = Math.max(...parityBlocks.map(b => b.length));
      for (let i = 0; i < maxParityLen; i++) {
        for (const p of parityBlocks) {
          if (i < p.length) interleaved.push(p[i]);
        }
      }

      payload3bit = packTo3Bit(new Uint8Array(interleaved));
    }

    // 8種類のマスクパターン(0..7)を評価して、最もペナルティの低いパターンを採用するお！
    const evaluateMask = (maskPattern: number): number => {
      const grid = new Uint8Array(profile.size * profile.size);
      const totalCh = this.chunks.length;
      let seed = (index * 1000003 + totalCh * 7) >>> 0;
      const nextRand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed % 8;
      };

      let dIdx = 0;
      for (let y = 0; y < profile.size; y++) {
        for (let x = 0; x < profile.size; x++) {
          const cellIdx = y * profile.size + x;
          if (isReservedCell(x, y, profile)) {
            grid[cellIdx] = 0;
          } else {
            let val = 7;
            if (dIdx < payload3bit.length) {
              val = payload3bit[dIdx];
            } else {
              val = nextRand();
            }
            grid[cellIdx] = val ^ getColorGridMask(maskPattern, x, y);
            dIdx++;
          }
        }
      }

      let score = 0;
      const N = profile.size;

      // 1. 同色ラン長ペナルティ（5連続から）
      for (let y = 0; y < N; y++) {
        let runLen = 1;
        let runVal = grid[y * N];
        for (let x = 1; x < N; x++) {
          const val = grid[y * N + x];
          if (isReservedCell(x, y, profile)) {
            runLen = 1; continue;
          }
          if (val === runVal) {
            runLen++;
          } else {
            if (runLen >= 5) score += (runLen - 2) * 10;
            runLen = 1;
            runVal = val;
          }
        }
        if (runLen >= 5) score += (runLen - 2) * 10;
      }

      for (let x = 0; x < N; x++) {
        let runLen = 1;
        let runVal = grid[x];
        for (let y = 1; y < N; y++) {
          const val = grid[y * N + x];
          if (isReservedCell(x, y, profile)) {
            runLen = 1; continue;
          }
          if (val === runVal) {
            runLen++;
          } else {
            if (runLen >= 5) score += (runLen - 2) * 10;
            runLen = 1;
            runVal = val;
          }
        }
        if (runLen >= 5) score += (runLen - 2) * 10;
      }

      // 2. 2x2同色ブロックペナルティ
      for (let y = 0; y < N - 1; y++) {
        for (let x = 0; x < N - 1; x++) {
          if (isReservedCell(x, y, profile) || isReservedCell(x + 1, y, profile) ||
              isReservedCell(x, y + 1, profile) || isReservedCell(x + 1, y + 1, profile)) {
            continue;
          }
          const v00 = grid[y * N + x];
          const v01 = grid[y * N + x + 1];
          const v10 = (y + 1) * N + x;
          const v11 = (y + 1) * N + x + 1;
          if (v00 === v01 && v00 === grid[v10] && v00 === grid[v11]) {
            score += 30;
          }
        }
      }

      return score;
    };

    let bestMask = 0;
    let minScore = Infinity;
    for (let m = 0; m < 8; m++) {
      const score = evaluateMask(m);
      if (score < minScore) {
        minScore = score;
        bestMask = m;
      }
    }

    // Header構成 (12 bytes)
    // magic: 0xC7 (新プロトコル・複数ブロック＆マスクあり) (1)
    // profileId: XS=0, S=1, M=2, L=3, XL=4 (上位4bitにbestMaskパターンを格納) (1)
    // chunkIndex: index (2)
    // totalChunks: chunks.length (2)
    // payloadLength: payloadBuffer.length (2)
    // payloadChecksum: crc32 (4)
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    view.setUint8(0, 0xC7); // New protocol version✨
    const pIdx = ["XS", "S", "M", "L", "XL"].indexOf(this.options.profileId);
    const secondByte = (pIdx >= 0 ? pIdx : 2) | (bestMask << 4);
    view.setUint8(1, secondByte);
    view.setUint16(2, index, false);
    view.setUint16(4, this.chunks.length, false);
    view.setUint16(6, payloadBuffer.length, false);
    const pCrc = payloadBuffer.length > 0 ? crc32(payloadBuffer) : 0;
    view.setUint32(8, pCrc, false);

    // ヘッダのRSエンコード (ヘッダ自体にはマスクをしない)
    const encodedHeader = this.rs.encode(header, 12);
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

    // 予約領域以外にデータセルを順番に配置してマスクをかける
    let dIdx = 0;
    const totalChunks = this.chunks.length;
    let seed = (index * 1000003 + totalChunks * 7) >>> 0;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % 8;
    };

    for (let y = 0; y < profile.size; y++) {
      for (let x = 0; x < profile.size; x++) {
        if (!isReservedCell(x, y, profile)) {
          let val = 7;
          if (dIdx < payload3bit.length) {
            val = payload3bit[dIdx];
          } else {
            val = nextRand();
          }
          // マスク適用！！
          drawCell(x, y, val ^ getColorGridMask(bestMask, x, y));
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
      
      if (this.forceChunkList !== null && this.forceChunkList.length > 0) {
        // 再送ローテーションモード！欠落パーツを順番に放流するよ！💥💖
        this.forceChunkListIndex = this.forceChunkListIndex % this.forceChunkList.length;
        this.currentChunkIndex = this.forceChunkList[this.forceChunkListIndex];
        this.forceChunkListIndex++;
      } else if (this.forceChunkIndex !== null) {
        // 特定の1チャンクに強制吸着！✨
        this.currentChunkIndex = this.forceChunkIndex;
        if (this.currentChunkIndex >= Math.max(1, this.chunks.length)) {
          this.currentChunkIndex = 0;
          this.forceChunkIndex = 0;
        }
      }

      const idx = this.currentChunkIndex;
      this.renderChunk(idx);
      if (this.onChunkChange) {
        this.onChunkChange(idx, this.chunks.length || 1);
      }
      
      if (this.forceChunkList === null && this.forceChunkIndex === null) {
        this.currentChunkIndex++;
        if (this.currentChunkIndex >= Math.max(1, this.chunks.length)) {
          this.currentChunkIndex = 0;
        }
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
