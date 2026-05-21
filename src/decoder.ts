import { DecodeResult, DecodeDebugInfo, DecodedChunk, Point, GRID_PROFILES, GridProfileId, PhaseLog } from "./types";
import { getPerspectiveTransform, perspectiveTransform, colorDistance } from "./math";
import { isReservedCell, getHeaderCellIndex, unpackFrom3Bit, PALETTE_RGB } from "./utils";
import { crc32 } from "./checksum";
import { ReedSolomon } from "./rs";

export class ColorGridDecoder {
  private rs = new ReedSolomon();
  private lastClockValue = -1;
  private lastSuccessProfileId: GridProfileId | null = null; // ✌️ 前フレームで大成功したプロファイルIDを覚えておくお！💖

  decodeFrame(imageData: ImageData): DecodeResult {
    const debug: DecodeDebugInfo = {};
    const phaseLogs: PhaseLog[] = [];

    // 1. ファインダーパターンの候補を探す！
    const finderStart = performance.now();
    const finderCenters = this.findFinders(imageData);
    const finderDuration = performance.now() - finderStart;
    debug.finderPoints = finderCenters;

    const finderDetail = `検出点数: ${finderCenters.length}, クラスタ数: ${(this as any).debugClustersCount}, 各中心座標: ${JSON.stringify(finderCenters)}`;

    // 3点見つからなかったらその時点でダメぽ🥺
    if (finderCenters.length < 3) {
      const logs = (this as any).debugLogs ? (this as any).debugLogs.join(' | ') : 'none';
      const finderLog: PhaseLog = {
        phase: "finder",
        ok: false,
        detail: finderDetail,
        durationMs: finderDuration
      };
      phaseLogs.push(finderLog);
      debug.phaseLogs = phaseLogs;

      return { 
        ok: false, 
        reason: `[finder] ${finderDetail}\nLogs: ${logs}`, 
        debug 
      };
    }

    const finderLog: PhaseLog = {
      phase: "finder",
      ok: true,
      detail: finderDetail,
      durationMs: finderDuration
    };
    phaseLogs.push(finderLog);

    // 2. クラスタリングして 左上(TL), 右上(TR), 左下(BL) を特定
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

    const crossProduct = (TR.x - TL.x) * (BL.y - TL.y) - (TR.y - TL.y) * (BL.x - TL.x);
    if (crossProduct < 0) {
      const temp = TR; TR = BL; BL = temp;
    }

    const BR: Point = { x: TR.x + BL.x - TL.x, y: TR.y + BL.y - TL.y };
    debug.corners = [TL, TR, BR, BL];

    const srcPoints = [TL, TR, BR, BL];
    
    const candidateProfiles: GridProfileId[] = ["M", "L", "XL", "S", "XS"];
    if (this.lastSuccessProfileId) {
      const idx = candidateProfiles.indexOf(this.lastSuccessProfileId);
      if (idx !== -1) {
        candidateProfiles.splice(idx, 1);
        candidateProfiles.unshift(this.lastSuccessProfileId); // 成功したやつを鬼速で先頭に持ってくるみ！✨
      }
    }

    const log: string[] = [];

    for (const pId of candidateProfiles) {
      const profile = GRID_PROFILES[pId];
      const N = profile.size;
      const F = profile.finderSize;
      
      const centerOff = F / 2;
      const dstPoints = [
        { x: centerOff, y: centerOff },
        { x: N - centerOff, y: centerOff },
        { x: N - centerOff, y: N - centerOff },
        { x: centerOff, y: N - centerOff },
      ];

      const homographyStart = performance.now();
      let mat = getPerspectiveTransform(dstPoints, srcPoints);
      const homographyDuration = performance.now() - homographyStart;

      if (!mat) {
        phaseLogs.push({
          phase: "homography",
          ok: false,
          detail: `[${pId}] ホモグラフィ変換行列(mat)の生成に失敗したみ🥺`,
          durationMs: homographyDuration
        });
        continue;
      }

      const pt0 = perspectiveTransform({x:0, y:0}, mat);
      const pt1 = perspectiveTransform({x:1, y:0}, mat);
      const cellWidth = Math.hypot(pt1.x - pt0.x, pt1.y - pt0.y);

      phaseLogs.push({
        phase: "homography",
        ok: true,
        detail: `[${pId}] 推定cellWidth: ${cellWidth.toFixed(2)}px`,
        durationMs: homographyDuration
      });

      // 📐 セルサイズに応じた超インテリジェンスな段階的サンプリング半径の動的判定お！💖
      let sampleRadius = 0;
      if (cellWidth < 6) {
        sampleRadius = 0;
      } else if (cellWidth <= 12) {
        sampleRadius = 1;
      } else {
        sampleRadius = 2;
      }
      // セル中央25%領域を超えないように鬼上限キャップをかけるよ！✨
      const maxRadius = Math.floor(cellWidth * 0.25);
      if (sampleRadius > maxRadius) {
        sampleRadius = maxRadius;
      }

      // AP(アライメントパターン)による補正
      const isIdealBlack = (dx: number, dy: number): boolean => {
        return (dx === 0 && dy === 0) || Math.max(Math.abs(dx), Math.abs(dy)) === 2;
      };

      const alignmentStart = performance.now();
      let bestShiftX = 0;
      let bestShiftY = 0;
      let maxContrast = -Infinity;

      for (let sy = -0.8; sy <= 0.8; sy += 0.05) {
        for (let sx = -0.8; sx <= 0.8; sx += 0.05) {
          let sumWhiteLuma = 0;
          let countWhite = 0;
          let sumBlackLuma = 0;
          let countBlack = 0;

          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const pt = perspectiveTransform({ x: N - 6 + sx + dx, y: N - 6 + sy + dy }, mat);
              const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
              if (!col) continue;

              // 彩度フィルタ：彩度(max-min)が60を超える場合はカラーセルとみなし、白黒カウントからスキップするみ！💖
              const maxCh = Math.max(col.r, col.g, col.b);
              const minCh = Math.min(col.r, col.g, col.b);
              if (maxCh - minCh > 60) {
                continue;
              }

              // 単純平均 (R+G+B)/3 を採用して純黒・純白の対称性を保つよお！✨
              const luma = (col.r + col.g + col.b) / 3;
              if (isIdealBlack(dx, dy)) {
                sumBlackLuma += luma;
                countBlack++;
              } else {
                sumWhiteLuma += luma;
                countWhite++;
              }
            }
          }

          if (countWhite > 0 && countBlack > 0) {
            const avgWhite = sumWhiteLuma / countWhite;
            const avgBlack = sumBlackLuma / countBlack;
            const contrast = avgWhite - avgBlack;
            if (contrast > maxContrast) {
              maxContrast = contrast;
              bestShiftX = sx;
              bestShiftY = sy;
            }
          }
        }
      }

