import { DecodeResult, DecodeDebugInfo, DecodedChunk, Point, GRID_PROFILES, GridProfileId } from "./types";
import { getPerspectiveTransform, perspectiveTransform, colorDistance } from "./math";
import { isReservedCell, getHeaderCellIndex, unpackFrom3Bit, PALETTE_RGB } from "./utils";
import { crc32 } from "./checksum";
import { ReedSolomon } from "./rs";

export class ColorGridDecoder {
  private rs = new ReedSolomon();
  private lastClockValue = -1;

  decodeFrame(imageData: ImageData): DecodeResult {
    const debug: DecodeDebugInfo = {};

    // 1. ファインダーパターンの候補を探す！
    const finderCenters = this.findFinders(imageData);
    debug.finderPoints = finderCenters;

    // 3点見つからなかったらその時点でダメぽ🥺
    if (finderCenters.length < 3) {
      const logs = (this as any).debugLogs ? (this as any).debugLogs.join(' | ') : 'none';
      return { ok: false, reason: `ファインダーが3点見つからないみ💦 (${finderCenters.length}個) Centers:${(this as any).debugCentersCount} Clusters:${(this as any).debugClustersCount}\nLogs: ${logs}`, debug };
    }

    // 2. クラスタリングして 左上(TL), 右上(TR), 左下(BL) を特定
    // 3点の中で最も距離が離れている2点（対角）がTRとBL、残りの1点がTLになるはず！
    let maxDist = 0;
    let trBlPair = [finderCenters[0], finderCenters[1]];
    let tlNode = finderCenters[2];
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const dist = Math.hypot(finderCenters[i].x - finderCenters[j].x, finderCenters[i].y - finderCenters[j].y);
        if (dist > maxDist) {
          maxDist = dist;
          trBlPair = [finderCenters[i], finderCenters[j]];
          tlNode = finderCenters.find(p => p !== finderCenters[i] && p !== finderCenters[j])!;
        }
      }
    }
    const TL = tlNode;
    let [TR, BL] = trBlPair;

    // TR と BL の向き合わせ: TL -> TR のベクトルと TL -> BL のベクトルの外積（2Dクロス積）を使う
    // Y軸が下向きの画面座標系では、TL->TRから見て時計回りにTL->BLがある場合、外積はプラスになる
    const crossProduct = (TR.x - TL.x) * (BL.y - TL.y) - (TR.y - TL.y) * (BL.x - TL.x);
    if (crossProduct < 0) {
      // 逆だったら入れ替える！
      const temp = TR; TR = BL; BL = temp;
    }

    // 右下(BR)は平行四辺形の性質で推測しちゃう！
    const BR: Point = { x: TR.x + BL.x - TL.x, y: TR.y + BL.y - TL.y };
    debug.corners = [TL, TR, BR, BL];

    const srcPoints = [TL, TR, BR, BL];
    
    // プロファイルの候補順に試していくよ！
    const candidateProfiles: GridProfileId[] = ["M", "L", "XL", "S", "XS"];

    const log: string[] = [];

    for (const pId of candidateProfiles) {
      const profile = GRID_PROFILES[pId];
      const N = profile.size;
      const F = profile.finderSize;
      
      // グリッド上のファインダー中心座標。ファインダーのサイズは7x7だから中心は3.5！
      const centerOff = F / 2;
      const dstPoints = [
        { x: centerOff, y: centerOff },
        { x: N - centerOff, y: centerOff },
        { x: N - centerOff, y: N - centerOff },
        { x: centerOff, y: N - centerOff },
      ];

      // 射影変換行列(ホモグラフィ)を求める！
      const mat = getPerspectiveTransform(dstPoints, srcPoints);
      if (!mat) continue;

      const pt0 = perspectiveTransform({x:0, y:0}, mat);
      const pt1 = perspectiveTransform({x:1, y:0}, mat);
      const cellWidth = Math.hypot(pt1.x - pt0.x, pt1.y - pt0.y);
      const sampleRadius = cellWidth < 8 ? 0 : 1;

      // 基準パレット(8色)の読み取り
      const readPalette: { r: number; g: number; b: number }[] = [];
      let paletteOk = true;
      for (let i = 0; i < 8; i++) {
        const pt = perspectiveTransform({ x: F + 1 + i + 0.5, y: 0.5 }, mat);
        const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
        if (!col) { paletteOk = false; break; }
        readPalette.push(col);
      }
      if (!paletteOk) {
        log.push(`${pId}: palette read failed`);
        continue;
      }

      // 同期クロック
      const clockPt = perspectiveTransform({ x: F + 1 + 0.5, y: 1.5 }, mat);
      const clockCol = this.sampleColor(imageData, clockPt.x, clockPt.y, sampleRadius);
      if (!clockCol) {
        log.push(`${pId}: clock read failed`);
        continue;
      }
      const clockVal = this.matchColor(clockCol, readPalette);
      debug.clockValue = clockVal;
      
      // クロックが前回と同じなら重複フレームとして無視して良い
      // if (clockVal === this.lastClockValue && clockVal !== -1) {
      //   return { ok: false, reason: "クロック同じだからスキップ！", debug };
      // }

      // ヘッダ領域の読み取り
      const headerLenPixels = profile.headerCellCount; // 64 cells -> 192 bits -> 24 bytes
      const headerRaw: number[] = new Array(headerLenPixels).fill(0);
      let headerOk = true;

      for (let y = 0; y < F; y++) {
        for (let x = F; x < N - F; x++) {
          const hIdx = getHeaderCellIndex(x, y, profile);
          if (hIdx !== -1) {
            const pt = perspectiveTransform({ x: x + 0.5, y: y + 0.5 }, mat);
            const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
            if (!col) { headerOk = false; break; }
            headerRaw[hIdx] = this.matchColor(col, readPalette);
          }
        }
      }
      if (!headerOk) {
        log.push(`${pId}: header cells out of bounds`);
        continue;
      }

      const headerBytesEnc = unpackFrom3Bit(new Uint8Array(headerRaw), 24);
      if (headerBytesEnc.length < 24) continue;

      // RSデコード (12 bytes data, 12 bytes parity)
      const headerBytes = this.rs.decode(headerBytesEnc, 12);
      if (!headerBytes) {
        log.push(`${pId}: header RS decode fail`);
        continue; // RSデコード失敗！
      }

      const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
      const magic = view.getUint8(0);
      if (magic !== 0xC6) {
        log.push(`${pId}: magic mismatch (${magic.toString(16)})`);
        continue; // "Magic" じゃないなら次！
      }

      // ヘッダが通ったらこのプロファイルでキマリ！✨
      debug.detectedProfileId = pId;
      debug.estimatedGridSize = profile.size;
      const pIdx = view.getUint8(1);
      const chunkIndex = view.getUint16(2, false);
      const totalChunks = view.getUint16(4, false);
      const payloadLength = view.getUint16(6, false);
      const payloadChecksum = view.getUint32(8, false);

      this.lastClockValue = clockVal;

      // ペイロード読み取り
      const payload3bit: number[] = [];
      const debugSampled: Point[] = [];
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (!isReservedCell(x, y, profile)) {
            const pt = perspectiveTransform({ x: x + 0.5, y: y + 0.5 }, mat);
            debugSampled.push(pt);
            const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
            if (col) {
              payload3bit.push(this.matchColor(col, readPalette));
            } else {
              payload3bit.push(0); // 取れなかったらとりあえず0
            }
          }
        }
      }
      debug.sampledCells = debugSampled;

      // ペイロードの計算（RS含み長）
      const totalPayloadBytes = payloadLength + Math.ceil(payloadLength * 0.25);
      const encodedPayload = unpackFrom3Bit(new Uint8Array(payload3bit), totalPayloadBytes);
      
      const payload = this.rs.decode(encodedPayload, Math.ceil(payloadLength * 0.25)) || new Uint8Array(0);

      const pCrc = (payload.length > 0) ? crc32(payload) : 0;
      debug.crcOk = (pCrc === payloadChecksum);

      if (!debug.crcOk) {
        return { ok: false, reason: "ペイロードのCRCが合わないみ🥺 映像がブレてるかも！", debug };
      }

      return {
        ok: true,
        chunk: {
          chunkIndex,
          totalChunks,
          payload,
          profileId: pId,
          gridSize: profile.size
        },
        debug
      };
    }

    (this as any).debugLogs = log;
    return { ok: false, reason: `全プロファイル試したけどヘッダ解読できなかった💦\nログ: ${log.join(" | ")}`, debug };
  }

  /**
   * ランレングス解析で 1:1:3:1:1 の比率を持つファインダーパターンを探すよ！
   * なんで 1:1:3:1:1 なの？🤔：
   * 黒(1)、白(1)、黒(3)、白(1)、黒(1) の長さにすると、斜めから見ても
   * 中央の黒が「全体の約3/7」を占める特徴が維持されるから！
   * これで画面中のどこにパターンがあるか一発で分かるんだよ✨
   */
  private findFinders(imageData: ImageData): Point[] {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    
    // 動的二値化のための平均輝度計算
    let sumLuma = 0;
    for (let i = 0; i < data.length; i += 4) {
      sumLuma += (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114);
    }
    const avgLuma = sumLuma / (width * height);
    // カメラの明るさに応じて適応的にしきい値を設定！
    const threshold = Math.max(50, Math.min(avgLuma * 0.9, 180));

    // R,G,Bの最大値で白黒判定するみ！
    // カラーセル（赤や青）は最大値が高いのでこれで除外できる✨
    const isBlack = (i: number) => {
      const r = data[i], g = data[i+1], b = data[i+2];
      const maxCol = Math.max(r, g, b);
      // Lumaの閾値を使うけど、最大値ベースで比較して色を無視する！
      return maxCol < threshold * 1.2;
    };

    const centers: Point[] = [];
    (this as any).debugLogs = [`Start w:${width} h:${height} Luma:${avgLuma.toFixed(1)} Th:${threshold.toFixed(1)}`];

    // 水平方向の走査（確実に見つけるために全行走査する！）
    const step = 1;
    for (let y = 0; y < height; y += step) {
      let stateCounts = [0, 0, 0, 0, 0];
      let currentState = 0; // 0:黒 1:白 ... 4:黒

      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const black = isBlack(i);

        // 最初の黒を見つけるまでは無視！
        if (currentState === 0 && stateCounts[0] === 0 && !black) {
          continue;
        }

        if ((currentState % 2 === 0 && black) || (currentState % 2 === 1 && !black)) {
          stateCounts[currentState]++;
        } else {
          if (currentState === 4) {
            // フルで埋まったら比率チェック！
            if ((this as any).debugLogs.length < 50) {
              (this as any).debugLogs.push(`y=${y},x=${x}: [${stateCounts.join(',')}]`);
            }
            if (this.checkRatio(stateCounts)) {
              // X中心を概算
              const center = x - Math.floor(stateCounts[4] + stateCounts[3] + stateCounts[2] / 2);
              const exactY = this.crossCheckVertical(imageData, center, y, stateCounts[2], isBlack);
              if (exactY !== null) {
                // 斜めチェックを1方向だけにするとかなくすとか。ここでは斜めチェックを緩く生かすか、とりあえず外す（もしくは非常に緩くする）。
                // カメラだと本当に厳しいので、元の仕様に戻しつつmaxVarianceを大きめにするだけでも十分かもしれない。
                centers.push({ x: center, y: exactY });
              }
              currentState = 0;
              stateCounts = [0, 0, 0, 0, 0];
            } else {
              // シフトして状態を継続する！
              stateCounts[0] = stateCounts[2];
              stateCounts[1] = stateCounts[3];
              stateCounts[2] = stateCounts[4];
              stateCounts[3] = 1;
              stateCounts[4] = 0;
              currentState = 3;
            }
          } else {
            currentState++;
            stateCounts[currentState] = 1;
          }
        }
      }
    }

    // 見つかった点の近くをまとめる（クラスタリング）
    const clusters: Point[][] = [];
    for (const pt of centers) {
      let found = false;
      for (const cluster of clusters) {
        // クラスタの直前の点との距離を見る
        const lastPt = cluster[cluster.length - 1];
        const dist = Math.hypot(pt.x - lastPt.x, pt.y - lastPt.y);
        // 同じファインダー内のピクセル群をまとめる
        if (dist < 80) {
          cluster.push(pt);
          found = true;
          break;
        }
      }
      if (!found) clusters.push([pt]);
    }

    // 点の数（クラスタの大きさ）が多い順にソート！
    // 本物のファインダーは縦にも長いので、何行もヒットして大量の点が集まる。
    // ゴミデータによる偶然の一致は数行しか続かないので弾ける！
    clusters.sort((a, b) => b.length - a.length);

    (this as any).debugCentersCount = centers.length;
    (this as any).debugClustersCount = clusters.length;

    const merged = clusters.slice(0, 3).map(cluster => {
      const sumX = cluster.reduce((a, b) => a + b.x, 0);
      const sumY = cluster.reduce((a, b) => a + b.y, 0);
      return { x: sumX / cluster.length, y: sumY / cluster.length };
    });

    // 上位3つを返す
    return merged;
  }

  private crossCheckVertical(
    imageData: ImageData,
    centerX: number,
    centerY: number,
    maxCount: number,
    isBlack: (i: number) => boolean
  ): number | null {
    const width = imageData.width;
    const height = imageData.height;
    
    // 垂直方向のカウント
    const vCounts = [0, 0, 0, 0, 0];
    
    // 1. centerY から上にスキャン
    let y = centerY;
    // まず中央の黒 (vCounts[2] の半分)
    while (y >= 0 && isBlack((y * width + centerX) * 4)) {
      vCounts[2]++;
      y--;
    }
    if (y < 0) return null;
    
    // 次に内側の白 (vCounts[1])
    while (y >= 0 && !isBlack((y * width + centerX) * 4)) {
      vCounts[1]++;
      y--;
    }
    if (y < 0 || vCounts[1] === 0) return null;
    
    // 次に外枠の黒 (vCounts[0])
    while (y >= 0 && isBlack((y * width + centerX) * 4)) {
      vCounts[0]++;
      y--;
    }
    if (vCounts[0] === 0) return null;
    
    const topY = y + 1; // 一番上の黒のY座標

    // 2. centerY + 1 から下にスキャン
    y = centerY + 1;
    // 中央の黒 (vCounts[2] のもう半分)
    while (y < height && isBlack((y * width + centerX) * 4)) {
      vCounts[2]++;
      y++;
    }
    if (y >= height) return null;
    
    // 内側の白 (vCounts[3])
    while (y < height && !isBlack((y * width + centerX) * 4)) {
      vCounts[3]++;
      y++;
    }
    if (y >= height || vCounts[3] === 0) return null;
    
    // 外枠の黒 (vCounts[4])
    while (y < height && isBlack((y * width + centerX) * 4)) {
      vCounts[4]++;
      y++;
    }
    if (vCounts[4] === 0) return null;
    
    const bottomY = y - 1; // 一番下の黒のY座標

    // 比率のチェック！
    const total = vCounts.reduce((a, b) => a + b, 0);
    // 水平のサイズと、垂直のサイズが著しく異なっている場合はファインダーではない（アスペクト比チェック）
    const hTotal = maxCount * 7 / 3; // 水平の推定トータル
    if (Math.abs(total - hTotal) > hTotal * 0.8) {
      return null;
    }
    
    if (this.checkRatio(vCounts)) {
      // 見つかった範囲の中心Yを返す！
      return topY + (bottomY - topY) / 2;
    }
    return null;
  }

  private crossCheckDiagonal(
    imageData: ImageData,
    centerX: number,
    centerY: number,
    maxCount: number,
    isBlack: (i: number) => boolean,
    dx: number,
    dy: number
  ): boolean {
    const width = imageData.width;
    const height = imageData.height;
    
    const vCounts = [0, 0, 0, 0, 0];
    
    let x = Math.floor(centerX);
    let y = Math.floor(centerY);
    
    // 1. 上(マイナス方向)へスキャン
    while (x >= 0 && y >= 0 && x < width && y < height && isBlack((y * width + x) * 4)) {
      vCounts[2]++;
      x -= dx;
      y -= dy;
    }
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    
    while (x >= 0 && y >= 0 && x < width && y < height && !isBlack((y * width + x) * 4)) {
      vCounts[1]++;
      x -= dx;
      y -= dy;
    }
    if (x < 0 || y < 0 || x >= width || y >= height || vCounts[1] === 0) return false;
    
    while (x >= 0 && y >= 0 && x < width && y < height && isBlack((y * width + x) * 4)) {
      vCounts[0]++;
      x -= dx;
      y -= dy;
    }
    if (vCounts[0] === 0) return false;
    
    // 2. 下(プラス方向)へスキャン
    x = Math.floor(centerX) + dx;
    y = Math.floor(centerY) + dy;
    
    while (x >= 0 && y >= 0 && x < width && y < height && isBlack((y * width + x) * 4)) {
      vCounts[2]++;
      x += dx;
      y += dy;
    }
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    
    while (x >= 0 && y >= 0 && x < width && y < height && !isBlack((y * width + x) * 4)) {
      vCounts[3]++;
      x += dx;
      y += dy;
    }
    if (x < 0 || y < 0 || x >= width || y >= height || vCounts[3] === 0) return false;
    
    while (x >= 0 && y >= 0 && x < width && y < height && isBlack((y * width + x) * 4)) {
      vCounts[4]++;
      x += dx;
      y += dy;
    }
    if (vCounts[4] === 0) return false;
    
    const total = vCounts.reduce((a, b) => a + b, 0);
    // 斜め方向は少し長いので、係数を大きめにとる
    const hTotal = maxCount * 7 / 3 * Math.SQRT2;
    if (Math.abs(total - hTotal) > hTotal * 0.8) {
      return false;
    }
    
    return this.checkRatio(vCounts);
  }

  // 1:1:3:1:1 の比率許容チェック (許容誤差100%くらいに緩める！)
  private checkRatio(counts: number[]): boolean {
    const total = counts.reduce((a, b) => a + b, 0);
    if (total < 7) return false;
    const moduleSize = total / 7;
    // ブレやすいカメラ映像のため、誤差許容をガッツリ広げる
    const maxVariance = moduleSize * 1.5;

    return Math.abs(moduleSize - counts[0]) < maxVariance &&
           Math.abs(moduleSize - counts[1]) < maxVariance &&
           Math.abs(3 * moduleSize - counts[2]) < maxVariance * 3 &&
           Math.abs(moduleSize - counts[3]) < maxVariance &&
           Math.abs(moduleSize - counts[4]) < maxVariance;
  }

  /**
   * 画像から色を吸い取るよ！
   * 1ピクセルだけだとノイズ入るから、中心の少し周りの平均(3x3)を取るのがミソ✨
   */
  private sampleColor(imageData: ImageData, x: number, y: number, sampleRadius: number = 1): { r: number, g: number, b: number } | null {
    const { width, height, data } = imageData;
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < sampleRadius || px >= width - sampleRadius || py < sampleRadius || py >= height - sampleRadius) return null;

    let tr = 0, tg = 0, tb = 0;
    let count = 0;
    for (let dy = -sampleRadius; dy <= sampleRadius; dy++) {
      for (let dx = -sampleRadius; dx <= sampleRadius; dx++) {
        const i = ((py + dy) * width + (px + dx)) * 4;
        tr += data[i]; tg += data[i + 1]; tb += data[i + 2];
        count++;
      }
    }
    return { r: tr / count, g: tg / count, b: tb / count };
  }

  /**
   * 吸い取った色が、基準パレットの8色のうちどれに一番近いか、距離で判定する！
   */
  private matchColor(col: { r: number, g: number, b: number }, palette: { r: number, g: number, b: number }[]): number {
    let minDist = Infinity;
    let minIdx = 0;
    for (let i = 0; i < 8; i++) {
        // 色のマッチングには数学部分で作ったユークリッド距離関数を使う！
        const dist = colorDistance(col.r, col.g, col.b, palette[i].r, palette[i].g, palette[i].b);
        if (dist < minDist) {
            minDist = dist;
            minIdx = i;
        }
    }
    return minIdx;
  }
}
