import { DecodeResult, DecodeDebugInfo, DecodedChunk, Point, GRID_PROFILES, GridProfileId, PhaseLog, Mat3 } from "./types";
import { getPerspectiveTransform, perspectiveTransform, colorDistance } from "./math";
import { isReservedCell, getHeaderCellIndex, unpackFrom3Bit, unpackFrom3BitWithErasures, Unpack3BitResult, PALETTE_RGB, getAlignmentCenters, getColorGridMask, getBlocksConfig } from "./utils";
import { crc32 } from "./checksum";
import { ReedSolomon } from "./rs";

export class ColorGridDecoder {
  public debugMode = true; // ログは最初から最高潮に出すっしょ！✌️✨
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

    // --- ファインダー実測モジュールサイズからのグリッドサイズ(N)ダイレクト推定！✨ ---
    // ファインダー走査時に 1:1:3:1:1 の実測幅から得た moduleSize（=1セルのpx幅）は
    // ホモグラフィに依存しない一次情報なので、これでNを推定するのが最強に堅牢だお💖
    // （旧タイミング事前走査は M(121) 前提の仮ホモグラフィだったため、S/XS/XLでは
    //   タイミング行ではなくヘッダ行を走査してNを大幅誤推定 → 正解プロファイルを
    //   候補から除外して全滅する致命バグがあった🥺 推定は並べ替えのみに使い、除外はしない！）
    const spanPx = Math.hypot(TR.x - TL.x, TR.y - TL.y);
    const moduleSizes = [TL, TR, BL]
      .map(p => (p as any).estimatedModuleSize as number | undefined)
      .filter((v): v is number => typeof v === "number" && v > 0);
    const moduleEst = moduleSizes.length > 0
      ? moduleSizes.reduce((a, b) => a + b, 0) / moduleSizes.length
      : -1;
    const nModule = moduleEst > 0 ? spanPx / moduleEst + F_temp : -1;

    const candidateProfiles: GridProfileId[] = [...baseCandidates];
    if (nModule > 0) {
      candidateProfiles.sort((a, b) =>
        Math.abs(GRID_PROFILES[a].size - nModule) - Math.abs(GRID_PROFILES[b].size - nModule));
    }
    // 直前フレームで成功したプロファイルは最優先で試す！🚀
    if (this.lastSuccessProfileId) {
      const idx = candidateProfiles.indexOf(this.lastSuccessProfileId);
      if (idx > 0) {
        candidateProfiles.splice(idx, 1);
        candidateProfiles.unshift(this.lastSuccessProfileId);
      }
    }

    timingLogDetail = `timing(diag): ${transitions}transitions, estimatedN=${estimatedN} | moduleEst=${moduleEst.toFixed(2)}px → N≈${nModule.toFixed(1)} → candidates=[${candidateProfiles.join(", ")}]`;