      const alignmentDuration = performance.now() - alignmentStart;
      const contrastDiff = maxContrast - 12; // 閾値12との差
      const alignmentDetail = `[${pId}] maxContrast値: ${maxContrast === -Infinity ? "-Infinity" : maxContrast.toFixed(2)}, bestShift座標: (${bestShiftX.toFixed(2)}, ${bestShiftY.toFixed(2)}), 閾値12との差: ${maxContrast === -Infinity ? "N/A" : contrastDiff.toFixed(2)}`;

      if (maxContrast === -Infinity) {
        phaseLogs.push({
          phase: "alignment",
          ok: false,
          detail: `[${pId}] エラー。有効なAPコントラストが検出されなかったみ🥺 ` + alignmentDetail,
          durationMs: alignmentDuration
        });
        continue;
      } else {
        phaseLogs.push({
          phase: "alignment",
          ok: true,
          detail: alignmentDetail,
          durationMs: alignmentDuration
        });

        // コントラストが低い場合はフォールバックとして採用しつつ、warningログを出す仕様にするっしょ！✌️🔥
        if (maxContrast < 12) {
          log.push(`warning: AP contrast is low (${maxContrast.toFixed(2)}), using fallback best shift`);
        }
        const realAP = perspectiveTransform({ x: N - 6 + bestShiftX, y: N - 6 + bestShiftY }, mat);

        const dstPointsAP = [
          { x: centerOff, y: centerOff },
          { x: N - centerOff, y: centerOff },
          { x: N - 6, y: N - 6 },
          { x: centerOff, y: N - centerOff },
        ];

        const srcPointsAP = [
          TL,
          TR,
          realAP,
          BL,
        ];

        const matAP = getPerspectiveTransform(dstPointsAP, srcPointsAP);
        if (matAP) {
          mat = matAP;
        }
      }

