import { Point, Mat3 } from "./types";

/**
 * 8元連立一次方程式をガウス消去法で解く
 * なんで連立方程式を組むの？🤔：
 * スマホカメラとかで斜めから撮ったグリッドを、真っ直ぐな正方形に戻す（ホモグラフィ変換）ために必要！
 * 1つの点（x, y）に対して「変換後のU, V」が分かるから、4点（四隅）があれば2x4=8個の式が立つ！
 * 未知数（h00～h21）の8個をこれで一気に解けるってワケ✨ マジ数学最強じゃね？
 */
export function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) {
        maxRow = k;
      }
    }
    const tempA = A[i]; A[i] = A[maxRow]; A[maxRow] = tempA;
    const tempB = b[i]; b[i] = b[maxRow]; b[maxRow] = tempB;

    if (Math.abs(A[i][i]) < 1e-10) return null; // ゼロ割回避！

    for (let k = i + 1; k < n; k++) {
      const c = -A[k][i] / A[i][i];
      for (let j = i; j < n; j++) {
        if (i === j) A[k][j] = 0;
        else A[k][j] += c * A[i][j];
      }
      b[k] += c * b[i];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = b[i];
    for (let j = i + 1; j < n; j++) {
      x[i] -= A[i][j] * x[j];
    }
    x[i] /= A[i][i];
  }
  return x;
}

/**
 * カメラ上の4点とグリッド上の4点から、射影変換行列(ホモグラフィ)を導出する式！
 */
export function getPerspectiveTransform(src: Point[], dst: Point[]): Mat3 | null {
  const A: number[][] = [];
  const B: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    B.push(v);
  }
  const x = solveLinearSystem(A, B);
  if (!x) return null;
  return { m: [...x, 1] }; // 最後(h22)は1にするルールだよ✨
}

/**
 * 行列を使って点の座標を実際に変換する関数
 */
export function perspectiveTransform(pt: Point, mat: Mat3): Point {
  const m = mat.m;
  const x = pt.x;
  const y = pt.y;
  const w = m[6] * x + m[7] * y + m[8];
  return {
    x: (m[0] * x + m[1] * y + m[2]) / w,
    y: (m[3] * x + m[4] * y + m[5]) / w,
  };
}

export function rgbToHsv(r: number, g: number, b: number): { h: number, s: number, v: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0, s = 0;
  const v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  
  if (max !== min) {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: h * 360, s, v };
}

/**
 * RGBの距離計算！HSVまたは正規化で比較するよ！
 * なんで固定色のRGBをそのまま比較しないの？🤔：
 * カメラだと部屋の照明とかで全体が暗くなったり赤みがかかったりするじゃん？
 * だから「一番近い色」を判定するためには、まずは明るさとかの影響を減らす必要があるの✨
 */
export function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  // RGBのユークリッド距離（絶対的な明るさ・色の差）
  const rgbDist = Math.sqrt(Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2));

  // HSV空間に変換して、人間の直感に近い「色相(Hue)」を中心とした距離も算出！🔥
  const hsv1 = rgbToHsv(r1, g1, b1);
  const hsv2 = rgbToHsv(r2, g2, b2);
  
  // 色相は円環(0-360)なので、最短距離を求めるよ！✨ (0〜1に正規化)
  const dh = Math.min(Math.abs(hsv1.h - hsv2.h), 360 - Math.abs(hsv1.h - hsv2.h)) / 180; 
  const ds = Math.abs(hsv1.s - hsv2.s); // 0〜1
  const dv = Math.abs(hsv1.v - hsv2.v); // 0〜1
  
  // 白黒グレーに近い（彩度が低い）と色相はブレやすいから、彩度(S)で色相の重みを調整！💖
  const sWeight = Math.max(hsv1.s, hsv2.s);
  const hsvDist = Math.sqrt(Math.pow(dh * sWeight * 2, 2) + Math.pow(ds, 2) + Math.pow(dv, 2)) * 255;

  // RGBの物理的な差(40%)と、HSVの直感的な差(60%)をブレンドした最強のハイブリッド距離！✌️
  return rgbDist * 0.4 + hsvDist * 0.6;
}

