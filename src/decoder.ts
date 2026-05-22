import { DecodeResult, DecodeDebugInfo, DecodedChunk, Point, GRID_PROFILES, GridProfileId, PhaseLog } from "./types";
import { getPerspectiveTransform, perspectiveTransform, colorDistance } from "./math";
import { isReservedCell, getHeaderCellIndex, unpackFrom3Bit, PALETTE_RGB } from "./utils";
import { crc32 } from "./checksum";
import { ReedSolomon } from "./rs";

export class ColorGridDecoder {
  private rs = new ReedSolomon();
  private lastClockValue = -1;
  private lastSuccessProfileId: GridProfileId | null = null; // ✌️ 前フレームで大成功したプロファイルIDを覚えておくお！💖
  private lastFinderCenters: Point[] | null = null;
  private voteBuffer: Map<string, number[]> = new Map();
  private voteProfileId: GridProfileId | null = null;
  private voteChunkIndex: number = -1;
  private ratioCheckLog: string = "";

  decodeFrame(imageData: ImageData): DecodeResult {
    const debug: DecodeDebugInfo = {};
    const phaseLogs: PhaseLog[] = [];

    // 1. ファインダーパターンの候補を探す！
    const finderStart = performance.now();
    const finderCenters = this.findFinders(imageData);

    let usedHint = false;
    if (finderCenters.length === 2 && this.lastFinderCenters && this.lastFinderCenters.length === 3) {
      const C0 = finderCenters[0];
      const C1 = finderCenters[1];
      let bestMatch0 = -1;
      let min0 = 50;
      let bestMatch1 = -1;
      let min1 = 50;

      for (let i = 0; i < 3; i++) {
        const pt = this.lastFinderCenters[i];
        const d0 = Math.hypot(pt.x - C0.x, pt.y - C0.y);
        const d1 = Math.hypot(pt.x - C1.x, pt.y - C1.y);
        if (d0 < min0) { min0 = d0; bestMatch0 = i; }
        if (d1 < min1) { min1 = d1; bestMatch1 = i; }
      }

      if (bestMatch0 !== -1 && bestMatch1 !== -1 && bestMatch0 !== bestMatch1) {
        for (let i = 0; i < 3; i++) {
          if (i !== bestMatch0 && i !== bestMatch1) {
            finderCenters.push({ ...this.lastFinderCenters[i] });
            usedHint = true;
            break;
          }
        }
      }
    }

    const finderDuration = performance.now() - finderStart;
    debug.finderPoints = finderCenters;

    phaseLogs.push({
      phase: "diagonal_check",
      ok: true,
      detail: "diagonal check: disabled",
      durationMs: 0
    });

    phaseLogs.push({
      phase: "ratio_check",
      ok: true,
      detail: this.ratioCheckLog,
      durationMs: 0
    });

    let finderDetail = `検出点数: ${finderCenters.length}, クラスタ数: ${(this as any).debugClustersCount}, 各中心座標: ${JSON.stringify(finderCenters)}`;
    if (usedHint) {
      finderDetail += " (used prev frame hint for 1 point)";
    }

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

    const filterTotal = (this as any).filterTotal ?? 0;
    const filterA = (this as any).filterA ?? 0;
    const filterB = (this as any).filterB ?? 0;
    const filterRemain = (this as any).filterRemain ?? 0;

    phaseLogs.push({
      phase: "cluster_filter",
      ok: filterRemain >= 3,
      detail: `cluster filter: total=${filterTotal}, condA=-${filterA}, condB=-${filterB}, remain=${filterRemain}`,
      durationMs: 0
    });

    // 2. 最も「直角かつ辺の長さが等しい」L字を形成する3点の組み合わせを全探索して特定！✨
    let bestScore = Infinity;
    let TL_candidate: Point | null = null;
    let TR_candidate: Point | null = null;
    let BL_candidate: Point | null = null;

    for (let i = 0; i < finderCenters.length; i++) {
      for (let j = i + 1; j < finderCenters.length; j++) {
        for (let k = j + 1; k < finderCenters.length; k++) {
          const pts = [finderCenters[i], finderCenters[j], finderCenters[k]];
          for (let ti = 0; ti < 3; ti++) {
            const pTL = pts[ti];
            const p1 = pts[(ti + 1) % 3];
            const p2 = pts[(ti + 2) % 3];

            const v1 = { x: p1.x - pTL.x, y: p1.y - pTL.y };
            const v2 = { x: p2.x - pTL.x, y: p2.y - pTL.y };

            const len1 = Math.hypot(v1.x, v1.y);
            const len2 = Math.hypot(v2.x, v2.y);
            if (len1 < 10 || len2 < 10) continue;

            const dot = v1.x * v2.x + v1.y * v2.y;
            const cosTheta = dot / (len1 * len2);
            const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
            
            // 直角からのズレ（ラジアン: 0〜0.5程度）
            const angleDiff = Math.abs(theta - Math.PI / 2);
            // 辺の長さの比のズレ（1.0を超える分: 0〜0.5程度）
            const lenRatio = Math.max(len1, len2) / Math.min(len1, len2);
            const lenDiff = lenRatio - 1.0;

            // スコア（低いほど理想的なL字）
            const score = angleDiff + lenDiff;

            if (score < bestScore) {
              bestScore = score;
              TL_candidate = pTL;
              
              // 外積 (v1.x * v2.y - v1.y * v2.x) が正になるようにTRとBLを配置！
              const cross = v1.x * v2.y - v1.y * v2.x;
              if (cross > 0) {
                TR_candidate = p1;
                BL_candidate = p2;
              } else {
                TR_candidate = p2;
                BL_candidate = p1;
              }
            }
          }
        }
      }
    }

    if (!TL_candidate || !TR_candidate || !BL_candidate) {
      return { ok: false, reason: "No valid L-shape found from finder centers", debug };
    }

    const TL = TL_candidate;
    let TR = TR_candidate;
    let BL = BL_candidate;

    this.lastFinderCenters = [TL, TR, BL];

    const BR: Point = { x: TR.x + BL.x - TL.x, y: TR.y + BL.y - TL.y };
    debug.corners = [TL, TR, BR, BL];

    // 距離と比率を計算するお！
    const width = imageData.width;
    const height = imageData.height;
    const distTR = Math.hypot(TR.x - TL.x, TR.y - TL.y);
    const distBL = Math.hypot(BL.x - TL.x, BL.y - TL.y);
    const ratio = distBL !== 0 ? distTR / distBL : 0;
    const ratioOk = ratio >= 0.5 && ratio <= 2.0;

    // 条件C：TL-TR距離とTL-BL距離がどちらも画像短辺の5%以上であること
    const minDim = Math.min(width, height);
    const distLimit = minDim * 0.05;
    const condCOk = distTR >= distLimit && distBL >= distLimit;

    // 条件D：3点が作る三角形の面積が画像面積の0.5%以上であること
    const area = Math.abs((TR.x - TL.x) * (BL.y - TL.y) - (TR.y - TL.y) * (BL.x - TL.x)) / 2;
    const imgArea = width * height;
    const areaRatio = imgArea > 0 ? (area / imgArea) : 0;
    const condDOk = areaRatio >= 0.005;

    const areaPercent = (areaRatio * 100).toFixed(2);
    const areaDetail = `triangle area: ${Math.round(area)}px² (image: ${imgArea}px²) ratio:${areaPercent}% ${condDOk ? "OK" : "TOO_SMALL"}`;
    phaseLogs.push({
      phase: "triangle_area",
      ok: condDOk,
      detail: areaDetail,
      durationMs: 0
    });

    const cx = (TL.x + TR.x + BL.x) / 3;
    const cy = (TL.y + TR.y + BL.y) / 3;
    const anglesStr = [TL, TR, BL].map((p, index) => {
      const p_angle = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI;
      return `P${index}(${p.x.toFixed(1)}, ${p.y.toFixed(1)}): ${p_angle.toFixed(1)}°`;
    }).join(", ");

    const ratioStatus = ratioOk ? "OK" : "WARNING (ratio out of range) ⚠️ [warning] 比率が範囲外み🥺";
    const detailLog = `angles: [${anglesStr}] | corners: TL(${TL.x.toFixed(1)},${TL.y.toFixed(1)}) TR(${TR.x.toFixed(1)},${TR.y.toFixed(1)}) BL(${BL.x.toFixed(1)},${BL.y.toFixed(1)}) | dist TR:${distTR.toFixed(1)}px BL:${distBL.toFixed(1)}px ratio:${ratio.toFixed(2)} ${ratioStatus}`;

    phaseLogs.push({
      phase: "finder_coords",
      ok: ratioOk && condCOk,
      detail: detailLog,
      durationMs: 0
    });

    const tlTrAngle = Math.atan2(TR.y - TL.y, TR.x - TL.x) * 180 / Math.PI;
    let rotationStr = "0°";
    if (tlTrAngle >= -45 && tlTrAngle < 45) {
      rotationStr = "0° (normal)";
    } else if (tlTrAngle >= 45 && tlTrAngle < 135) {
      rotationStr = "90° CW";
    } else if (tlTrAngle >= 135 || tlTrAngle < -135) {
      rotationStr = "180°";
    } else if (tlTrAngle >= -135 && tlTrAngle < -45) {
      rotationStr = "90° CCW";
    }

    if (tlTrAngle < -45 || tlTrAngle > 45) {
      phaseLogs.push({
        phase: "rotation_check",
        ok: true,
        detail: `rotation: TL→TR=${tlTrAngle.toFixed(1)}° → code rotated ${rotationStr} ⚠️`,
        durationMs: 0
      });
    }

    // 3点の妥当性チェックがNGなら、このフレームを直ちに諦める！💖
    if (!ratioOk || !condCOk || !condDOk) {
      let failReason = "3-point validation failed: ";
      if (!ratioOk) failReason += `ratio ${ratio.toFixed(2)} is out of range. `;
      if (!condCOk) failReason += `dist TR:${distTR.toFixed(1)} or BL:${distBL.toFixed(1)} is short (min: ${distLimit.toFixed(1)}). `;
      if (!condDOk) failReason += `triangle area is too small (${areaDetail}). `;

      debug.phaseLogs = phaseLogs;
      return {
        ok: false,
        reason: `[finder_validation] ${failReason}`,
        debug
      };
    }

    const srcPoints = [TL, TR, BR, BL];
    
    // ⏰ タイミングパターンからグリッドサイズを推定して候補順＆絞り込みをするよ！✨
    const timingStart = performance.now();
    let transitions = 0;
    let estimatedN = -1;
    let timingLogDetail = "";
    
    // 仮の N_temp (デフォルト M: 121, F: 7) で仮ホモグラフィ tempMat を生成！✨
    const N_temp = 121;
    const F_temp = 7;
    const centerOffTemp = F_temp / 2; // 3.5
    const dstPointsTemp = [
      { x: centerOffTemp, y: centerOffTemp },
      { x: N_temp - centerOffTemp, y: centerOffTemp },
      { x: N_temp - centerOffTemp, y: N_temp - centerOffTemp },
      { x: centerOffTemp, y: N_temp - centerOffTemp },
    ];
    
    const tempMat = getPerspectiveTransform(dstPointsTemp, srcPoints);

    if (tempMat) {
      // 水平タイミングライン（Y=6）を走査お！
      const lumaList: number[] = [];
      const step = 0.1;
      
      for (let x = F_temp; x <= N_temp - F_temp; x += step) {
        const pt = perspectiveTransform({ x: x, y: 6.5 }, tempMat);
        const col = this.sampleColor(imageData, pt.x, pt.y, 0); // 半径0
        if (col) {
          const luma = (col.r + col.g + col.b) / 3;
          lumaList.push(luma);
        }
      }

      if (lumaList.length > 5) {
        // ノイズ軽減のため窓サイズ5の移動平均！💖
        const smoothLuma: number[] = [];
        const windowSize = 5;
        const half = Math.floor(windowSize / 2);
        for (let i = 0; i < lumaList.length; i++) {
          let sum = 0;
          let count = 0;
          for (let w = -half; w <= half; w++) {
            const idx = i + w;
            if (idx >= 0 && idx < lumaList.length) {
              sum += lumaList[idx];
              count++;
            }
          }
          smoothLuma.push(sum / count);
        }

        let minLuma = Infinity;
        let maxLuma = -Infinity;
        for (const l of smoothLuma) {
          if (l < minLuma) minLuma = l;
          if (l > maxLuma) maxLuma = l;
        }

        // コントラストが一定以上ある場合のみカウントするみ！✨
        if (maxLuma - minLuma > 30) {
          const threshold = (minLuma + maxLuma) / 2;
          const diff = maxLuma - minLuma;
          const delta = diff * 0.15; // 15% のSchmitt Triggerヒステリシス
          const upper = threshold + delta;
          const lower = threshold - delta;

          let count = 0;
          let state: "white" | "black" | null = null;
          for (const l of smoothLuma) {
            if (state === null) {
              if (l > upper) state = "white";
              else if (l < lower) state = "black";
            } else if (state === "white" && l < lower) {
              state = "black";
              count++;
            } else if (state === "black" && l > upper) {
              state = "white";
              count++;
            }
          }
          transitions = count;
          // 反転点数 + 1 = ファインダー間のセル数
          estimatedN = (transitions + 1) + F_temp * 2; // +14セル
        }
      }
    }

    // デフォルトプロファイルリスト（前フレーム成功の優先付き）
    const baseCandidates: GridProfileId[] = ["M", "L", "XL", "S", "XS"];
    if (this.lastSuccessProfileId) {
      const idx = baseCandidates.indexOf(this.lastSuccessProfileId);
      if (idx !== -1) {
        baseCandidates.splice(idx, 1);
        baseCandidates.unshift(this.lastSuccessProfileId);
      }
    }

    let candidateProfiles: GridProfileId[] = [];

    // --- 新しい距離ベースフィルタ ---
    const spanPx = Math.hypot(TR.x - TL.x, TR.y - TL.y);
    const distanceFilteredProfiles: { pId: GridProfileId, cw: number }[] = [];
    for (const pId of baseCandidates) {
      const p = GRID_PROFILES[pId];
      const cw = spanPx / (p.size - p.finderSize);
      if (cw >= 2.0 && cw <= 10.0) {
        distanceFilteredProfiles.push({ pId, cw });
      }
    }

    distanceFilteredProfiles.sort((a, b) => {
      const fracA = Math.abs(a.cw - Math.round(a.cw));
      const fracB = Math.abs(b.cw - Math.round(b.cw));
      return fracA - fracB;
    });

    const distanceFallbackCandidates = distanceFilteredProfiles.length > 0
      ? distanceFilteredProfiles.map(i => i.pId)
      : [...baseCandidates];

    // --- 元のロジックと統合 ---
    let distanceUsedAsFallback = false;
    if (estimatedN !== -1) {
      // 推定Nとの差が±3以内のプロファイルのみ取り出すよ！✌️
      const matched = (Object.keys(GRID_PROFILES) as GridProfileId[]).filter(pId => {
        const size = GRID_PROFILES[pId].size;
        return Math.abs(size - estimatedN) <= 3;
      });

      if (matched.length > 0) {
        // 推定Nに最も近いプロファイルを1位にして並び替えるお！🚀
        matched.sort((a, b) => {
          const diffA = Math.abs(GRID_PROFILES[a].size - estimatedN);
          const diffB = Math.abs(GRID_PROFILES[b].size - estimatedN);
          return diffA - diffB;
        });
        candidateProfiles = matched;
        timingLogDetail = `timing: ${transitions}transitions, estimatedN=${estimatedN}, candidates=[${candidateProfiles.join(", ")}]`;
      } else {
        candidateProfiles = distanceFallbackCandidates;
        distanceUsedAsFallback = true;
      }
    } else {
      candidateProfiles = distanceFallbackCandidates;
      distanceUsedAsFallback = true;
    }

    if (distanceUsedAsFallback) {
      timingLogDetail = `timing: failed/fallback, distance fallback: candidates=[${candidateProfiles.join(", ")}]`;
    }

    phaseLogs.push({
      phase: "timing",
      ok: estimatedN !== -1,
      detail: timingLogDetail,
      durationMs: performance.now() - timingStart
    });

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
      
      let mat: number[] | null = null;
      let rotTryLogs: string[] = [];

      const co = centerOff;
      const dstVariants = [
        [{x:co,y:co},{x:N-co,y:co},{x:N-co,y:N-co},{x:co,y:N-co}],   // 0°
        [{x:co,y:N-co},{x:co,y:co},{x:N-co,y:co},{x:N-co,y:N-co}],   // 90°CW
        [{x:N-co,y:N-co},{x:co,y:N-co},{x:co,y:co},{x:N-co,y:co}],   // 180°
        [{x:N-co,y:co},{x:N-co,y:N-co},{x:co,y:N-co},{x:co,y:co}],   // 270°CW
      ];
      const srcPoints = [TL, TR, BR, BL];

      for (let rot = 0; rot < 4; rot++) {
        const tryDst = dstVariants[rot];

        const t_mat = getPerspectiveTransform(tryDst, srcPoints);
        if (!t_mat) continue;

        let maxColorDist = 0;
        let colorfulCount = 0;
        let blackCount = 0;
        const tempPalette: {r:number,g:number,b:number}[] = [];
        
        for (let i = 0; i < 8; i++) {
          const pt = perspectiveTransform({ x: F + 1 + i + 0.5, y: 0.5 }, t_mat);
          const col = this.sampleColor(imageData, pt.x, pt.y, 0); 
          if (col) tempPalette.push(col);
        }

        for (let i = 0; i < tempPalette.length; i++) {
           const c = tempPalette[i];
           if (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) > 60) colorfulCount++;
           if (c.r < 100 && c.g < 100 && c.b < 100) blackCount++;
           for (let j = i + 1; j < tempPalette.length; j++) {
              const d = colorDistance(
                 tempPalette[i].r, tempPalette[i].g, tempPalette[i].b,
                 tempPalette[j].r, tempPalette[j].g, tempPalette[j].b
              );
              if (d > maxColorDist) maxColorDist = d;
           }
        }

        const rotName = rot===0?"0°":rot===1?"90°CW":rot===2?"180°":"270°CW";
        const isValid = tempPalette.length >= 6 && maxColorDist > 150 && colorfulCount >= 3 && blackCount >= 1;
        rotTryLogs.push(`${rotName}→pal_dist=${Math.round(maxColorDist)}${isValid ? "✅" : "❌"}`);

        mat = t_mat;
        if (isValid) break;
      }

