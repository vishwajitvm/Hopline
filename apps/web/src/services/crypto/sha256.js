/**
 * Incremental SHA-256 (hash-wasm). Used instead of WebCrypto because WebCrypto can't hash a stream
 * (a 5 GB file would have to sit in memory) and isn't available on plain-HTTP LAN addresses.
 * The WASM module is loaded on first use, keeping it out of the initial bundle.
 */
let modulePromise = null;
// The SHA-256-only build (~18 KB) instead of the full library (~216 KB). It's UMD, so the factory may sit
// on the namespace or on its default export depending on the bundler/runtime.
const loadModule = () =>
  (modulePromise ??= import('hash-wasm/dist/sha256.umd.min.js').then((mod) => ({
    createSHA256: mod.createSHA256 ?? mod.default?.createSHA256,
  })));

export async function createSha256() {
  const { createSHA256 } = await loadModule();
  const hasher = await createSHA256();
  hasher.init();
  return {
    update(bytes) {
      hasher.update(bytes);
    },
    digest() {
      return hasher.digest('hex');
    },
  };
}

export async function sha256Hex(bytes) {
  const hasher = await createSha256();
  hasher.update(bytes);
  return hasher.digest();
}

/** Feeds bytes [start, end) of a File/Blob into `hasher`, reading `blockBytes` at a time. */
export async function hashBlobRange(blob, start, end, hasher, blockBytes = 8 * 1024 * 1024) {
  for (let pos = start; pos < end; pos += blockBytes) {
    const block = await blob.slice(pos, Math.min(pos + blockBytes, end)).arrayBuffer();
    hasher.update(new Uint8Array(block));
  }
}
