// Best-effort video poster, main-thread only. A Worker can't decode MP4 frames
// (createImageBitmap doesn't accept video, and <video> needs the DOM), so the
// poster is captured here after the worker hashes the file. Any failure resolves
// `undefined` — the file list renders a typed placeholder tile instead, and
// validation never requires a poster.

export async function posterFor(file: File): Promise<Blob | undefined> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'metadata';
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      // `preload='metadata'` is not required to ever fire `loadeddata`, so wait on
      // `loadedmetadata` (duration + dimensions); the seek below forces the target
      // frame to load and fires `onseeked`. Waiting on `loadeddata` here can hang
      // forever — leaking the blob URL since `finally` would never run.
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('video decode failed'));
    });
    // A frame near the start, but past 0 so it isn't a black lead-in.
    const seekTo = Math.min(0.1, (video.duration || 0) / 2);
    await new Promise<void>((resolve, reject) => {
      video.onseeked = () => resolve();
      video.onerror = () => reject(new Error('seek failed'));
      video.currentTime = seekTo;
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1;
    canvas.height = video.videoHeight || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | undefined>((resolve) =>
      canvas.toBlob((b) => resolve(b ?? undefined), 'image/jpeg', 0.7),
    );
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}
