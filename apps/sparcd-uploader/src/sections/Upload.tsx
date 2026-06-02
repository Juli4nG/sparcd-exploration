import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStore } from '../store';
import { useLocations } from '../lib/useLocations';
import { useCollections } from '../lib/useCollections';
import { sanitizeUploaderUser } from '../lib/normalize';
import { isWriteEnabled } from '../lib/s3';
import { formatBytes } from '../lib/scanFiles';
import { runUpload, type FileState, type UploadRun, type UploadSnapshot } from '../lib/upload';

const sectionLabel = 'font-[600] text-[11px] tracking-[0.16em] uppercase text-inkSoft mb-2';

const STATE_DOT: Record<FileState, string> = {
  pending: 'bg-ruleSoft',
  uploading: 'bg-accent',
  verifying: 'bg-accent',
  done: 'bg-ok',
  skipped: 'bg-warn',
  failed: 'bg-warn',
};

const ROW = 40;

function Note({ message, tone = 'mute' }: { message: string; tone?: 'mute' | 'warn' }) {
  return (
    <div
      className={`border px-3 py-2.5 font-body text-[13px] ${
        tone === 'warn'
          ? 'border-warn/40 text-warn bg-paper'
          : 'border-ruleSoft text-inkSoft bg-paper'
      }`}
    >
      {message}
    </div>
  );
}

function ProgressList({ snap }: { snap: UploadSnapshot }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const files = snap.files;
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW,
    overscan: 12,
  });

  return (
    <div ref={parentRef} className="h-[44vh] overflow-auto border border-rule bg-panel">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const f = files[vi.index];
          const pct = f.size > 0 ? Math.min(100, (f.loaded / f.size) * 100) : 100;
          const tail = f.key.slice(f.key.lastIndexOf('/') + 1);
          return (
            <div
              key={f.id}
              className="absolute left-0 right-0 grid grid-cols-[14px_1fr_120px_72px] items-center gap-3 px-3 border-b border-ruleSoft"
              style={{ height: ROW, transform: `translateY(${vi.start}px)` }}
            >
              <span
                className={`w-2 h-2 rounded-full ${STATE_DOT[f.state]}`}
                title={f.error ?? f.state}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block truncate font-mono text-[12px] text-ink" title={f.key}>
                  {tail}
                </span>
                {f.error && (
                  <span className="block truncate font-body text-[11px] text-warn" title={f.error}>
                    {f.error}
                  </span>
                )}
              </span>
              <span className="h-1.5 bg-paperHover border border-ruleSoft overflow-hidden">
                <span
                  className={`block h-full ${f.state === 'failed' ? 'bg-warn' : 'bg-accent'}`}
                  style={{ width: `${f.state === 'done' || f.state === 'skipped' ? 100 : pct}%` }}
                />
              </span>
              <span className="font-mono text-[11px] text-inkSoft text-right">
                {f.state === 'uploading' || f.state === 'verifying'
                  ? `${Math.round(pct)}%`
                  : f.state}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const LOG_TONE = {
  put: 'text-inkSoft',
  info: 'text-inkSoft',
  warn: 'text-warn',
  error: 'text-warn',
} as const;

function LogPanel({ snap }: { snap: UploadSnapshot }) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the newest line in view as the run progresses.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.version]);

  const tail = snap.log.slice(-400);
  return (
    <div
      ref={ref}
      className="h-[26vh] overflow-auto border border-ruleSoft bg-paper px-3 py-2 font-mono text-[11.5px] leading-[1.55]"
    >
      {tail.map((l, i) => (
        <div key={i} className={`break-all ${LOG_TONE[l.kind]}`}>
          {l.kind === 'put' ? '· ' : ''}
          {l.text}
        </div>
      ))}
      {snap.log.length === 0 && <span className="text-inkMute">No activity yet.</span>}
    </div>
  );
}