      const homographyDuration = performance.now() - homographyStart;

      phaseLogs.push({
        phase: "rotation_try",
        ok: true,
        detail: `[${pId}] rotation_try: ` + rotTryLogs.join(" "),
        durationMs: 0
      });

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

      if (cellWidth < 2.0) {
        phaseLogs.push({
          phase: "homography",
          ok: false,
          detail: `⚠️ cellWidth too small (${cellWidth.toFixed(2)}px), skip`,
          durationMs: homographyDuration
        });
        continue;
      }

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

      const calculateAPContrastAt = (sx: number, sy: number): number => {
        let sumWhiteLuma = 0;
        let countWhite = 0;
        let sumBlackLuma = 0;
        let countBlack = 0;

        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const pt = perspectiveTransform({ x: N - 6 + sx + dx, y: N - 6 + sy + dy }, mat);
            const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
            if (!col) continue;

            const maxCh = Math.max(col.r, col.g, col.b);
            const minCh = Math.min(col.r, col.g, col.b);
            if (maxCh - minCh > 60) {
              continue;
            }

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
          return (sumWhiteLuma / countWhite) - (sumBlackLuma / countBlack);
        }
        return -Infinity;
      };

      // 第1段階: ±2.0セル、0.2刻みで粗探索
      let coarseBestX = 0;
      let coarseBestY = 0;
      let coarseMaxContrast = -Infinity;

      for (let sy = -2.0; sy <= 2.0; sy += 0.2) {
        for (let sx = -2.0; sx <= 2.0; sx += 0.2) {
          const contrast = calculateAPContrastAt(sx, sy);
          if (contrast > coarseMaxContrast) {
            coarseMaxContrast = contrast;
            coarseBestX = sx;
            coarseBestY = sy;
          }
        }
      }

      // 第2段階: 第1段階の最大コントラスト点±0.3セル、0.05刻みで精探索
      let bestShiftX = coarseBestX;
      let bestShiftY = coarseBestY;
      let maxContrast = coarseMaxContrast;

      for (let sy = coarseBestY - 0.3; sy <= coarseBestY + 0.3; sy += 0.05) {
        for (let sx = coarseBestX - 0.3; sx <= coarseBestX + 0.3; sx += 0.05) {
          const contrast = calculateAPContrastAt(sx, sy);
          if (contrast > maxContrast) {
            maxContrast = contrast;
            bestShiftX = sx;
            bestShiftY = sy;
          }
        }
      }

      const alignmentDuration = performance.now() - alignmentStart;

      // 平行四辺形BRと実測APのズレをピクセルで計算！✨
      const paraBR = perspectiveTransform({ x: N - 6, y: N - 6 }, mat);
      const realAP = perspectiveTransform({ x: N - 6 + bestShiftX, y: N - 6 + bestShiftY }, mat);
      const shiftPx = Math.hypot(realAP.x - paraBR.x, realAP.y - paraBR.y);

      // ズレが20px以上の場合は警告
      const shiftWarning = shiftPx >= 20 ? "⚠️ " : "";
      const alignmentDetail = `[${pId}] ${shiftWarning}BR shift: ${shiftPx.toFixed(1)}px, contrast1: ${coarseMaxContrast === -Infinity ? "N/A" : coarseMaxContrast.toFixed(1)}, contrast2: ${maxContrast === -Infinity ? "N/A" : maxContrast.toFixed(1)}`;

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

        // コントラストが低い場合は警告ログを出す仕様にするっしょ！✌️🔥
        if (maxContrast < 12) {
          log.push(`warning: AP contrast is low (${maxContrast.toFixed(2)}), using fallback best shift`);
        }

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

      // 📐 タイミングパターンの非線形歪み補正エンジン！✨ (v1.6.0 異次元の精度向上！)
      const timingStart = performance.now();
      let timingSign = 1;
      let signSumForward = 0;
      let signSumReverse = 0;
      let timingTestCount = 0;

      // 事前の白黒極性 (正順 or 同期反転) の自動検知！💖
      for (let x = F + 1; x < N - F; x++) {
        const pt = perspectiveTransform({ x: x + 0.5, y: 6.5 }, mat);
        const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
        if (col) {
          const luma = (col.r + col.g + col.b) / 3;
          const expectedWhite = ((x + 6) % 2 !== 0);
          signSumForward += (expectedWhite ? 1 : -1) * (luma - 128);
          signSumReverse += (expectedWhite ? -1 : 1) * (luma - 128);
          timingTestCount++;
        }
      }
      for (let y = F + 1; y < N - F; y++) {
        const pt = perspectiveTransform({ x: 6.5, y: y + 0.5 }, mat);
        const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
        if (col) {
          const luma = (col.r + col.g + col.b) / 3;
          const expectedWhiteY = ((6 + y) % 2 !== 0);
          signSumForward += (expectedWhiteY ? 1 : -1) * (luma - 128);
          signSumReverse += (expectedWhiteY ? -1 : 1) * (luma - 128);
          timingTestCount++;
        }
      }
      timingSign = (signSumForward >= signSumReverse) ? 1 : -1;

      interface TimingOffset {
        v: number;
        dx: number;
        dy: number;
      }
      const horizontalOffsets: TimingOffset[] = [];
      const verticalOffsets: TimingOffset[] = [];
      let timingDetectedCount = 0;

      const sweepCell = (cx: number, cy: number, expectedWhite: boolean, dir: "H" | "V"): { dx: number, dy: number } | null => {
        let bestSx = 999;
        let bestSy = 999;
        let maxScore = -Infinity;
        const ptTheo = perspectiveTransform({ x: cx, y: cy }, mat);

        if (dir === "H") {
          const sy = 0;
          for (let sx = -0.5; sx <= 0.5; sx += 0.1) {
            const pt = perspectiveTransform({ x: cx + sx, y: cy + sy }, mat);
            const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
            if (!col) continue;
            const luma = (col.r + col.g + col.b) / 3;
            const score = (expectedWhite ? 1 : -1) * timingSign * luma;
            
            // 同値なら0（中心）に近い方を優先する吸着ロジック！✨
            const isBetter = (score > maxScore) || 
                             (score === maxScore && Math.abs(sx) < Math.abs(bestSx));
            if (isBetter) {
              maxScore = score;
              bestSx = sx;
              bestSy = sy;
            }
          }
        } else {
          const sx = 0;
          for (let sy = -0.5; sy <= 0.5; sy += 0.1) {
            const pt = perspectiveTransform({ x: cx + sx, y: cy + sy }, mat);
            const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
            if (!col) continue;
            const luma = (col.r + col.g + col.b) / 3;
            const score = (expectedWhite ? 1 : -1) * timingSign * luma;

            const isBetter = (score > maxScore) || 
                             (score === maxScore && Math.abs(sy) < Math.abs(bestSy));
            if (isBetter) {
              maxScore = score;
              bestSx = sx;
              bestSy = sy;
            }
          }
        }

        if (maxScore === -Infinity) return null;
        const ptMeas = perspectiveTransform({ x: cx + bestSx, y: cy + bestSy }, mat);
        return {
          dx: ptMeas.x - ptTheo.x,
          dy: ptMeas.y - ptTheo.y
        };
      };

      for (let x = F + 1; x < N - F; x++) {
        const expectedWhite = ((x + 6) % 2 !== 0);
        const res = sweepCell(x + 0.5, 6.5, expectedWhite, "H");
        if (res !== null) {
          horizontalOffsets.push({ v: x + 0.5, dx: res.dx, dy: res.dy });
          timingDetectedCount++;
        }
      }

      for (let y = F + 1; y < N - F; y++) {
        const expectedWhite = ((6 + y) % 2 !== 0);
        const res = sweepCell(6.5, y + 0.5, expectedWhite, "V");
        if (res !== null) {
          verticalOffsets.push({ v: y + 0.5, dx: res.dx, dy: res.dy });
          timingDetectedCount++;
        }
      }

      const timingCorrectionDuration = performance.now() - timingStart;
      const shouldApplyTimingCorrection = timingDetectedCount >= 5;

      if (!shouldApplyTimingCorrection) {
        phaseLogs.push({
          phase: "timingCorrection",
          ok: true,
          detail: `[${pId}] warning: タイミングパターンの検出点が5点未満のため非線形歪み補正をスキップみ🥺 (検出数: ${timingDetectedCount})`,
          durationMs: timingCorrectionDuration
        });
      } else {
        phaseLogs.push({
          phase: "timingCorrection",
          ok: true,
          detail: `[${pId}] 非線形歪み補正適用お！タイミングパターン検出点数: ${timingDetectedCount} (水平: ${horizontalOffsets.length}, 垂直: ${verticalOffsets.length})`,
          durationMs: timingCorrectionDuration
        });
      }

      const interpolateOffset = (offsets: TimingOffset[], target: number): { dx: number, dy: number } => {
        if (offsets.length === 0) return { dx: 0, dy: 0 };
        if (offsets.length === 1) return { dx: offsets[0].dx, dy: offsets[0].dy };

        offsets.sort((a, b) => a.v - b.v);

        if (target <= offsets[0].v) {
          return { dx: offsets[0].dx, dy: offsets[0].dy };
        }
        if (target >= offsets[offsets.length - 1].v) {
          return { dx: offsets[offsets.length - 1].dx, dy: offsets[offsets.length - 1].dy };
        }

        for (let i = 0; i < offsets.length - 1; i++) {
          const p1 = offsets[i];
          const p2 = offsets[i + 1];
          if (target >= p1.v && target <= p2.v) {
            const t = (target - p1.v) / (p2.v - p1.v);
            return {
              dx: p1.dx + t * (p2.dx - p1.dx),
              dy: p1.dy + t * (p2.dy - p1.dy)
            };
          }
        }
        return { dx: 0, dy: 0 };
      };

      const getCorrectedPt = (cx: number, cy: number): Point => {
        const ptTheo = perspectiveTransform({ x: cx, y: cy }, mat);
        if (!shouldApplyTimingCorrection) {
          return ptTheo;
        }
        const offH = interpolateOffset(horizontalOffsets, cx);
        const offV = interpolateOffset(verticalOffsets, cy);

        return {
          x: ptTheo.x + offH.dx + offV.dx,
          y: ptTheo.y + offH.dy + offV.dy
        };
      };

      // ------ タイミング再推定 (post-AP) ------
      const timingPostStart = performance.now();
      const lumaListPost: number[] = [];
      const stepPost = 0.1;

      for (let x = F; x <= N - F; x += stepPost) {
        const pt = getCorrectedPt(x, 6.5);
        const col = this.sampleColor(imageData, pt.x, pt.y, 0);
        if (col) {
          lumaListPost.push((col.r + col.g + col.b) / 3);
        }
      }

      let timingPostOk = false;
      let transitionsPost = 0;
      let estimatedNPost = -1;

      if (lumaListPost.length > 5) {
        const smoothLumaPost: number[] = [];
        const windowSizePost = 5;
        const halfPost = Math.floor(windowSizePost / 2);
        for(let i=0; i<lumaListPost.length; i++) {
           let sum=0, count=0;
           for(let w=-halfPost; w<=halfPost; w++) {
              const idx = i + w;
              if(idx >= 0 && idx < lumaListPost.length) { sum+=lumaListPost[idx]; count++; }
           }
           smoothLumaPost.push(sum/count);
        }
        let minLumaPost = Infinity, maxLumaPost = -Infinity;
        for(const v of smoothLumaPost) {
           if(v < minLumaPost) minLumaPost = v;
           if(v > maxLumaPost) maxLumaPost = v;
        }
        if (maxLumaPost - minLumaPost > 20) {
          const lower = minLumaPost + (maxLumaPost - minLumaPost) * 0.35;
          const upper = minLumaPost + (maxLumaPost - minLumaPost) * 0.65;
          let count = 0;
          let state: "white" | "black" = smoothLumaPost[0] > upper ? "white" : "black";
          for (let i = 1; i < smoothLumaPost.length; i++) {
            const l = smoothLumaPost[i];
            if (state === "white" && l < lower) {
              state = "black";
              count++;
            } else if (state === "black" && l > upper) {
              state = "white";
              count++;
            }
          }
          transitionsPost = count;
          estimatedNPost = (transitionsPost + 1) + F * 2;
        }
      }

      const postEvalLogs: string[] = [];
      const distTRpost = Math.hypot(TR.x - TL.x, TR.y - TL.y);
      const EVAL_N_TOLERANCE = 2;
      
      for (const t_pId of Object.keys(GRID_PROFILES) as GridProfileId[]) {
         const t_p = GRID_PROFILES[t_pId];
         const t_cw = distTRpost / (t_p.size - t_p.finderSize);
         let ok = false;
         if (t_cw >= 2.0 && t_cw <= 10.0 && estimatedNPost !== -1 && Math.abs(t_p.size - estimatedNPost) <= EVAL_N_TOLERANCE) {
            ok = true;
         }
         postEvalLogs.push(`${t_pId}:cw=${t_cw.toFixed(1)}${ok ? "✅" : "❌"}`);
         if (t_pId === pId && ok) {
            timingPostOk = true;
         }
      }

      phaseLogs.push({
        phase: "timing_post",
        ok: timingPostOk,
        detail: `timing post-AP: ${transitionsPost}transitions N=${estimatedNPost}\n  ` + postEvalLogs.join(" "),
        durationMs: performance.now() - timingPostStart
      });

      if (!timingPostOk && estimatedNPost !== -1) {
        log.push(`${pId}: post-AP timing check failed`);
        continue;
      }
      // ------ タイミング再推定 ここまで ------

      // 基準パレット(8色)の読み取り
      const paletteStart = performance.now();
      const readPalette: { r: number; g: number; b: number }[] = [];
      let paletteOk = true;
      const paletteLogs: string[] = [];
      const palettePosLogs: string[] = [];

      for (let i = 0; i < 8; i++) {
        const x_center = F + 1 + i;
        const centerPt = getCorrectedPt(x_center + 0.5, 0.5);
        palettePosLogs.push(`[${i}](${centerPt.x.toFixed(1)},${centerPt.y.toFixed(1)})`);

        let pts = [
          { x: x_center + 0.5, y: 0.5 }, // 中心
          { x: x_center + 0.3, y: 0.3 }, // 左上
          { x: x_center + 0.7, y: 0.3 }, // 右上
          { x: x_center + 0.3, y: 0.7 }, // 左下
          { x: x_center + 0.7, y: 0.7 }  // 右下
        ];

        let currentSampleRadius = sampleRadius;
        if (cellWidth < 4.0) {
          pts = [{ x: x_center + 0.5, y: 0.5 }];
          currentSampleRadius = 0;
        }

        const validCols: { r: number; g: number; b: number }[] = [];
        for (const p of pts) {
          const pt = getCorrectedPt(p.x, p.y);
          const col = this.sampleColor(imageData, pt.x, pt.y, currentSampleRadius);
          if (col) {
            validCols.push(col);
          }
        }

        if (validCols.length < (pts.length >= 3 ? 3 : 1)) {
          paletteOk = false;
          paletteLogs.push(`palette[${i}] sampling failed (too few points: ${validCols.length}/${pts.length})`);
          break;
        }

        // R/G/B 各チャンネルを独立して中央値を計算する
        const getChannelMedian = (vals: number[]): number => {
          vals.sort((a, b) => a - b);
          return vals[Math.floor(vals.length / 2)];
        };

        const finalCol = {
          r: getChannelMedian(validCols.map(c => c.r)),
          g: getChannelMedian(validCols.map(c => c.g)),
          b: getChannelMedian(validCols.map(c => c.b))
        };
        readPalette.push(finalCol);

        // 5点間の最大距離（ばらつき指標、spread）を計算
        let maxSpread = 0;
        for (let j = 0; j < validCols.length; j++) {
          for (let k = j + 1; k < validCols.length; k++) {
            const dist = colorDistance(validCols[j].r, validCols[j].g, validCols[j].b, validCols[k].r, validCols[k].g, validCols[k].b);
            if (dist > maxSpread) {
              maxSpread = dist;
            }
          }
        }

        let logStr = `[${i}] rgb(${Math.round(finalCol.r)},${Math.round(finalCol.g)},${Math.round(finalCol.b)})`;
        if (maxSpread > 50) {
          logStr += ` (spread:${Math.round(maxSpread)})`;
        }
        paletteLogs.push(logStr);
      }

      let maxPaletteColorDist = 0;
      let colorfulCount = 0;
      for (let i = 0; i < readPalette.length; i++) {
        const c = readPalette[i];
        if (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) >= 30) {
           colorfulCount++;
        }
        for (let j = i + 1; j < readPalette.length; j++) {
           const dist = colorDistance(readPalette[i].r, readPalette[i].g, readPalette[i].b, readPalette[j].r, readPalette[j].g, readPalette[j].b);
           if (dist > maxPaletteColorDist) maxPaletteColorDist = dist;
        }
      }

      const pLeft = getCorrectedPt(F + 1.5, 0.5);
      const pRight = getCorrectedPt(F + 8.5, 0.5);
      const paletteRangeLog = `palette row expected: (${pLeft.x.toFixed(1)},${pLeft.y.toFixed(1)})→(${pRight.x.toFixed(1)},${pRight.y.toFixed(1)})`;

      const paletteDuration = performance.now() - paletteStart;
      let paletteDetail = `[${pId}] パレット読み取り結果:\npalette pos: ${palettePosLogs.join(" ")}\n${paletteRangeLog}\n` + paletteLogs.join(", ");

      if (colorfulCount < 3) {
         paletteDetail += `\n⚠️ palette has only ${colorfulCount} colorful cells`;
         paletteOk = false;
      }
      if (maxPaletteColorDist < 50) {
        paletteDetail += `\n⚠️ 全色が同一領域の可能性 (max color dist: ${Math.round(maxPaletteColorDist)})`;
        paletteOk = false;
      }

      if (!paletteOk) {
        phaseLogs.push({
          phase: "palette",
          ok: false,
          detail: `[${pId}] 基準パレット(8色)の読み取りに失敗したみ🥺\n` + paletteDetail,
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

      // 同期クロック（v1.5.0からは、曖昧・失敗してもデコード続行する超高可用性フォールバック仕様！）
      const clockStart = performance.now();
      const clockPt = getCorrectedPt(F + 1 + 0.5, 1.5);
      const clockCol = this.sampleColor(imageData, clockPt.x, clockPt.y, sampleRadius);
      
      let clockVal = 0;
      const clockDuration = performance.now() - clockStart;
      
      if (!clockCol) {
        phaseLogs.push({
          phase: "clock",
          ok: true, // 警告扱いにするのでフェーズはok(true)にしてデコードを絶対に落とさない！✨
          detail: `[${pId}] warning: 同期クロックのカラーサンプリング（RGB=null）失敗み🥺（デフォルト色0でフォールバックして続行！）`,
          durationMs: clockDuration
        });
        log.push(`${pId}: clock read failed (fallback logic engaged)`);
      } else {
        const measuredClockVal = this.matchColor(clockCol, readPalette);
        const clockDetail = `[${pId}] clockVal: ${measuredClockVal}, lastClockValueとの比較: (本フレーム: ${measuredClockVal}, 前フレーム: ${this.lastClockValue})`;

        if (measuredClockVal === -1) {
          phaseLogs.push({
            phase: "clock",
            ok: true, // 曖昧でもエラーとしてコケるのを完封するため、デコードは落とさず進む💖
            detail: `[${pId}] warning: 同期クロックが曖昧(-1)み🥺（安全フォールバックでデコード続行！） ` + clockDetail,
            durationMs: clockDuration
          });
          log.push(`${pId}: clock read ambiguous (fallback logic engaged)`);
          clockVal = 0; // 曖昧な場合は安全なデフォルト値をセット！
        } else {
          phaseLogs.push({
            phase: "clock",
            ok: true,
            detail: clockDetail,
            durationMs: clockDuration
          });
          clockVal = measuredClockVal;
        }
      }
      debug.clockValue = clockVal;

      // ヘッダ領域の読み取り
      const headerRSStart = performance.now();
      const headerLenPixels = profile.headerCellCount;
      const headerRaw: number[] = new Array(headerLenPixels).fill(0);
      let headerOk = true;
      const headerLogs: string[] = [];
      const headerIndexLogs: string[] = [];

      for (let y = 0; y < F; y++) {
        for (let x = F; x < N - F; x++) {
          const hIdx = getHeaderCellIndex(x, y, profile);
          if (hIdx !== -1) {
            if (hIdx < 10) {
               headerIndexLogs.push(`headerCell[${hIdx}]: grid(${x},${y}) → gridIdx=${hIdx}`);
            }
            const pt = getCorrectedPt(x + 0.5, y + 0.5);
            const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
            if (!col) { headerOk = false; break; }

            const mCol = this.matchColor(col, readPalette);
            if (hIdx < 5) {
                let logStr = `header[${hIdx}] pos(${pt.x.toFixed(1)},${pt.y.toFixed(1)}) rgb(${col.r},${col.g},${col.b}) → matchColor=${mCol}`;
                if (hIdx < 3) {
                     const distsStr = readPalette.map((pc, pIdx) => {
                         const dist = Math.round(colorDistance(col.r, col.g, col.b, pc.r, pc.g, pc.b));
                         return `dist to palette[${pIdx}](${pc.r},${pc.g},${pc.b})=${dist}`;
                     }).join(" ");
                     logStr += `\n  ${distsStr}`;
                }
                headerLogs.push(logStr);
            }

            if (mCol === -1) { headerOk = false; break; }
            headerRaw[hIdx] = mCol;
          }
        }
      }

      const headerRawStr = `headerRaw: ${headerRaw.join(",")}\n${headerIndexLogs.join("\n")}\n${headerLogs.join("\n")}`;

      if (!headerOk) {
        const headerRSDuration = performance.now() - headerRSStart;
        phaseLogs.push({
          phase: "headerRS",
          ok: false,
          detail: `[${pId}] ヘッダセルの読み取りエラー（境界外または一致パレットなし）み🥺\n${headerRawStr}`,
          durationMs: headerRSDuration
        });
        log.push(`${pId}: header cells out of bounds`);
        continue;
      }

      const headerBytesEnc = unpackFrom3Bit(new Uint8Array(headerRaw), 24);
      const toHex = (arr: Uint8Array) => Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join(" ");
      const headerEncStr = `headerEnc: ${toHex(headerBytesEnc)}`;

      if (headerBytesEnc.length < 24) {
        const headerRSDuration = performance.now() - headerRSStart;
        phaseLogs.push({
          phase: "headerRS",
          ok: false,
          detail: `[${pId}] ヘッダのビット展開後のバイト数が不足しているみ🥺 (${headerBytesEnc.length} bytes)\n${headerRawStr}\n${headerEncStr}`,
          durationMs: headerRSDuration
        });
        continue;
      }

      const headerBytes = this.rs.decode(headerBytesEnc, 12);
      const headerRSDuration = performance.now() - headerRSStart;

      if (!headerBytes) {
        const dataPartLog = `headerEnc (データ部先頭12バイト): ${toHex(headerBytesEnc.slice(0, 12))}`;
        const parityPartLog = `headerEnc (パリティ部末尾12バイト): ${toHex(headerBytesEnc.slice(12, 24))}`;
        
        phaseLogs.push({
          phase: "headerRS",
          ok: false,
          detail: `[${pId}] ヘッダのRSデコードに失敗したみ🥺\n${headerRawStr}\n${headerEncStr}\n${dataPartLog}\n${parityPartLog}`,
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
        detail: `[${pId}] RSが訂正したバイト数: ${correctedBytes}, magic値（16進）: 0x${magic.toString(16).toUpperCase()}\n${headerRawStr}\n${headerEncStr}`,
        durationMs: headerRSDuration
      });

      if (magic !== 0xC6) {
        phaseLogs.push({
          phase: "magic",
          ok: false,
          detail: `[${pId}] Magicバイト不一致み🥺 magic: expected=0xC6 actual=0x${magic.toString(16).toUpperCase()}\n${headerRawStr}\n${headerEncStr}`,
          durationMs: magicDuration
        });
        log.push(`${pId}: magic mismatch (${magic.toString(16)})`);
        continue;
      } else {
        phaseLogs.push({
          phase: "magic",
          ok: true,
          detail: `[${pId}] Magicバイト一致お！ magic: expected=0xC6 actual=0x${magic.toString(16).toUpperCase()}`,
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
      // ペイロード読み取り＆複数フレームの色判定多数決統合システム！✨ (v1.6.0)
      if (this.voteChunkIndex !== chunkIndex) {
        this.voteBuffer.clear();
        this.voteChunkIndex = chunkIndex;
        this.voteProfileId = null;
      }

      const shouldPushVoteBuffer = (this.voteProfileId === null || this.voteProfileId === pId);
      this.voteProfileId = pId;

      const payload3bit: number[] = [];
      const debugSampled: Point[] = [];
      let voteAppliedCount = 0;
      let uncertainCount = 0;
      let totalHistoryLength = 0;

      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (!isReservedCell(x, y, profile)) {
            const pt = getCorrectedPt(x + 0.5, y + 0.5);
            debugSampled.push(pt);
            
            const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
            const currentVal = col ? this.matchColor(col, readPalette) : -1;

            const key = `${x},${y}`;
            let history = this.voteBuffer.get(key);
            if (!history) {
              history = [];
              this.voteBuffer.set(key, history);
            }
            if (shouldPushVoteBuffer) {
              history.push(currentVal);
              if (history.length > 5) {
                history.shift();
              }
            }
            totalHistoryLength = Math.max(totalHistoryLength, history.length);

            let finalVal = currentVal;
            if (history.length >= 2) {
              const counts: { [key: number]: number } = {};
              let validCount = 0;
              for (const val of history) {
                if (val !== -1) {
                  counts[val] = (counts[val] || 0) + 1;
                  validCount++;
                }
              }

              if (validCount > 0) {
                let maxVal = -1;
                let maxCount = 0;
                for (const k in counts) {
                  const valNum = Number(k);
                  if (counts[valNum] > maxCount) {
                    maxCount = counts[valNum];
                    maxVal = valNum;
                  }
                }

                // 最頻値が過半数（有効な投票総数の半分より多い場合）を満たすかチェック！✨
                if (maxCount * 2 > validCount) {
                  finalVal = maxVal;
                  if (finalVal !== -1) {
                    voteAppliedCount++;
                  } else {
                    uncertainCount++;
                  }
                } else {
                  finalVal = -1;
                  uncertainCount++;
                }
              } else {
                finalVal = -1;
                uncertainCount++;
              }
            } else {
              // 2フレーム未満なら多数決せずにそのまま生値を採用
              if (finalVal === -1) {
                uncertainCount++;
              }
            }
            payload3bit.push(finalVal);
          }
        }
      }

      debug.sampledCells = debugSampled;

      const payloadDuration = performance.now() - payloadStart;

      // 多数決統合の実行状況を診断 phaseLogs にお茶目に刻み込む！💖
      if (totalHistoryLength >= 2) {
        phaseLogs.push({
          phase: "payloadVote",
          ok: true,
          detail: `[${pId}] vote: ${voteAppliedCount}cells applied, ${uncertainCount}cells uncertain→RS`,
          durationMs: payloadDuration
        });
      } else {
        phaseLogs.push({
          phase: "payloadVote",
          ok: true,
          detail: `[${pId}] vote: buffering frames (${totalHistoryLength}/2)`,
          durationMs: payloadDuration
        });
      }

      const totalPayloadBytes = payloadLength + Math.ceil(payloadLength * 0.25);
      const encodedPayload = unpackFrom3Bit(new Uint8Array(payload3bit), totalPayloadBytes);
      
      const payloadDecStart = performance.now();
      const payload = this.rs.decode(encodedPayload, Math.ceil(payloadLength * 0.25)) || new Uint8Array(0);
      const payloadDecDuration = performance.now() - payloadDecStart;

      const pCrc = (payload.length > 0) ? crc32(payload) : 0;
      debug.crcOk = (pCrc === payloadChecksum);

      const crcDetail = `[${pId}] 期待CRC値: 0x${payloadChecksum.toString(16).toUpperCase()}, 実測CRC値: 0x${pCrc.toString(16).toUpperCase()}`;

      if (!debug.crcOk) {
        if (totalHistoryLength < 2) {
          const warningDetail = `CRC failed: vote buffer=${totalHistoryLength}/2frames, retry after more frames`;
          phaseLogs.push({
            phase: "payloadCRC",
            ok: true,
            detail: `[${pId}] ${warningDetail}\n` + crcDetail,
            durationMs: payloadDuration
          });
          debug.phaseLogs = phaseLogs;
          return {
            ok: false,
            reason: warningDetail,
            debug
          };
        } else {
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
        }
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
    
    // === 1. 32x32 ブロック適応閾値の事前生成 ===
    const REGION_SIZE = 32;
    const blockWidth = Math.ceil(width / REGION_SIZE);
    const blockHeight = Math.ceil(height / REGION_SIZE);
    
    const blockMin = new Float32Array(blockWidth * blockHeight);
    const blockMax = new Float32Array(blockWidth * blockHeight);
    
    for (let by = 0; by < blockHeight; by++) {
      for (let bx = 0; bx < blockWidth; bx++) {
        const startX = bx * REGION_SIZE;
        const startY = by * REGION_SIZE;
        const endX = Math.min(startX + REGION_SIZE, width);
        const endY = Math.min(startY + REGION_SIZE, height);
        
        let cellMin = 255;
        let cellMax = 0;
        
        for (let y = startY; y < endY; y++) {
          for (let x = startX; x < endX; x++) {
            const idx = (y * width + x) * 4;
            const r = data[idx];
            const g = data[idx+1];
            const b = data[idx+2];
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            
            if (luma < cellMin) cellMin = luma;
            if (luma > cellMax) cellMax = luma;
          }
        }
        
        const bIdx = by * blockWidth + bx;
        blockMin[bIdx] = cellMin;
        blockMax[bIdx] = cellMax;
      }
    }
    
    const isBlack = (i: number) => {
      const pixIdx = i / 4;
      const x = pixIdx % width;
      const y = Math.floor(pixIdx / width);
      
      const bx = Math.floor(x / REGION_SIZE);
      const by = Math.floor(y / REGION_SIZE);
      const clampedX = Math.max(0, Math.min(blockWidth - 1, bx));
      const clampedY = Math.max(0, Math.min(blockHeight - 1, by));
      const bIdx = clampedY * blockWidth + clampedX;
      
      const bMin = blockMin[bIdx];
      const bMax = blockMax[bIdx];
      
      let th = 0;
      if (bMax - bMin < 24) {
        if (bMax < 128) {
          th = bMax + 10;
        } else {
          th = bMin / 2;
        }
      } else {
        th = (bMin + bMax) / 2;
      }
      
      const r = data[i], g = data[i+1], b = data[i+2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      
      return luma < th;
    };

    interface FinderCandidate extends Point {
      estimatedModuleSize: number;
    }

    const getVarianceY = (cluster: FinderCandidate[]): number => {
      if (cluster.length <= 1) return 0;
      const sumY = cluster.reduce((sum, p) => sum + p.y, 0);
      const avgY = sumY / cluster.length;
      const sqDiffSum = cluster.reduce((sum, p) => sum + (p.y - avgY) ** 2, 0);
      return sqDiffSum / cluster.length;
    };

    const levels = [
      { name: "lv1 (factor 0.65)", factor: 0.65, label: "lv1" },
      { name: "lv2 (factor 0.85)", factor: 0.85, label: "lv2" },
    ];

    let levelResultsStr = "";
    let finalCenters: FinderCandidate[] = [];
    let finalClusters: FinderCandidate[][] = [];
    let adoptedLevel = -1;

    const step = 1;

    for (let l = 0; l < levels.length; l++) {
      const factor = levels[l].factor;
      const label = levels[l].label;
      const centers: FinderCandidate[] = [];

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
              if (this.checkRatio(stateCounts, factor)) {
                const center = x - Math.floor(stateCounts[4] + stateCounts[3] + stateCounts[2] / 2);
                const exactY = this.crossCheckVertical(imageData, center, y, stateCounts[2], isBlack, factor);
                if (exactY !== null) {
                  const centerX = this.crossCheckHorizontal(imageData, center, exactY, stateCounts[2], isBlack, factor);
                  if (centerX !== null) {
                    if (this.crossCheckDiagonal(imageData, centerX, exactY, stateCounts[2], isBlack, 1, 1) &&
                        this.crossCheckDiagonal(imageData, centerX, exactY, stateCounts[2], isBlack, 1, -1)) {
                      const total = stateCounts.reduce((a, b) => a + b, 0);
                      const moduleSize = total / 7;
                      centers.push({ x: centerX, y: exactY, estimatedModuleSize: moduleSize });
                    }
                  }
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

      // クラスタリング
      const clusters: FinderCandidate[][] = [];
      let lastMergeRadius = 0;
      for (const pt of centers) {
        let found = false;
        
        const estimatedMergeRadius = pt.estimatedModuleSize * 7 * 0.6 * 1.5;
        const guaranteedRadius = Math.max(estimatedMergeRadius, 20);
        const minMergeRadius = Math.min(width, height) * 0.03;
        const finalMergeRadius = Math.max(guaranteedRadius, minMergeRadius);
        lastMergeRadius = finalMergeRadius;

        for (const cluster of clusters) {
          const sumX = cluster.reduce((a, b) => a + b.x, 0);
          const sumY = cluster.reduce((a, b) => a + b.y, 0);
          const avgX = sumX / cluster.length;
          const avgY = sumY / cluster.length;

          const dist = Math.hypot(pt.x - avgX, pt.y - avgY);
          if (dist < finalMergeRadius) {
            cluster.push(pt);
            found = true;
            break;
          }
        }
        if (!found) clusters.push([pt]);
      }

      // まず上位10クラスタに絞るお！💖
      clusters.sort((a, b) => b.length - a.length);
      const top10Clusters = clusters.slice(0, 10);

      // 【品質フィルタ適用お！】💖
      const totalClusters = top10Clusters.length;
      const maxSize = totalClusters > 0 ? top10Clusters[0].length : 0;

      let condACount = 0;
      let condBCount = 0;
      const filteredClusters: FinderCandidate[][] = [];

      for (const cluster of top10Clusters) {
        // 条件A：クラスタのY座標の標準偏差が、推定モジュールサイズ × 3以上であること
        const avgModuleSize = cluster.reduce((sum, p) => sum + p.estimatedModuleSize, 0) / cluster.length;
        const varianceY = getVarianceY(cluster);
        const stdDevY = Math.sqrt(varianceY);
        const limitA = avgModuleSize * 3;
        const okA = stdDevY >= limitA;

        // 条件B：クラスタのサイズが、全クラスタの中の最大サイズの10%以上、かつ最低3点
        const limitB = maxSize * 0.1;
        const okB = cluster.length >= 3 && cluster.length >= limitB;

        if (!okA) condACount++;
        if (!okB) condBCount++;

        if (okA && okB) {
          filteredClusters.push(cluster);
        }
      }

      let targetClusters = filteredClusters;
      let fallbackUsed = false;
      if (targetClusters.length < 3) {
        targetClusters = top10Clusters.slice(0, 3);
        fallbackUsed = true;
      }

      const remainCount = targetClusters.length;

      if (l > 0) levelResultsStr += " | ";
      levelResultsStr += `[${label}] mergeRadius=${lastMergeRadius.toFixed(1)}px, candidates=${centers.length}pts → raw clusters=${clusters.length}, after filterA=${totalClusters - condACount}, after filterB=${filteredClusters.length}${fallbackUsed ? ' (fallback to top3)' : ''}`;

      if (remainCount >= 3 && adoptedLevel === -1) {
        finalCenters = centers;
        finalClusters = targetClusters;
        adoptedLevel = l;
        (this as any).filterTotal = totalClusters;
        (this as any).filterA = condACount;
        (this as any).filterB = condBCount;
        (this as any).filterRemain = remainCount;
      } else if (adoptedLevel === -1) {
        finalCenters = centers;
        finalClusters = targetClusters;
        (this as any).filterTotal = totalClusters;
        (this as any).filterA = condACount;
        (this as any).filterB = condBCount;
        (this as any).filterRemain = remainCount;
      }
    }

    finalClusters.sort((a, b) => {
      const varA = getVarianceY(a);
      const varB = getVarianceY(b);
      return varB - varA;
    });

    (this as any).debugCentersCount = finalCenters.length;
    (this as any).debugClustersCount = finalClusters.length;

    this.ratioCheckLog = `ratio check: ${levelResultsStr} → merged=${finalClusters.length}clusters`;

    const merged = finalClusters.map(cluster => {
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
    isBlack: (i: number) => boolean,
    factor: number
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
    if (Math.abs(total - hTotal) > hTotal * 0.35) {
      return null;
    }
    
    if (this.checkRatio(vCounts, factor)) {
      return topY + vCounts[0] + vCounts[1] + vCounts[2]/2;
    }
    return null;
  }

  private crossCheckHorizontal(
    imageData: ImageData,
    centerX: number,
    exactY: number,
    maxCount: number,
    isBlack: (i: number) => boolean,
    factor: number
  ): number | null {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    const isColor = (idx: number) => {
      const r = data[idx], g = data[idx+1], b = data[idx+2];
      return (Math.max(r, g, b) - Math.min(r, g, b)) > 80;
    };
    
    const hCounts = [0, 0, 0, 0, 0];
    const roundedY = Math.round(exactY);
    if (roundedY < 0 || roundedY >= height) return null;
    
    let x = centerX;
    while (x >= 0) {
      const idx = (roundedY * width + x) * 4;
      if (isColor(idx)) return null;
      if (isBlack(idx)) {
        hCounts[2]++;
        x--;
      } else {
        break;
      }
    }
    if (x < 0) return null;
    
    while (x >= 0) {
      const idx = (roundedY * width + x) * 4;
      if (isColor(idx)) return null;
      if (!isBlack(idx)) {
        hCounts[1]++;
        x--;
      } else {
        break;
      }
    }
    if (x < 0 || hCounts[1] === 0) return null;
    
    while (x >= 0) {
      const idx = (roundedY * width + x) * 4;
      if (isColor(idx)) return null;
      if (isBlack(idx)) {
        hCounts[0]++;
        x--;
      } else {
        break;
      }
    }
    if (hCounts[0] === 0) return null;
    
    const leftX = x + 1; // 🥺 左端の座標(inclusive)を右向き走査でxが上書きされる前にキープ！✨
    x = centerX + 1;
    while (x < width) {
      const idx = (roundedY * width + x) * 4;
      if (isColor(idx)) return null;
      if (isBlack(idx)) {
        hCounts[2]++;
        x++;
      } else {
        break;
      }
    }
    if (x >= width) return null;
    
    while (x < width) {
      const idx = (roundedY * width + x) * 4;
      if (isColor(idx)) return null;
      if (!isBlack(idx)) {
        hCounts[3]++;
        x++;
      } else {
        break;
      }
    }
    if (x >= width || hCounts[3] === 0) return null;
    
    while (x < width) {
      const idx = (roundedY * width + x) * 4;
      if (isColor(idx)) return null;
      if (isBlack(idx)) {
        hCounts[4]++;
        x++;
      } else {
        break;
      }
    }
    if (hCounts[4] === 0) return null;
    
    const rightEdge = x - 1;

    const total = hCounts.reduce((a, b) => a + b, 0);
    const hTotal = maxCount * 7 / 3;
    if (Math.abs(total - hTotal) > hTotal * 0.35) {
      return null;
    }
    
    if (this.checkRatio(hCounts, factor)) {
      return leftX + hCounts[0] + hCounts[1] + hCounts[2]/2;
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
    return true; // 🥺 一時的に無効化するお！ diagonal check: disabled 💖
  }

  private checkRatio(counts: number[], factor: number = 1.0): boolean {
    const total = counts.reduce((a, b) => a + b, 0);
    if (total < 7) return false;
    const moduleSize = total / 7;
    const maxVariance = moduleSize * 0.5 * factor;

    // 左右の外側黒セルが著しく非対称なら falseを返す (要件: Math.abs(counts[0] - counts[4]) < moduleSize * 0.5 * factor に緩和！)
    if (Math.abs(counts[0] - counts[4]) >= moduleSize * 0.5 * factor) {
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

    const reds: number[] = [];
    const greens: number[] = [];
    const blues: number[] = [];

    for (let dy = -sampleRadius; dy <= sampleRadius; dy++) {
      for (let dx = -sampleRadius; dx <= sampleRadius; dx++) {
        const i = ((py + dy) * width + (px + dx)) * 4;
        reds.push(data[i]);
        greens.push(data[i + 1]);
        blues.push(data[i + 2]);
      }
    }

    const getMedian = (arr: number[]): number => {
      const len = arr.length;
      if (len === 25) {
        // partial sort: 25要素（5x5）のときは、中央値（インデックス12）を求めるために
        // 最初の13要素（0〜12）だけ最小値を確定させる部分選択ソートを回してエコに処理！✨
        for (let i = 0; i <= 12; i++) {
          let minIdx = i;
          for (let j = i + 1; j < 25; j++) {
            if (arr[j] < arr[minIdx]) {
              minIdx = j;
            }
          }
          if (minIdx !== i) {
            const temp = arr[i];
            arr[i] = arr[minIdx];
            arr[minIdx] = temp;
          }
        }
        return arr[12];
      }
      // それ以外（9点や1点など）は標準ソートでサクッと解決！
      arr.sort((a, b) => a - b);
      return arr[Math.floor(len / 2)];
    };

    return {
      r: getMedian(reds),
      g: getMedian(greens),
      b: getMedian(blues)
    };
  }

  private matchColor(col: { r: number, g: number, b: number }, palette: { r: number, g: number, b: number }[]): number {
    // 💡 究極のハイブリッド判定！✨
    // 1. 【RGB相対キューブ判定】白(7)と黒(0)の基準から、各RGBチャンネルの絶対的明暗の境界線を引く最強の環境グラデーション耐性！💪
    const thR = (palette[0].r + palette[7].r) / 2;
    const thG = (palette[0].g + palette[7].g) / 2;
    const thB = (palette[0].b + palette[7].b) / 2;
    const cubeIdx = (col.r > thR ? 4 : 0) | (col.g > thG ? 2 : 0) | (col.b > thB ? 1 : 0);

    // 2. 【HSV空間NN判定】色温度シフト（暖色電球など）に対する色相ベースの直感的な近さ！💖
    let minDist = Infinity;
    let minIdx = -1;
    for (let i = 0; i < 8; i++) {
      const dist = colorDistance(col.r, col.g, col.b,
                                 palette[i].r, palette[i].g, palette[i].b);
      if (dist < minDist) { minDist = dist; minIdx = i; }
    }

    if (minDist > 150) return cubeIdx; // NNが遠すぎる場合は確実にcubeIdxを採用！

    if (cubeIdx === minIdx) {
      return cubeIdx;
    }

    // 意見が割れた場合🚨
    // 白飛び・黒潰れ環境や、無彩色(0, 7)の判定において、HSVの Nearest Neighbor は色相が暴れて非常に脆弱になるみ🥺
    // そこで、対象の色が彩度が低め（白や黒、グレー）である場合、またはキューブ判定が白(7)か黒(0)を示す場合は
    // 相対コントラストに基づく「キューブ判定」を絶対正義とする！！🔥
    const maxC = Math.max(col.r, col.g, col.b);
    const minC = Math.min(col.r, col.g, col.b);
    
    if ((maxC - minC) < 30 || cubeIdx === 0 || cubeIdx === 7) {
      return cubeIdx;
    }

    // 彩度が高い（カラフルな色）においては、HSVによる色相マッチング（minIdx）の意見を尊重する！✨
    return minIdx;
  }
}