      // 基準パレット(8色)の読み取り
      const paletteStart = performance.now();
      const readPalette: { r: number; g: number; b: number }[] = [];
      let paletteOk = true;
      for (let i = 0; i < 8; i++) {
        const pt = perspectiveTransform({ x: F + 1 + i + 0.5, y: 0.5 }, mat);
        const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
        if (!col) { paletteOk = false; break; }
        readPalette.push(col);
      }
      const paletteDuration = performance.now() - paletteStart;
      const paletteDetail = `[${pId}] 読み取った8色のRGB値: ${JSON.stringify(readPalette)}`;

      if (!paletteOk) {
        phaseLogs.push({
          phase: "palette",
          ok: false,
          detail: `[${pId}] 基準パレット(8色)の読み取りに失敗したみ🥺 ` + paletteDetail,
          durationMs: paletteDuration
        });
        log.push(`${pId}: palette read failed`);
        continue;
      } else {
        phaseLogs.push({
          phase: "palette",
          ok: true,
          detail: paletteDetail,
          durationMs: paletteDuration
        });
      }

      // 同期クロック
      const clockStart = performance.now();
      const clockPt = perspectiveTransform({ x: F + 1 + 0.5, y: 1.5 }, mat);
      const clockCol = this.sampleColor(imageData, clockPt.x, clockPt.y, sampleRadius);
      
      if (!clockCol) {
        const clockDuration = performance.now() - clockStart;
        phaseLogs.push({
          phase: "clock",
          ok: false,
          detail: `[${pId}] 同期クロックのカラーサンプリング（RGB=null）に失敗したみ🥺 lastClockValue: ${this.lastClockValue}`,
          durationMs: clockDuration
        });
        log.push(`${pId}: clock read failed`);
        continue;
      }

      const clockVal = this.matchColor(clockCol, readPalette);
      const clockDuration = performance.now() - clockStart;
      const clockDetail = `[${pId}] clockVal: ${clockVal}, lastClockValueとの比較: (本フレーム: ${clockVal}, 前フレーム: ${this.lastClockValue})`;

      if (clockVal === -1) {
        phaseLogs.push({
          phase: "clock",
          ok: false,
          detail: `[${pId}] 同期クロックが曖昧(-1)で判定しきれないみ🥺 ` + clockDetail,
          durationMs: clockDuration
        });
        log.push(`${pId}: clock read ambiguous (-1)`);
        continue;
      } else {
        phaseLogs.push({
          phase: "clock",
          ok: true,
          detail: clockDetail,
          durationMs: clockDuration
        });
      }
      debug.clockValue = clockVal;

      // ヘッダ領域の読み取り
      const headerRSStart = performance.now();
      const headerLenPixels = profile.headerCellCount;
      const headerRaw: number[] = new Array(headerLenPixels).fill(0);
      let headerOk = true;

