/**
 * GF(256)でのシンプルなRS(Reed-Solomon)エンコーダ！
 * 要件通り、外部ライブラリなしのスクラッチ実装だよ✨
 */
export class ReedSolomon {
  private expTable: number[] = new Array(512).fill(0);
  private logTable: number[] = new Array(256).fill(0);

  constructor() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      this.expTable[i] = x;
      this.logTable[x] = i;
      x <<= 1;
      // 原始多項式 0x11d を使うよ！
      if (x & 0x100) {
        x ^= 0x11d; 
      }
    }
    for (let i = 255; i < 512; i++) {
      this.expTable[i] = this.expTable[i - 255];
    }
  }

  encode(data: Uint8Array, parityBytes: number): Uint8Array {
    if (parityBytes === 0) return new Uint8Array(data);
    
    let g = new Uint8Array([1]);
    for (let i = 0; i < parityBytes; i++) {
      const nextG = new Uint8Array(g.length + 1);
      nextG[0] = this.gfMul(g[0], this.expTable[i % 255]);
      for (let j = 1; j < g.length; j++) {
        nextG[j] = g[j - 1] ^ this.gfMul(g[j], this.expTable[i % 255]);
      }
      nextG[g.length] = g[g.length - 1];
      g = nextG;
    }

    const codeword = new Uint8Array(data.length + parityBytes);
    codeword.set(data);
    for (let i = 0; i < data.length; i++) {
      const coef = codeword[i];
      if (coef !== 0) {
        for (let j = 0; j < g.length; j++) {
          codeword[i + j] ^= this.gfMul(g[j], coef);
        }
      }
    }
    
    const out = new Uint8Array(data.length + parityBytes);
    out.set(data);
    out.set(codeword.slice(data.length), data.length);
    return out;
  }

  decode(codeword: Uint8Array, parityBytes: number): Uint8Array | null {
    // TODO: フルなSyndrome計算, Berlekamp-Massey, Chien Search, Forney Algorithmの実装
    // 今回はMVP要件に従い破損検出はCRC32に委ね、破損があればチャンク再取得とする構成にするよ！
    // ひとまずパリティ部分を切り離してデータ本体だけ返すね🥺 いまはエラー訂正まではしてないみ！
    return codeword.slice(0, codeword.length - parityBytes);
  }

  private gfMul(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    return this.expTable[this.logTable[a] + this.logTable[b]];
  }
}
