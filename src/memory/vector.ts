const DEFAULT_DIMENSIONS = 384;

/**
 * A deterministic, offline feature-hash vector. It deliberately avoids network
 * calls and model downloads. This is useful for fuzzy/morphological similarity,
 * but it must not be represented as a learned semantic embedding.
 */
export function localTextVector(text: string, dimensions = DEFAULT_DIMENSIONS): Float32Array {
  if (!Number.isInteger(dimensions) || dimensions < 64 || dimensions > 4_096) {
    throw new Error("Vector dimensions must be an integer between 64 and 4096");
  }
  const normalized = normalizeText(text);
  const words = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  const vector = new Float32Array(dimensions);
  for (const word of words) {
    addFeature(vector, `w:${word}`, 1.6);
    const wrapped = `^${word}$`;
    for (let index = 0; index + 2 < wrapped.length; index += 1) {
      addFeature(vector, `c:${wrapped.slice(index, index + 3)}`, 0.45);
    }
  }
  for (let index = 0; index + 1 < words.length; index += 1) {
    addFeature(vector, `b:${words[index]}_${words[index + 1]}`, 0.8);
  }
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  magnitude = Math.sqrt(magnitude);
  if (magnitude > 0) {
    for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] ?? 0) / magnitude;
  }
  return vector;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += (left[index] ?? 0) * (right[index] ?? 0);
  return Math.max(-1, Math.min(1, score));
}

export function encodeVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function decodeVector(value: unknown, dimensions = DEFAULT_DIMENSIONS): Float32Array | undefined {
  if (!(value instanceof Uint8Array) || value.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) return undefined;
  const copy = Uint8Array.from(value);
  return new Float32Array(copy.buffer);
}

export function vectorModelName(dimensions = DEFAULT_DIMENSIONS): string {
  return `local-feature-hash-v1:${dimensions}`;
}

export function defaultVectorDimensions(): number {
  return DEFAULT_DIMENSIONS;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function addFeature(vector: Float32Array, feature: string, weight: number): void {
  const first = fnv1a(feature);
  const second = fnv1a(`sign:${feature}`);
  const index = first % vector.length;
  vector[index] = (vector[index] ?? 0) + (second & 1 ? weight : -weight);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
