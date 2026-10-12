const MAGIC = "QVS1";

export function normalizeVector(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    out[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) {
    out[i] = out[i]! / norm;
  }
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += a[i]! * b[i]!;
  }
  return s;
}

/**
 * バイナリ形式: "QVS1" | uint32 ヘッダ長 | ヘッダJSON {dim,hashes} | float32 × dim × 件数
 * (JSON配列で保存すると1536次元×数千件で数十MBになるため)
 */
export function encodeVectors(vectors: Map<string, Float32Array>): Buffer {
  const hashes = [...vectors.keys()];
  const dim = hashes.length > 0 ? vectors.get(hashes[0]!)!.length : 0;
  const header = Buffer.from(JSON.stringify({ dim, hashes }), "utf8");
  const head = Buffer.alloc(8);
  head.write(MAGIC, 0, "ascii");
  head.writeUInt32LE(header.length, 4);
  const body = Buffer.alloc(hashes.length * dim * 4);
  hashes.forEach((hash, i) => {
    const v = vectors.get(hash)!;
    for (let j = 0; j < dim; j++) {
      body.writeFloatLE(v[j]!, (i * dim + j) * 4);
    }
  });
  return Buffer.concat([head, header, body]);
}

export function decodeVectors(buf: Buffer): Map<string, Float32Array> {
  const result = new Map<string, Float32Array>();
  if (buf.length < 8 || buf.toString("ascii", 0, 4) !== MAGIC) {
    throw new Error("ベクトルファイルの形式が不正です。");
  }
  const headerLength = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString("utf8", 8, 8 + headerLength)) as {
    dim: number;
    hashes: string[];
  };
  let offset = 8 + headerLength;
  if (buf.length < offset + header.hashes.length * header.dim * 4) {
    throw new Error("ベクトルファイルが途中で途切れています。");
  }
  for (const hash of header.hashes) {
    const v = new Float32Array(header.dim);
    for (let j = 0; j < header.dim; j++) {
      v[j] = buf.readFloatLE(offset);
      offset += 4;
    }
    result.set(hash, v);
  }
  return result;
}
