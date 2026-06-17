// SHA-256 over the Web Crypto API — no new dependency. Used to ground a
// published edit on the canonical files (the content-hash half of the conflict
// check, alongside the ETag). Mirrors the tagger's `hash.ts`.

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