export function Upload() {
  const s3Config = useStore((s) => s.s3Config);
  const setStep = useStore((s) => s.setStep);
  const files = useStore((s) => s.files);
  const uploaderUser = useStore((s) => s.uploaderUser);
  const description = useStore((s) => s.uploadDescription);
  const selectedLocationKey = useStore((s) => s.selectedLocationKey);
  const selectedBucket = useStore((s) => s.selectedBucket);
  const dryRun = useStore((s) => s.dryRun);
  const setDryRun = useStore((s) => s.setDryRun);
  const concurrency = useStore((s) => s.uploadConcurrency);
  const setConcurrency = useStore((s) => s.setUploadConcurrency);
  const nextBatch = useStore((s) => s.nextBatch);

  const { data: locData } = useLocations(s3Config);
  const collections = useCollections(s3Config);

  const slug = sanitizeUploaderUser(uploaderUser);
  const location = locData?.locations.find((l) => l.key === selectedLocationKey) ?? null;
  const collection = collections.data?.find((c) => c.bucket === selectedBucket) ?? null;
  const writeEnabled = !!selectedBucket && isWriteEnabled(selectedBucket);
  const effectiveDryRun = dryRun || !writeEnabled;

  const [snap, setSnap] = useState<UploadSnapshot | null>(null);
  const runRef = useRef<UploadRun | null>(null);
  const running = snap?.phase === 'blobs' || snap?.phase === 'metadata';

  // Abandon an in-flight run if the step unmounts.
  useEffect(() => () => runRef.current?.cancel(), []);

  const ready = useMemo(() => files.filter((f) => f.processState === 'ready' && f.sha256), [files]);

  const start = () => {
    if (!s3Config || !location || !collection || !slug) return;
    const run = runUpload(
      {
        config: s3Config,
        dryRun: effectiveDryRun,
        concurrency,
        build: {
          location,
          collectionUuid: collection.uuid,
          bucket: collection.bucket,
          uploaderSlug: slug,
          description,
          files,
        },
      },
      setSnap,
    );
    runRef.current = run;
  };

  if (!location || !collection || !slug) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Note
          tone="warn"
          message="Missing a deployment, target collection, or uploader identity. Go back to Assign."
        />
        <button
          onClick={() => setStep('assign')}
          className="border border-ink text-ink px-3.5 py-1.5 text-[14px] font-body hover:bg-paperHover"
        >
          Back
        </button>
      </div>
    );
  }

  const counts = snap
    ? snap.files.reduce(
        (a, f) => ((a[f.state] = (a[f.state] ?? 0) + 1), a),
        {} as Record<FileState, number>,
      )
    : null;
  const pct = snap && snap.totalBytes > 0 ? (snap.uploadedBytes / snap.totalBytes) * 100 : 0;

  return (
    <div className="max-w-2xl mx-auto space-y-7">
      {/* Run configuration */}
      <section className="space-y-3">
        <h2 className={sectionLabel}>Upload</h2>
        <p className="font-body text-[13px] text-inkSoft">
          {ready.length} file{ready.length === 1 ? '' : 's'} ·{' '}
          {formatBytes(ready.reduce((n, f) => n + f.size, 0))} →{' '}
          <span className="font-mono text-ink break-all">
            {collection.bucket}/Collections/{collection.uuid}/Uploads/
          </span>
        </p>

        <label className="flex items-center gap-2.5 font-body text-[14px] text-ink">
          <input
            type="checkbox"
            checked={effectiveDryRun}
            disabled={!writeEnabled || running}
            onChange={(e) => setDryRun(e.target.checked)}
            className="accent-accent"
          />
          Dry run — log every PUT, write nothing
        </label>

        {!writeEnabled && (
          <Note
            tone="warn"
            message={`Wet uploads are disabled for "${collection.bucket}". Add it to VITE_S3_WRITE_BUCKETS only after the P4 review gates (s3-safe + upload-sequence review, live bucket lifecycle rule for incomplete multipart uploads, and the multipart-write CORS preflight). Dry run is forced until then.`}
          />
        )}

        <div className="flex items-center gap-3">
          <label className="font-body text-[13px] text-inkSoft w-28">Concurrency</label>
          <input
            type="range"
            min={4}
            max={16}
            value={concurrency}
            disabled={running}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            className="flex-1 accent-accent"
          />
          <span className="font-mono text-[13px] text-ink w-8 text-right">{concurrency}</span>
        </div>
      </section>

      {/* Live run */}
      {snap && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <p className="font-body text-[13px] text-inkSoft">
              <span className="font-mono text-ink uppercase tracking-[0.12em] text-[11px]">
                {snap.phase}
              </span>
              {snap.dryRun && <span className="ml-2 text-warn">dry run</span>}
              {counts && (
                <>
                  {' · '}
                  <span className="font-mono text-ok">{counts.done ?? 0}</span> done
                  {counts.skipped ? (
                    <>
                      {' · '}
                      <span className="font-mono text-warn">{counts.skipped}</span> skipped
                    </>
                  ) : null}
                  {counts.failed ? (
                    <>
                      {' · '}
                      <span className="font-mono text-warn">{counts.failed}</span> failed
                    </>
                  ) : null}
                </>
              )}
            </p>
            <p className="font-mono text-[12px] text-inkSoft">
              {formatBytes(snap.uploadedBytes)} / {formatBytes(snap.totalBytes)}
            </p>
          </div>

          <div className="h-2 bg-paperHover border border-ruleSoft overflow-hidden">
            <span
              className={`block h-full ${snap.phase === 'error' ? 'bg-warn' : 'bg-accent'}`}
              style={{ width: `${snap.phase === 'done' ? 100 : pct}%` }}
            />
          </div>

          {snap.phase === 'done' && (
            <Note
              message={
                snap.dryRun
                  ? `Dry run complete — ${snap.files.length} files would publish under ${snap.uploadPath}/. Nothing was written.`
                  : `Published ${snap.files.length} files under ${snap.uploadPath}/. Bundle hash ${snap.metadataBundleSha256?.slice(0, 16)}…`
              }
            />
          )}
          {snap.phase === 'error' && <Note tone="warn" message={snap.error ?? 'Upload failed.'} />}

          <ProgressList snap={snap} />
          <LogPanel snap={snap} />
        </section>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between gap-4 border-t border-ruleSoft pt-5">
        <button
          onClick={() => setStep('assign')}
          disabled={running}
          className={`border border-ink text-ink px-3.5 py-1.5 text-[14px] font-body hover:bg-paperHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
            running ? 'opacity-40 cursor-not-allowed' : ''
          }`}
        >
          Back
        </button>

        <div className="flex items-center gap-2">
          {running ? (
            <button
              onClick={() => runRef.current?.cancel()}
              className="border border-warn text-warn px-3.5 py-1.5 text-[14px] font-body hover:bg-paperHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            >
              Cancel
            </button>
          ) : snap?.phase === 'done' && !snap.dryRun ? (
            <button
              onClick={() => {
                setSnap(null);
                nextBatch();
              }}
              className="bg-ink text-paper border border-ink px-3.5 py-1.5 text-[14px] font-body font-[600] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            >
              Next batch
            </button>
          ) : (
            <button
              onClick={start}
              className="bg-ink text-paper border border-ink px-3.5 py-1.5 text-[14px] font-body font-[600] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            >
              {effectiveDryRun ? 'Start dry run' : 'Start upload'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