      for (let y = 0; y < F; y++) {
        for (let x = F; x < N - F; x++) {
          const hIdx = getHeaderCellIndex(x, y, profile);
          if (hIdx !== -1) {
            const pt = perspectiveTransform({ x: x + 0.5, y: y + 0.5 }, mat);
            const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
            if (!col) { headerOk = false; break; }
            const mCol = this.matchColor(col, readPalette);
            if (mCol === -1) { headerOk = false; break; }
            headerRaw[hIdx] = mCol;
          }
        }
      }
      if (!headerOk) {
        const headerRSDuration = performance.now() - headerRSStart;
        phaseLogs.push({
          phase: "headerRS",
          ok: false,
          detail: `[${pId}] ヘッダセルの読み取りエラー（境界外または一致パレットなし）み🥺`,
          durationMs: headerRSDuration
        });
        log.push(`${pId}: header cells out of bounds`);
        continue;
      }

      const headerBytesEnc = unpackFrom3Bit(new Uint8Array(headerRaw), 24);
      if (headerBytesEnc.length < 24) {
        const headerRSDuration = performance.now() - headerRSStart;
        phaseLogs.push({
          phase: "headerRS",
          ok: false,
          detail: `[${pId}] ヘッダのビット展開後のバイト数が不足しているみ🥺 (${headerBytesEnc.length} bytes)`,
          durationMs: headerRSDuration
        });
        continue;
      }

      const headerBytes = this.rs.decode(headerBytesEnc, 12);
      const headerRSDuration = performance.now() - headerRSStart;

      if (!headerBytes) {
        phaseLogs.push({
          phase: "headerRS",
          ok: false,
          detail: `[${pId}] ヘッダのRSデコードに失敗したみ🥺`,
          durationMs: headerRSDuration
        });
        log.push(`${pId}: header RS decode fail`);
        continue;
      }

      let correctedBytes = 0;
      for (let i = 0; i < headerBytes.length; i++) {
        if (headerBytes[i] !== headerBytesEnc[i]) {
          correctedBytes++;
        }
      }

      const magicStart = performance.now();
      const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
      const magic = view.getUint8(0);
      const magicDuration = performance.now() - magicStart;

      phaseLogs.push({
        phase: "headerRS",
        ok: true,
        detail: `[${pId}] RSが訂正したバイト数: ${correctedBytes}, magic値（16進）: 0x${magic.toString(16).toUpperCase()}`,
        durationMs: headerRSDuration
      });

      if (magic !== 0xC6) {
        phaseLogs.push({
          phase: "magic",
          ok: false,
          detail: `[${pId}] Magicバイト不一致み🥺 期待値: 0xC6, 実測値: 0x${magic.toString(16).toUpperCase()}`,
          durationMs: magicDuration
        });
        log.push(`${pId}: magic mismatch (${magic.toString(16)})`);
        continue;
      } else {
        phaseLogs.push({
          phase: "magic",
          ok: true,
          detail: `[${pId}] Magicバイト一致お！(0x${magic.toString(16).toUpperCase()})`,
          durationMs: magicDuration
        });
      }

      debug.detectedProfileId = pId;
      debug.estimatedGridSize = profile.size;
      const pIdx = view.getUint8(1);
      const chunkIndex = view.getUint16(2, false);
      const totalChunks = view.getUint16(4, false);
      const payloadLength = view.getUint16(6, false);
      const payloadChecksum = view.getUint32(8, false);

      this.lastClockValue = clockVal;