    phaseLogs.push({
      phase: "timing",
      ok: nModule > 0,
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
      
      let mat: Mat3 | null = null;
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
        const isValid = rot === 0 || (tempPalette.length >= 6 && maxColorDist > 150 && colorfulCount >= 3 && blackCount >= 1);
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

      if (cellWidth < 1.8) {
        phaseLogs.push({
          phase: "homography",
          ok: false,
          detail: `⚠️ cellWidth too small (${cellWidth.toFixed(2)}px), skip`,
          durationMs: homographyDuration
        });
        continue;
      }

      if (cellWidth < 2.5 && pId !== "XS") {
        phaseLogs.push({
          phase: "resolution_warning",
          ok: true,
          detail: `[${pId}] cellWidth/cw is low (${cellWidth.toFixed(2)}px). S+ requires >=3px, ideally >=4px.`,
          durationMs: 0
        });
      }

      phaseLogs.push({
        phase: "homography",
        ok: true,
        detail: `[${pId}] 推定cellWidth: ${cellWidth.toFixed(2)}px`,
        durationMs: homographyDuration
      });

      // 📐 セルサイズに応じたサンプリング半径：セル中央25%領域を超えない範囲で最大限に取る！
      // 小さいセルほどノイズに弱いので、cw>=4pxなら3x3メディアン、cw>=8pxなら5x5メディアンを使うお💖
      const sampleRadius = Math.min(2, Math.floor(cellWidth * 0.25));

      // 複数アライメントパターン(AP)の検出
      const isIdealBlack = (dx: number, dy: number): boolean => {
        return (dx === 0 && dy === 0) || Math.max(Math.abs(dx), Math.abs(dy)) === 2;
      };

      const alignmentStart = performance.now();
      const apCenters = getAlignmentCenters(N, pId);
      const detectedAPs: { theory: Point; real: Point; offset: { dx: number; dy: number } }[] = [];
      const apLogs: string[] = [];

      const calculateAPContrastAt = (ap: Point, sx: number, sy: number): number => {
        let sumWhiteLuma = 0;
        let countWhite = 0;
        let sumBlackLuma = 0;
        let countBlack = 0;

        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            // セル(ap.x+dx, ap.y+dy) の「中心」は +0.5 した連続座標！ここを外すと常に半セルずれるお🥺
            const pt = perspectiveTransform({ x: ap.x + 0.5 + sx + dx, y: ap.y + 0.5 + sy + dy }, mat);
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

      for (const ap of apCenters) {
        // 第1段階: ±2.0セル、0.2刻みで粗探索 (シフトが小さいほど優遇するためのスコアリングを導入するよ✨)
        let coarseBestX = 0;
        let coarseBestY = 0;
        let coarseMaxScore = -Infinity;
        let coarseBestContrast = -Infinity;

        for (let sy = -2.0; sy <= 2.0; sy += 0.2) {
          for (let sx = -2.0; sx <= 2.0; sx += 0.2) {
            const contrast = calculateAPContrastAt(ap, sx, sy);
            if (contrast === -Infinity) continue;
            // ずれ（sx, sy）の二乗距離に比例したペナルティ
            const score = contrast - 10 * (sx * sx + sy * sy);
            if (score > coarseMaxScore) {
              coarseMaxScore = score;
              coarseBestX = sx;
              coarseBestY = sy;
              coarseBestContrast = contrast;
            }
          }
        }

        // 第2段階: 精探索
        let bestShiftX = coarseBestX;
        let bestShiftY = coarseBestY;
        let maxScore = coarseMaxScore;
        let bestContrast = coarseBestContrast;

        for (let sy = coarseBestY - 0.3; sy <= coarseBestY + 0.3; sy += 0.05) {
          for (let sx = coarseBestX - 0.3; sx <= coarseBestX + 0.3; sx += 0.05) {
            const contrast = calculateAPContrastAt(ap, sx, sy);
            if (contrast === -Infinity) continue;
            const score = contrast - 10 * (sx * sx + sy * sy);
            if (score > maxScore) {
              maxScore = score;
              bestShiftX = sx;
              bestShiftY = sy;
              bestContrast = contrast;
            }
          }
        }

        if (bestContrast !== -Infinity && bestContrast > 10) {
          const paraPt = perspectiveTransform({ x: ap.x + 0.5, y: ap.y + 0.5 }, mat);
          const realPt = perspectiveTransform({ x: ap.x + 0.5 + bestShiftX, y: ap.y + 0.5 + bestShiftY }, mat);
          const offset = {
            dx: realPt.x - paraPt.x,
            dy: realPt.y - paraPt.y
          };
          detectedAPs.push({
            theory: ap,
            real: realPt,
            offset
          });
          apLogs.push(`AP(${ap.x},${ap.y}) contrast:${bestContrast.toFixed(1)} shift:${Math.hypot(offset.dx, offset.dy).toFixed(1)}px`);
        } else {
          apLogs.push(`AP(${ap.x},${ap.y}) fallback/not-detected`);
        }
      }

      const alignmentDuration = performance.now() - alignmentStart;
      const apSummaryDetail = `[${pId}] Alignment calibration: ${detectedAPs.length}/${apCenters.length} APs localized. \n` + apLogs.join("\n");

      // 基本のホモグラフィ mat を、検出した右下AP (N-6, N-6) に基づいてアップデート (4点補正ホモグラフィ更新)
      const bottomRightAP = detectedAPs.find(v => v.theory.x === N - 6 && v.theory.y === N - 6);
      if (bottomRightAP) {
        const dstPointsAP = [
          { x: centerOff, y: centerOff },
          { x: N - centerOff, y: centerOff },
          { x: N - 6 + 0.5, y: N - 6 + 0.5 }, // realPtはAPセル「中心」の実測位置なので +0.5 の連続座標とペアリング！
          { x: centerOff, y: N - centerOff },
        ];
        const srcPointsAP = [
          TL,
          TR,
          bottomRightAP.real,
          BL,
        ];
        const matAP = getPerspectiveTransform(dstPointsAP, srcPointsAP);
        if (matAP) {
          mat = matAP;
          // matが変わったので、各APのオフセットを新matに対する残差として再計算！
          // （旧matとの残差のまま使うと、BR補正分が二重適用されて右下が2倍ズレるお🥺）
          for (const item of detectedAPs) {
            const p = perspectiveTransform({ x: item.theory.x + 0.5, y: item.theory.y + 0.5 }, mat);
            item.offset = { dx: item.real.x - p.x, dy: item.real.y - p.y };
          }
        }
      }

      phaseLogs.push({
        phase: "alignment",
        ok: detectedAPs.length > 0,
        detail: apSummaryDetail,
        durationMs: alignmentDuration
      });

      // IDW (Inverse Distance Weighting) ローカルオフセット補間
      const getLocalOffset = (cx: number, cy: number): { dx: number, dy: number } => {
        if (detectedAPs.length === 0) return { dx: 0, dy: 0 };
        
        let sumWeight = 0;
        let sumDx = 0;
        let sumDy = 0;
        
        for (const item of detectedAPs) {
          const dist = Math.hypot(cx - item.theory.x, cy - item.theory.y);
          if (dist < 0.1) {
            return item.offset;
          }
          const weight = 1.0 / (dist * dist);
          sumDx += item.offset.dx * weight;
          sumDy += item.offset.dy * weight;
          sumWeight += weight;
        }
        
        return {
          dx: sumDx / sumWeight,
          dy: sumDy / sumWeight
        };
      };

      // 📐 タイミングパターンによる微調整補正 📐
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
        
        // 1. AP(アライメントパターン)による歪み補正を取得
        const offAP = getLocalOffset(cx, cy);

        // 2. タイミングパターンによる追加の歪み補正を取得
        let offH = { dx: 0, dy: 0 };
        let offV = { dx: 0, dy: 0 };
        if (shouldApplyTimingCorrection) {
          offH = interpolateOffset(horizontalOffsets, cx);
          offV = interpolateOffset(verticalOffsets, cy);
        }

        return {
          x: ptTheo.x + offAP.dx + offH.dx + offV.dx,
          y: ptTheo.y + offAP.dy + offH.dy + offV.dy
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
        log.push(`${pId}: post-AP timing check failed (warning, fallback to decoding)`);
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
        if (cellWidth < 6.0) {
          // 極小セルでも1点きりだとノイズ1発で即死なので、±0.2セルの5点クロス＋メディアンで守るお🥺
          pts = [
            { x: x_center + 0.5, y: 0.5 }, // 中心
            { x: x_center + 0.5, y: 0.3 }, // 上
            { x: x_center + 0.5, y: 0.7 }, // 下
            { x: x_center + 0.3, y: 0.5 }, // 左
            { x: x_center + 0.7, y: 0.5 }  // 右
          ];
          currentSampleRadius = 0;
        } else if (cellWidth < 9.0) {
          pts = [
            { x: x_center + 0.5, y: 0.5 }, // 中心
            { x: x_center + 0.5, y: 0.3 }, // 上
            { x: x_center + 0.5, y: 0.7 }, // 下
            { x: x_center + 0.3, y: 0.5 }, // 左
            { x: x_center + 0.7, y: 0.5 }  // 右
          ];
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

      // パレット実測値から適応閾値をこのフレーム用に1回だけ構築！✨
      const colorTh = this.buildColorThresholds(readPalette);

      // 同期クロック（v1.5.0からは、曖昧・失敗してもデコード続行する超高可用性フォールバック仕様！）
      const clockStart = performance.now();
      const clockPt = getCorrectedPt(F + 1 + 0.5, 1.5);
      const clockCol = this.sampleColor(imageData, clockPt.x, clockPt.y, sampleRadius);
      
      let clockVal = 0;
      const clockDuration = performance.now() - clockStart;
      
      if (!clockCol) {
        phaseLogs.push({
          phase: "clock",
          ok: true, 
          detail: `[${pId}] warning: 同期クロックのカラーサンプリング（RGB=null）失敗み🥺（デフォルト色0でフォールバックして続行！）`,
          durationMs: clockDuration
        });
        log.push(`${pId}: clock read failed (fallback logic engaged)`);
      } else {
        const measuredClockVal = this.matchColor(clockCol, readPalette, colorTh);
        const clockDetail = `[${pId}] clockVal: ${measuredClockVal}, lastClockValueとの比較: (本フレーム: ${measuredClockVal}, 前フレーム: ${this.lastClockValue})`;

        if (measuredClockVal === -1) {
          phaseLogs.push({
            phase: "clock",
            ok: true, 
            detail: `[${pId}] warning: 同期クロックが曖昧(-1)み🥺（安全フォールバックでデコード続行！） ` + clockDetail,
            durationMs: clockDuration
          });
          log.push(`${pId}: clock read ambiguous (fallback logic engaged)`);
          clockVal = 0; 
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

            const mCol = this.matchColor(col, readPalette, colorTh);
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

            // -1 も許容してそのまま入れるお！消失はRSで訂正するから大丈夫っしょ✨
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

      const unpackResult = unpackFrom3BitWithErasures(headerRaw, 24);
      const headerBytesEnc = unpackResult.bytes;
      const erasures = unpackResult.erasureBytePositions;
      const toHex = (arr: Uint8Array) => Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join(" ");
      const headerEncStr = `headerEnc: ${toHex(headerBytesEnc)} erasures: [${erasures.join(",")}]`;

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

      const headerBytes = this.rs.decode(headerBytesEnc, 12, erasures);
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

      if (magic !== 0xC6 && magic !== 0xC7) {
        phaseLogs.push({
          phase: "magic",
          ok: false,
          detail: `[${pId}] Magicバイト不一致み🥺 magic: expected=0xC6/0xC7 actual=0x${magic.toString(16).toUpperCase()}\n${headerRawStr}\n${headerEncStr}`,
          durationMs: magicDuration
        });
        log.push(`${pId}: magic mismatch (${magic.toString(16)})`);
        continue;
      } else {
        phaseLogs.push({
          phase: "magic",
          ok: true,
          detail: `[${pId}] Magicバイト一致お！ magic: expected=0xC6/0xC7 actual=0x${magic.toString(16).toUpperCase()}`,
          durationMs: magicDuration
        });
      }

      debug.detectedProfileId = pId;
      debug.estimatedGridSize = profile.size;
      const secondByte = view.getUint8(1);
      const pIdx = secondByte & 0x0F;
      const maskPattern = (magic === 0xC7) ? ((secondByte >>> 4) & 0x07) : 0;
      const chunkIndex = view.getUint16(2, false);
      const totalChunks = view.getUint16(4, false);
      const payloadLength = view.getUint16(6, false);
      const payloadChecksum = view.getUint32(8, false);

      this.lastClockValue = clockVal;

      const payloadStart = performance.now();
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
            if (pId === "XS" && debugSampled.length < 1000) {
              debugSampled.push(pt);
            }
            
            const col = this.sampleColor(imageData, pt.x, pt.y, sampleRadius);
            const rawVal = col ? this.matchColor(col, readPalette, colorTh) : -1;
            
            // 新仕様: マスク適用時は XOR 逆マスク！✨
            const currentVal = (rawVal === -1) ? -1 : ((magic === 0xC7) ? (rawVal ^ getColorGridMask(maskPattern, x, y)) : rawVal);

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

      // Payload デコード ＆ Reed-Solomon ブロック復元
      let payload = new Uint8Array(0);
      let payloadErasures: number[] = [];
      let inputLengthForLog = 0;
      let parityLengthForLog = 0;
      const payloadDecStart = performance.now();

      if (magic === 0xC7) {
        // 🚀 新プロトコル：複数ブロック＆インターリーブデコード 🚀
        const configs = getBlocksConfig(payloadLength);
        const totalParityBytes = configs.reduce((sum, c) => sum + c.paritySize, 0);
        const totalPayloadBytes = payloadLength + totalParityBytes;
        inputLengthForLog = totalPayloadBytes;
        parityLengthForLog = totalParityBytes;

        const unpacking = unpackFrom3BitWithErasures(payload3bit, totalPayloadBytes);
        const fullBytes = unpacking.bytes;
        const fullErasures = new Set(unpacking.erasureBytePositions);
        payloadErasures = unpacking.erasureBytePositions;

        const dataBlocks: Uint8Array[] = configs.map(c => new Uint8Array(c.dataSize));
        const parityBlocks: Uint8Array[] = configs.map(c => new Uint8Array(c.paritySize));
        const blockErasures: number[][] = configs.map(() => []);

        let byteIdx = 0;

        // データ部デインターリーブ
        const maxDataLen = Math.max(...configs.map(c => c.dataSize));
        for (let i = 0; i < maxDataLen; i++) {
          for (let b = 0; b < configs.length; b++) {
            const config = configs[b];
            if (i < config.dataSize) {
              dataBlocks[b][i] = fullBytes[byteIdx];
              if (fullErasures.has(byteIdx)) {
                blockErasures[b].push(i);
              }
              byteIdx++;
            }
          }
        }

        // パリティ部デインターリーブ
        const maxParityLen = Math.max(...configs.map(c => c.paritySize));
        for (let i = 0; i < maxParityLen; i++) {
          for (let b = 0; b < configs.length; b++) {
            const config = configs[b];
            if (i < config.paritySize) {
              parityBlocks[b][i] = fullBytes[byteIdx];
              if (fullErasures.has(byteIdx)) {
                blockErasures[b].push(config.dataSize + i);
              }
              byteIdx++;
            }
          }
        }

        // 各ブロック個別にRSデコード
        const decodedParts: Uint8Array[] = [];
        let rsSuccess = true;

        for (let b = 0; b < configs.length; b++) {
          const config = configs[b];
          const blockEnc = new Uint8Array(config.dataSize + config.paritySize);
          blockEnc.set(dataBlocks[b], 0);
          blockEnc.set(parityBlocks[b], config.dataSize);

          const blockDec = this.rs.decode(
            blockEnc,
            config.paritySize,
            blockErasures[b]
          );

          if (!blockDec) {
            rsSuccess = false;
            break;
          }
          decodedParts.push(blockDec);
        }

        if (rsSuccess) {
          const merged = new Uint8Array(payloadLength);
          let offset = 0;
          for (const part of decodedParts) {
            merged.set(part, offset);
            offset += part.length;
          }
          payload = merged;
        } else {
          payload = new Uint8Array(0);
        }

      } else {
        // 🦖 旧プロトコル：単一ブロック＆インターリーブなしデコード 🦖
        const totalPayloadBytes = payloadLength + Math.ceil(payloadLength * 0.25);
        inputLengthForLog = totalPayloadBytes;
        parityLengthForLog = Math.ceil(payloadLength * 0.25);

        const unpackRes = unpackFrom3BitWithErasures(payload3bit, totalPayloadBytes);
        const encodedPayload = unpackRes.bytes;
        payloadErasures = unpackRes.erasureBytePositions;

        payload = this.rs.decode(
          encodedPayload,
          Math.ceil(payloadLength * 0.25),
          payloadErasures
        ) || new Uint8Array(0);
      }
      const payloadDecDuration = performance.now() - payloadDecStart;

      const pCrc = (payload.length > 0) ? crc32(payload) : 0;
      
      if (this.debugMode) {
        let maxPaletteSpread = 0;
        for (let i = 0; i < readPalette.length; i++) {
          const c = readPalette[i];
          for (let j = i + 1; j < readPalette.length; j++) {
            const dist = colorDistance(c.r, c.g, c.b, readPalette[j].r, readPalette[j].g, readPalette[j].b);
            if (dist > maxPaletteSpread) maxPaletteSpread = dist;
          }
        }
        phaseLogs.push({
          phase: "protocolTelemetry",
          ok: payload.length > 0,
          detail: `[${pId}] Telemetry metrics:\n` +
                  `  profileId: ${pId}\n` +
                  `  cellWidth: ${cellWidth.toFixed(2)} [spanPx: ${spanPx.toFixed(1)}]\n` +
                  `  candidateProfiles: ${candidateProfiles.join(",")}\n` +
                  `  estimatedN: ${estimatedN} [estimatedNPost: ${estimatedNPost}]\n` +
                  `  timingTransitions: h:${horizontalOffsets.length} v:${verticalOffsets.length}\n` +
                  `  paletteSpread: maxDist=${maxPaletteColorDist.toFixed(1)} colorfulCount=${colorfulCount}\n` +
                  `  headerRaw: [${headerRaw.slice(0, 10).join(",")}]\n` +
                  `  payloadErasures: count=${payloadErasures.length}\n` +
                  `  voteHistoryLength: max=${totalHistoryLength} (applied:${voteAppliedCount}, uncertain:${uncertainCount})\n` +
                  `  RSDecodedInputLen: ${inputLengthForLog} bytes [RSParityLen: ${parityLengthForLog} bytes]\n` +
                  `  CRCExpected: 0x${payloadChecksum.toString(16).toUpperCase()} [CRCActual: 0x${pCrc.toString(16).toUpperCase()}]\n` +
                  `  magic: 0x${magic.toString(16).toUpperCase()} [maskPattern: ${maskPattern}]`,
          durationMs: payloadDecDuration
        });
      }
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

      // 強い有彩色（青・シアン等のカラーデータセル）は「黒」扱いしない！
      // 固定閾値(>80)は白の色被りを誤爆したので、max成分に対する相対彩度で判定するお✨
      // 白の色被り: chroma小/max大 → 通過。純色データセル: chroma≈max → 黒から除外。
      const maxCh = Math.max(r, g, b);
      const chroma = maxCh - Math.min(r, g, b);
      if (chroma > Math.max(48, maxCh * 0.45)) {
        return false;
      }

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
      // lv3はかつて背景ノイズ誘発で撤廃したけど、クラスタのメディアン外れ点除去＆
      // 相対彩度ガード＆L字全探索スコアリングが入った今なら安全に復活できるお！
      // 強ボケ・極小セル（cw≒2.5px）でのファインダー救済用だよ🥺💖
      { name: "lv3 (factor 1.15)", factor: 1.15, label: "lv3" },
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

      // --- 👇 垂直スキャン追加お！ 👇 ---
      for (let x = 0; x < width; x += step) {
        let stateCounts = [0, 0, 0, 0, 0];
        let currentState = 0;

        for (let y = 0; y < height; y++) {
          const i = (y * width + x) * 4;
          
          const black = isBlack(i);

          if (currentState === 0 && stateCounts[0] === 0 && !black) {
            continue;
          }

          if ((currentState % 2 === 0 && black) || (currentState % 2 === 1 && !black)) {
            stateCounts[currentState]++;
          } else {
            if (currentState === 4) {
              if (this.checkRatio(stateCounts, factor)) {
                const cy = y - Math.floor(stateCounts[4] + stateCounts[3] + stateCounts[2] / 2);
                const exactX = this.crossCheckHorizontal(imageData, x, cy, stateCounts[2], isBlack, factor);
                if (exactX !== null) {
                  const centerY = this.crossCheckVertical(imageData, exactX, cy, stateCounts[2], isBlack, factor);
                  if (centerY !== null) {
                    if (this.crossCheckDiagonal(imageData, exactX, centerY, stateCounts[2], isBlack, 1, 1) &&
                        this.crossCheckDiagonal(imageData, exactX, centerY, stateCounts[2], isBlack, 1, -1)) {
                      const total = stateCounts.reduce((a, b) => a + b, 0);
                      const moduleSize = total / 7;
                      centers.push({ x: exactX, y: centerY, estimatedModuleSize: moduleSize });
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
      // --- 👆 垂直スキャンここまで 👆 ---

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
        // 条件A：クラスタのY座標の標準偏差が、推定モジュールサイズ × 3以下であること (大きすぎるものはノイズや結合ラインなので排除するよ✨)
        const avgModuleSize = cluster.reduce((sum, p) => sum + p.estimatedModuleSize, 0) / cluster.length;
        const varianceY = getVarianceY(cluster);
        const stdDevY = Math.sqrt(varianceY);
        const limitA = avgModuleSize * 3;
        const okA = stdDevY <= limitA;

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
        // 3クラスタ確保できたレベルで即確定！残りの緩いレベルを走査しない分、
        // フレームあたりのファインダー探索コストを最大1/3にカットするお🚀
        break;
      } else if (adoptedLevel === -1) {
        finalCenters = centers;
        finalClusters = targetClusters;
        (this as any).filterTotal = totalClusters;
        (this as any).filterA = condACount;
        (this as any).filterB = condBCount;
        (this as any).filterRemain = remainCount;
      }
    }

    // 点数が多く、信頼性の高いクラスタ順（サイズ降順）にソートするお！✌️✨
    finalClusters.sort((a, b) => b.length - a.length);

    (this as any).debugCentersCount = finalCenters.length;
    (this as any).debugClustersCount = finalClusters.length;

    this.ratioCheckLog = `ratio check: ${levelResultsStr} → merged=${finalClusters.length}clusters`;

    const median = (vals: number[]): number => {
      const s = [...vals].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };

    const merged = finalClusters.map(cluster => {
      // 平均（重心）はデータ領域から紛れ込んだ偽ファインダー点に引っ張られて
      // 数px〜十数pxズレることがあるので、メディアン基準で外れ点を落としてから平均するお🥺💖
      const medX = median(cluster.map(p => p.x));
      const medY = median(cluster.map(p => p.y));
      const medM = median(cluster.map(p => p.estimatedModuleSize));
      const inlierRadius = Math.max(medM * 2.5, 6);
      const inliers = cluster.filter(p =>
        Math.hypot(p.x - medX, p.y - medY) <= inlierRadius &&
        p.estimatedModuleSize <= medM * 1.6 && p.estimatedModuleSize >= medM * 0.6
      );
      const use = inliers.length >= Math.max(2, cluster.length * 0.3) ? inliers : cluster;
      const sumX = use.reduce((a, b) => a + b.x, 0);
      const sumY = use.reduce((a, b) => a + b.y, 0);
      const sumM = use.reduce((a, b) => a + b.estimatedModuleSize, 0);
      // estimatedModuleSize はプロファイル(グリッドサイズN)推定に使う一次情報として同梱！✨
      return { x: sumX / use.length, y: sumY / use.length, estimatedModuleSize: sumM / use.length };
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
      return false; // 有彩色スキップを無効化お！🌈 色被りしててもファインダーを絶対見逃さない！
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
      return false; // 有彩色スキップを無効化お！🌈 色被りしててもファインダーを絶対見逃さない！
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

  /**
   * パレット8色の実測値から、チャンネル閾値＆適応マージンを事前計算するよ！✨
   * - 閾値: 各チャンネルの「そのビットが0の4色の平均」と「1の4色の平均」の中点。
   *   2色だけからの推定に比べてノイズが1/√2以下に減って超安定！
   * - マージン: 実測コントラスト幅(hi-lo)に比例させる。暗い映像やコントラストが
   *   潰れた映像で固定マージン24が広すぎて消失(-1)だらけになるのを防ぐお🥺💖
   */
  private buildColorThresholds(palette: { r: number; g: number; b: number }[]) {
    const avg = (idxs: number[], ch: "r" | "g" | "b") =>
      idxs.reduce((s, i) => s + palette[i][ch], 0) / idxs.length;

    // ビット対応: index = R(bit2) G(bit1) B(bit0)
    const loR = avg([0, 1, 2, 3], "r"), hiR = avg([4, 5, 6, 7], "r");
    const loG = avg([0, 1, 4, 5], "g"), hiG = avg([2, 3, 6, 7], "g");
    const loB = avg([0, 2, 4, 6], "b"), hiB = avg([1, 3, 5, 7], "b");

    const clampMargin = (range: number) => Math.min(24, Math.max(6, range * 0.12));

    return {
      thR: (loR + hiR) / 2,
      thG: (loG + hiG) / 2,
      thB: (loB + hiB) / 2,
      mR: clampMargin(hiR - loR),
      mG: clampMargin(hiG - loG),
      mB: clampMargin(hiB - loB),
      nnMargin: Math.min(18, Math.max(8, ((hiR - loR) + (hiG - loG) + (hiB - loB)) / 3 * 0.09)),
    };
  }

  private matchColor(
    col: { r: number; g: number; b: number },
    palette: { r: number; g: number; b: number }[],
    th?: ReturnType<ColorGridDecoder["buildColorThresholds"]>
  ): number {
    const t = th ?? this.buildColorThresholds(palette);

    const ambR = Math.abs(col.r - t.thR) <= t.mR;
    const ambG = Math.abs(col.g - t.thG) <= t.mG;
    const ambB = Math.abs(col.b - t.thB) <= t.mB;

    const ambiguousChannels = Number(ambR) + Number(ambG) + Number(ambB);

    // 1chだけ曖昧なら残り2chで判定可能。
    // 2ch以上が曖昧なら消失扱い。
    if (ambiguousChannels >= 2) {
      return -1;
    }

    const cubeIdx =
      (col.r > t.thR ? 4 : 0) |
      (col.g > t.thG ? 2 : 0) |
      (col.b > t.thB ? 1 : 0);

    // 最近傍との整合性チェック
    let minDist = Infinity;
    let secondDist = Infinity;
    let minIdx = -1;

    for (let i = 0; i < 8; i++) {
      const d = colorDistance(
        col.r, col.g, col.b,
        palette[i].r, palette[i].g, palette[i].b
      );

      if (d < minDist) {
        secondDist = minDist;
        minDist = d;
        minIdx = i;
      } else if (d < secondDist) {
        secondDist = d;
      }
    }

    // cube判定と最近傍が割れて、距離差も小さいなら曖昧
    if (cubeIdx !== minIdx && secondDist - minDist < t.nnMargin) {
      return -1;
    }

    return cubeIdx;
  }
}
