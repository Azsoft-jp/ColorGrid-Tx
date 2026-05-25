// Perfect Constant-First Reed-Solomon in GF(256)
class ReedSolomon {
  private expTable: number[] = new Array(512).fill(0);
  private logTable: number[] = new Array(256).fill(0);

  constructor() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      this.expTable[i] = x;
      this.logTable[x] = i;
      x <<= 1;
      if (x & 0x100) {
        x ^= 0x11d; 
      }
    }
    for (let i = 255; i < 512; i++) {
      this.expTable[i] = this.expTable[i - 255];
    }
  }

  private gfMul(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    return this.expTable[this.logTable[a] + this.logTable[b]];
  }

  private gfDiv(a: number, b: number): number {
    if (a === 0) return 0;
    if (b === 0) throw new Error("GF(256) division by zero");
    let sum = this.logTable[a] - this.logTable[b];
    while (sum < 0) sum += 255;
    return this.expTable[sum];
  }

  private gfInv(a: number): number {
    if (a === 0) throw new Error("GF(256) division by zero");
    return this.expTable[255 - this.logTable[a]];
  }

  public getGenerator(parityBytes: number): Uint8Array {
    let g = new Uint8Array([1]);
    for (let i = 0; i < parityBytes; i++) {
      const alpha_i = this.expTable[i];
      const nextG = new Uint8Array(g.length + 1);
      nextG[0] = this.gfMul(g[0], alpha_i);
      for (let j = 1; j < g.length; j++) {
        nextG[j] = this.gfMul(g[j], alpha_i) ^ g[j - 1];
      }
      nextG[g.length] = g[g.length - 1]; // which is 1
      g = nextG;
    }
    return g;
  }

  encode(data: Uint8Array, parityBytes: number): Uint8Array {
    if (parityBytes === 0) return new Uint8Array(data);
    const g = this.getGenerator(parityBytes);
    
    // Systematic encoding with polynomial division
    const parity = new Uint8Array(parityBytes);
    for (let i = 0; i < data.length; i++) {
      const feedback = data[i] ^ parity[parityBytes - 1]; // highest power term feedback
      for (let j = parityBytes - 1; j > 0; j--) {
        parity[j] = parity[j - 1] ^ this.gfMul(g[j], feedback);
      }
      parity[0] = this.gfMul(g[0], feedback);
    }

    const out = new Uint8Array(data.length + parityBytes);
    out.set(data);
    for (let i = 0; i < parityBytes; i++) {
      out[data.length + i] = parity[parityBytes - 1 - i];
    }
    return out;
  }

  decode(codeword: Uint8Array, parityBytes: number, erasures: number[] = []): Uint8Array | null {
    const codeLen = codeword.length;
    if (parityBytes <= 0) {
      return codeword.slice(0, codeLen - parityBytes);
    }
    if (codeLen > 255) return null;

    const uniqueErasures = Array.from(new Set(erasures)).filter(e => e >= 0 && e < codeLen);
    if (uniqueErasures.length > parityBytes) {
      return null;
    }

    const workCode = new Uint8Array(codeword);
    for (const e of uniqueErasures) {
      workCode[e] = 0;
    }

    // 1. Syndrome calculation
    const syndromes = new Uint8Array(parityBytes);
    let hasError = false;
    for (let j = 0; j < parityBytes; j++) {
      let s = 0;
      const alpha_j = this.expTable[j];
      for (let i = 0; i < codeLen; i++) {
        s = this.gfMul(s, alpha_j) ^ workCode[i];
      }
      syndromes[j] = s;
      if (s !== 0) {
        hasError = true;
      }
    }

    if (!hasError && uniqueErasures.length === 0) {
      return workCode.slice(0, codeLen - parityBytes);
    }

    // Adjust syndromes for erasures first if any
    let lambda = new Uint8Array([1]);
    for (const e of uniqueErasures) {
      const Y_e = this.expTable[codeLen - 1 - e];
      const nextL = new Uint8Array(lambda.length + 1);
      nextL[0] = lambda[0];
      for (let i = 1; i < lambda.length; i++) {
        nextL[i] = lambda[i] ^ this.gfMul(Y_e, lambda[i - 1]);
      }
      nextL[lambda.length] = this.gfMul(Y_e, lambda[lambda.length - 1]);
      lambda = nextL;
    }

    // 2. Berlekamp-Massey
    let b = new Uint8Array(lambda);
    let L = uniqueErasures.length;
    let x = 1;

    for (let r = uniqueErasures.length; r < parityBytes; r++) {
      let d = syndromes[r];
      for (let i = 1; i < lambda.length; i++) {
        d ^= this.gfMul(lambda[i], syndromes[r - i]);
      }

      if (d === 0) {
        x++;
      } else {
        const oldLambda = new Uint8Array(lambda);
        const nextLen = Math.max(lambda.length, b.length + x);
        const nextLambda = new Uint8Array(nextLen);
        nextLambda.set(lambda);
        for (let i = 0; i < b.length; i++) {
          nextLambda[i + x] ^= this.gfMul(b[i], d);
        }

        if (2 * L <= r) {
          L = r + 1 - L;
          b = new Uint8Array(oldLambda.length);
          const invD = this.gfInv(d);
          for (let i = 0; i < oldLambda.length; i++) {
            b[i] = this.gfMul(oldLambda[i], invD);
          }
          x = 1;
        } else {
          x++;
        }
        lambda = nextLambda;
      }
    }

    // Trim trailing zeros from lambda
    let lambdaLen = lambda.length;
    while (lambdaLen > 0 && lambda[lambdaLen - 1] === 0) {
      lambdaLen--;
    }
    lambda = lambda.slice(0, lambdaLen);

    // 4. Chien Search
    const errors: number[] = [];
    const deg = lambda.length - 1;
    if (deg > L) {
      return null;
    }

    for (let i = 0; i < codeLen; i++) {
      const invX = this.expTable[(255 - (codeLen - 1 - i)) % 255];
      let val = 0;
      for (let j = lambda.length - 1; j >= 0; j--) {
        val = this.gfMul(val, invX) ^ lambda[j];
      }
      if (val === 0) {
        errors.push(i);
      }
    }

    if (errors.length !== deg) {
      return null;
    }

    // 5. Forney Algorithm
    const omega = new Uint8Array(parityBytes);
    for (let i = 0; i < parityBytes; i++) {
      let sum = 0;
      for (let j = 0; j <= i; j++) {
        const lambdaCoeff = j < lambda.length ? lambda[j] : 0;
        const syndCoeff = syndromes[i - j];
        sum ^= this.gfMul(lambdaCoeff, syndCoeff);
      }
      omega[i] = sum;
    }

    for (const pos of errors) {
      const X_i = this.expTable[codeLen - 1 - pos];
      const invX_i = this.expTable[(255 - (codeLen - 1 - pos)) % 255];

      let num = 0;
      for (let j = omega.length - 1; j >= 0; j--) {
        num = this.gfMul(num, invX_i) ^ omega[j];
      }

      let denom = 0;
      for (let j = 1; j < lambda.length; j += 2) {
        denom ^= this.gfMul(lambda[j], this.expTable[(j - 1) * (255 - (codeLen - 1 - pos)) % 255]);
      }

      if (denom === 0) {
        return null;
      }

      const errVal = this.gfMul(X_i, this.gfDiv(num, denom));
      workCode[pos] ^= errVal;
    }

    // Double check syndromes
    let doubleCheckOk = true;
    for (let j = 0; j < parityBytes; j++) {
      let s = 0;
      const alpha_j = this.expTable[j];
      for (let i = 0; i < codeLen; i++) {
        s = this.gfMul(s, alpha_j) ^ workCode[i];
      }
      if (s !== 0) {
        doubleCheckOk = false;
        break;
      }
    }

    if (!doubleCheckOk) {
      return null;
    }

    return workCode.slice(0, codeLen - parityBytes);
  }
}

const rs = new ReedSolomon();
const data = new Uint8Array([199, 82, 0, 0, 0, 123, 16, 86, 192, 221, 243, 124]);
const encoded = rs.encode(data, 12);
console.log("Encoded:", Array.from(encoded).map(x => x.toString(16).padStart(2, '0')).join(' '));
const decoded = rs.decode(encoded, 12);
console.log("Decoded:", decoded ? Array.from(decoded).map(x => x.toString(16).padStart(2, '0')).join(' ') : "FAILED");

const corrupt = new Uint8Array(encoded);
corrupt[3] ^= 42;
corrupt[8] ^= 111;
const solved = rs.decode(corrupt, 12);
console.log("Corrupt dec:", solved ? Array.from(solved).map(x => x.toString(16).padStart(2, '0')).join(' ') : "FAILED");