      const payloadStart = performance.now();
      // 空きセルはエンコーダ側でシード既知の疑似乱数色で埋められているため
      // payloadLength を超えたセルは読み取らない（意図的）
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
              payload3bit.push(-1);
            }
          }
        }
      }
      debug.sampledCells = debugSampled;

      const totalPayloadBytes = payloadLength + Math.ceil(payloadLength * 0.25);
      const encodedPayload = unpackFrom3Bit(new Uint8Array(payload3bit), totalPayloadBytes);
      
      const payload = this.rs.decode(encodedPayload, Math.ceil(payloadLength * 0.25)) || new Uint8Array(0);

      const pCrc = (payload.length > 0) ? crc32(payload) : 0;
      debug.crcOk = (pCrc === payloadChecksum);
      const payloadDuration = performance.now() - payloadStart;

      const crcDetail = `[${pId}] 期待CRC値: 0x${payloadChecksum.toString(16).toUpperCase()}, 実測CRC値: 0x${pCrc.toString(16).toUpperCase()}`;

      if (!debug.crcOk) {
        phaseLogs.push({
          phase: "payloadCRC",
          ok: false,
          detail: `[${pId}] Payloal CRC不一致み🥺 ` + crcDetail,
          durationMs: payloadDuration
        });
        debug.phaseLogs = phaseLogs;
        const finalReason = phaseLogs
          .filter(p => !p.ok)
          .map(p => `[${p.phase}] ${p.detail}`)
          .join("\n");
        return {
          ok: false,
          reason: finalReason || "ペイロードのCRCが合わないみ🥺 映像がブレてるかも！",
          debug
        };
      } else {
        phaseLogs.push({
          phase: "payloadCRC",
          ok: true,
          detail: crcDetail,
          durationMs: payloadDuration
        });
      }

      const successStart = performance.now();
      this.lastSuccessProfileId = pId; // デコード大成功だからプロファイルIDを心と体に叩き込むよ！🔥
      const successDuration = performance.now() - successStart;

      phaseLogs.push({
        phase: "success",
        ok: true,
        detail: `[${pId}] デコード大成功！profileId: ${pId}, chunkIndex: ${chunkIndex}, totalChunks: ${totalChunks}`,
        durationMs: successDuration
      });

      debug.phaseLogs = phaseLogs;

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
    debug.phaseLogs = phaseLogs;
    const finalReason = phaseLogs
      .filter(p => !p.ok)
      .map(p => `[${p.phase}] ${p.detail}`)
      .join("\n");

    return { 
      ok: false, 
      reason: finalReason || `全プロファイル試したけどヘッダ解読できなかった💦\nログ: ${log.join(" | ")}`, 
      debug 
    };
  }

  private findFinders(imageData: ImageData): Point[] {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    
    // === 1. 8x8 ブロック適応閾値の事前生成 ===
    const REGION_SIZE = 8;
    const blockWidth = Math.ceil(width / REGION_SIZE);
    const blockHeight = Math.ceil(height / REGION_SIZE);
    
    const blockMin = new Float32Array(blockWidth * blockHeight);
    const blockMax = new Float32Array(blockWidth * blockHeight);
    const blockSum = new Float32Array(blockWidth * blockHeight);
    
    for (let by = 0; by < blockHeight; by++) {
      for (let bx = 0; bx < blockWidth; bx++) {
        const startX = bx * REGION_SIZE;
        const startY = by * REGION_SIZE;
        const endX = Math.min(startX + REGION_SIZE, width);
        const endY = Math.min(startY + REGION_SIZE, height);
        
        let cellMin = 255;
        let cellMax = 0;
        let cellSum = 0;
        let count = 0;
        
        for (let y = startY; y < endY; y++) {
          for (let x = startX; x < endX; x++) {
            const idx = (y * width + x) * 4;
            const r = data[idx];
            const g = data[idx+1];
            const b = data[idx+2];
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            
            if (luma < cellMin) cellMin = luma;
            if (luma > cellMax) cellMax = luma;
            cellSum += luma;
            count++;
          }
        }
        
        const bIdx = by * blockWidth + bx;
        blockMin[bIdx] = cellMin;
        blockMax[bIdx] = cellMax;
        blockSum[bIdx] = count > 0 ? (cellSum / count) : 0;
      }
    }
    
    const thresholds = new Float32Array(blockWidth * blockHeight);
    for (let by = 0; by < blockHeight; by++) {
      for (let bx = 0; bx < blockWidth; bx++) {
        let sum = 0;
        let count = 0;
        
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ny = by + dy;
            const nx = bx + dx;
            if (ny >= 0 && ny < blockHeight && nx >= 0 && nx < blockWidth) {
              const bIdx = ny * blockWidth + nx;
              const bMin = blockMin[bIdx];
              const bMax = blockMax[bIdx];
              
              if (bMax - bMin > 24) {
                sum += (bMin + bMax) / 2;
              } else {
                sum += blockSum[bIdx];
              }
              count++;
            }
          }
        }
        
        thresholds[by * blockWidth + bx] = count > 0 ? (sum / count) : 127;
      }
    }

    const isBlack = (i: number) => {
      const pixIdx = i / 4;
      const x = pixIdx % width;
      const y = Math.floor(pixIdx / width);
      const r = data[i], g = data[i+1], b = data[i+2];
      
      const bx = Math.floor(x / 8);
      const by = Math.floor(y / 8);
      const clampedX = Math.max(0, Math.min(blockWidth - 1, bx));
      const clampedY = Math.max(0, Math.min(blockHeight - 1, by));
      const th = thresholds[clampedY * blockWidth + clampedX];
      
      return r < th && g < th && b < th;
    };

    interface FinderCandidate extends Point {
      estimatedModuleSize: number;
    }

    const centers: FinderCandidate[] = [];
    (this as any).debugLogs = [`Start w:${width} h:${height} Adaptive Block bWidth:${blockWidth} bHeight:${blockHeight}`];

    const step = 1;
    for (let y = 0; y < height; y += step) {
      let stateCounts = [0, 0, 0, 0, 0];
      let currentState = 0;

      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        
        const r = data[i], g = data[i+1], b = data[i+2];
        const maxCh = Math.max(r, g, b);
        const minCh = Math.min(r, g, b);
        if (maxCh - minCh > 80) {
          currentState = 0;
          stateCounts = [0, 0, 0, 0, 0];
          continue;
        }

        const black = isBlack(i);

        if (currentState === 0 && stateCounts[0] === 0 && !black) {
          continue;
        }

        if ((currentState % 2 === 0 && black) || (currentState % 2 === 1 && !black)) {
          stateCounts[currentState]++;
        } else {
          if (currentState === 4) {
            if (this.checkRatio(stateCounts)) {
              const center = x - Math.floor(stateCounts[4] + stateCounts[3] + stateCounts[2] / 2);
              const exactY = this.crossCheckVertical(imageData, center, y, stateCounts[2], isBlack);
              if (exactY !== null) {
                const total = stateCounts.reduce((a, b) => a + b, 0);
                const moduleSize = total / 7;
                centers.push({ x: center, y: exactY, estimatedModuleSize: moduleSize });
              }
              currentState = 0;
              stateCounts = [0, 0, 0, 0, 0];
            } else {
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

    const clusters: FinderCandidate[][] = [];
    for (const pt of centers) {
      let found = false;
      for (const cluster of clusters) {
        // 1. クラスタ重心（平均座標）との距離で判定するよ！✨
        const sumX = cluster.reduce((a, b) => a + b.x, 0);
        const sumY = cluster.reduce((a, b) => a + b.y, 0);
        const avgX = sumX / cluster.length;
        const avgY = sumY / cluster.length;

        // 2. mergeRadiusを候補点から推定したモジュールサイズ基準で動的に計算！💖
        //    (推定モジュールサイズ × 7 × 0.6)
        const mergeRadius = pt.estimatedModuleSize * 7 * 0.6;
        const dist = Math.hypot(pt.x - avgX, pt.y - avgY);
        if (dist < mergeRadius) {
          cluster.push(pt);
          found = true;
          break;
        }
      }
      if (!found) clusters.push([pt]);
    }

    // 3. Y座標の分散（Variance）を計算するヘルパー！📸 横ブレノイズを徹底排除するよ！
    const getVarianceY = (cluster: FinderCandidate[]): number => {
      if (cluster.length <= 1) return 0;
      const sumY = cluster.reduce((sum, p) => sum + p.y, 0);
      const avgY = sumY / cluster.length;
      const sqDiffSum = cluster.reduce((sum, p) => sum + (p.y - avgY) ** 2, 0);
      return sqDiffSum / cluster.length;
    };

    // Y座標の分散が大きい順（縦の広がりが本物っぽい順）にソート！🥺✨
    clusters.sort((a, b) => {
      const varA = getVarianceY(a);
      const varB = getVarianceY(b);
      return varB - varA;
    });

    (this as any).debugCentersCount = centers.length;
    (this as any).debugClustersCount = clusters.length;

    const merged = clusters.slice(0, 3).map(cluster => {
      const sumX = cluster.reduce((a, b) => a + b.x, 0);
      const sumY = cluster.reduce((a, b) => a + b.y, 0);
      return { x: sumX / cluster.length, y: sumY / cluster.length };
    });

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
    const data = imageData.data;

    const isColor = (idx: number) => {
      const r = data[idx], g = data[idx+1], b = data[idx+2];
      return (Math.max(r, g, b) - Math.min(r, g, b)) > 80;
    };
    
    const vCounts = [0, 0, 0, 0, 0];
    
    let y = centerY;
    while (y >= 0) {
      const idx = (y * width + centerX) * 4;
      if (isColor(idx)) return null;
      if (isBlack(idx)) {
        vCounts[2]++;
        y--;
      } else {
        break;
      }
    }
    if (y < 0) return null;
    
    while (y >= 0) {
      const idx = (y * width + centerX) * 4;
      if (isColor(idx)) return null;
      if (!isBlack(idx)) {
        vCounts[1]++;
        y--;
      } else {
        break;
      }
    }
    if (y < 0 || vCounts[1] === 0) return null;
    
    while (y >= 0) {
      const idx = (y * width + centerX) * 4;
      if (isColor(idx)) return null;
      if (isBlack(idx)) {
        vCounts[0]++;
        y--;
      } else {
        break;
      }
    }
    if (vCounts[0] === 0) return null;
    
    const topY = y + 1;

    y = centerY + 1;
    while (y < height) {
      const idx = (y * width + centerX) * 4;
      if (isColor(idx)) return null;
      if (isBlack(idx)) {
        vCounts[2]++;
        y++;
      } else {
        break;
      }
    }
    if (y >= height) return null;
    
    while (y < height) {
      const idx = (y * width + centerX) * 4;
      if (isColor(idx)) return null;
      if (!isBlack(idx)) {
        vCounts[3]++;
        y++;
      } else {
        break;
      }
    }
    if (y >= height || vCounts[3] === 0) return null;
    
    while (y < height) {
      const idx = (y * width + centerX) * 4;
      if (isColor(idx)) return null;
      if (isBlack(idx)) {
        vCounts[4]++;
        y++;
      } else {
        break;
      }
    }
    if (vCounts[4] === 0) return null;
    
    const bottomY = y - 1;

    const total = vCounts.reduce((a, b) => a + b, 0);
    const hTotal = maxCount * 7 / 3;
    if (Math.abs(total - hTotal) > hTotal * 0.8) {
      return null;
    }
    
    if (this.checkRatio(vCounts)) {
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
    const data = imageData.data;

    const isColor = (idx: number) => {
      const r = data[idx], g = data[idx+1], b = data[idx+2];
      return (Math.max(r, g, b) - Math.min(r, g, b)) > 80;
    };
    
    const vCounts = [0, 0, 0, 0, 0];
    
    let x = Math.floor(centerX);
    let y = Math.floor(centerY);
    
    while (x >= 0 && y >= 0 && x < width && y < height) {
      const idx = (y * width + x) * 4;
      if (isColor(idx)) return false;
      if (isBlack(idx)) {
        vCounts[2]++;
        x -= dx;
        y -= dy;
      } else {
        break;
      }
    }
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    
    while (x >= 0 && y >= 0 && x < width && y < height) {
      const idx = (y * width + x) * 4;
      if (isColor(idx)) return false;
      if (!isBlack(idx)) {
        vCounts[1]++;
        x -= dx;
        y -= dy;
      } else {
        break;
      }
    }
    if (x < 0 || y < 0 || x >= width || y >= height || vCounts[1] === 0) return false;
    
    while (x >= 0 && y >= 0 && x < width && y < height) {
      const idx = (y * width + x) * 4;
      if (isColor(idx)) return false;
      if (isBlack(idx)) {
        vCounts[0]++;
        x -= dx;
        y -= dy;
      } else {
        break;
      }
    }
    if (vCounts[0] === 0) return false;
    
    x = Math.floor(centerX) + dx;
    y = Math.floor(centerY) + dy;
    
    while (x >= 0 && y >= 0 && x < width && y < height) {
      const idx = (y * width + x) * 4;
      if (isColor(idx)) return false;
      if (isBlack(idx)) {
        vCounts[2]++;
        x += dx;
        y += dy;
      } else {
        break;
      }
    }
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    
    while (x >= 0 && y >= 0 && x < width && y < height) {
      const idx = (y * width + x) * 4;
      if (isColor(idx)) return false;
      if (!isBlack(idx)) {
        vCounts[3]++;
        x += dx;
        y += dy;
      } else {
        break;
      }
    }
    if (x < 0 || y < 0 || x >= width || y >= height || vCounts[3] === 0) return false;
    
    while (x >= 0 && y >= 0 && x < width && y < height) {
      const idx = (y * width + x) * 4;
      if (isColor(idx)) return false;
      if (isBlack(idx)) {
        vCounts[4]++;
        x += dx;
        y += dy;
      } else {
        break;
      }
    }
    if (vCounts[4] === 0) return false;
    
    const total = vCounts.reduce((a, b) => a + b, 0);
    const hTotal = maxCount * 7 / 3 * Math.SQRT2;
    if (Math.abs(total - hTotal) > hTotal * 0.8) {
      return false;
    }
    
    return this.checkRatio(vCounts);
  }

  private checkRatio(counts: number[]): boolean {
    const total = counts.reduce((a, b) => a + b, 0);
    if (total < 7) return false;
    const moduleSize = total / 7;
    const maxVariance = moduleSize * 0.5;

    // 左右の非対称チェック（極端な非対称は偽陽性として弾く！）
    if (Math.abs(counts[0] - counts[4]) >= moduleSize * 0.5) {
      return false;
    }

    return Math.abs(moduleSize - counts[0]) < maxVariance &&
           Math.abs(moduleSize - counts[1]) < maxVariance &&
           Math.abs(3 * moduleSize - counts[2]) < maxVariance * 3 &&
           Math.abs(moduleSize - counts[3]) < maxVariance &&
           Math.abs(moduleSize - counts[4]) < maxVariance;
  }

  private sampleColor(imageData: ImageData, x: number, y: number, sampleRadius: number = 1): { r: number, g: number, b: number } | null {
    const { width, height, data } = imageData;
    const px = Math.round(x);
    const py = Math.round(y);
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

  private matchColor(col: { r: number, g: number, b: number }, palette: { r: number, g: number, b: number }[]): number {
    const thR = (palette[0].r + palette[4].r) / 2;
    const thG = (palette[0].g + palette[2].g) / 2;
    const thB = (palette[0].b + palette[1].b) / 2;

    if (Math.abs(col.r - thR) <= 30 || Math.abs(col.g - thG) <= 30 || Math.abs(col.b - thB) <= 30) {
      return -1;
    }

    const rBit = col.r > thR ? 4 : 0;
    const gBit = col.g > thG ? 2 : 0;
    const bBit = col.b > thB ? 1 : 0;

    return rBit | gBit | bBit;
  }
}
