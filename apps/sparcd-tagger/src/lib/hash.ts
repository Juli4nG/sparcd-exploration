// SHA-256 over the Web Crypto API — no new dependency. Used to ground drafts on
// canonical files and to record the intended hash of each object in the sync
// journal, so a resumed sync can verify an already-written object by content.

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  // `crypto.subtle.digest` takes a `BufferSource`; the lib's generic
  // `Uint8Array<ArrayBufferLike>` doesn't narrow to it, so cast — the bytes are
  // always a plain (non-shared) buffer here.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
