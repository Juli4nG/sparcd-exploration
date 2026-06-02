import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStore, type FileEntry } from '../store';
import { formatBytes } from '../lib/scanFiles';
import type { FileValidation, Severity } from '../lib/validation';

const ROW = 52;
const COLS = 'grid-cols-[44px_1fr_150px_92px_84px_128px]';

const SEVERITY_DOT: Record<Severity, string> = {
  ok: 'bg-ok',
  warning: 'bg-warn',
  error: 'bg-warn',
};

function shortTime(iso?: string): string {
  if (!iso) return '—';
  // Render the EXIF instant without imposing a timezone shift on the display.
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');
}

function Thumb({ blob }: { blob?: Blob }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  if (url) {
    return <img src={url} alt="" className="w-9 h-9 object-cover border border-ruleSoft" />;
  }
  return <span className="w-9 h-9 bg-paperHover border border-ruleSoft block" aria-hidden />;
}

function StatusCell({ entry, validation }: { entry: FileEntry; validation?: FileValidation }) {
  if (entry.processState === 'queued') return <span className="text-inkMute text-[12px]">Queued</span>;
  if (entry.processState === 'processing')
    return <span className="text-inkSoft text-[12px]">Processing…</span>;

  const v = validation ?? { severity: 'ok' as Severity, issues: [] };
  const label =
    v.severity === 'error' ? 'Needs attention' : v.severity === 'warning' ? 'Warning' : 'OK';
  const title = v.issues.map((i) => i.message).join('; ') || 'Valid';
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-inkSoft" title={title}>
      <span className={`w-2 h-2 rounded-full ${SEVERITY_DOT[v.severity]}`} aria-hidden />
      {label}
    </span>
  );
}

function Row({
  entry,
  validation,
  active,
  onSelect,
}: {
  entry: FileEntry;
  validation?: FileValidation;
  active: boolean;
  onSelect: () => void;
}) {
  const dims = entry.width && entry.height ? `${entry.width}×${entry.height}` : '—';
  return (
    <div
      onClick={onSelect}
      className={`grid ${COLS} items-center gap-3 px-3 h-full border-b border-ruleSoft cursor-default ${
        active ? 'bg-mark' : 'hover:bg-panelHover'
      }`}
    >
      <Thumb blob={entry.thumbnail} />
      <span className="min-w-0">
        <span className="block truncate font-mono text-[13px] text-ink" title={entry.relPath}>
          {entry.fileName}
        </span>
        <span
          className="block truncate font-mono text-[11px] text-inkMute"
          title={entry.sha256 ? `sha256:${entry.sha256}` : undefined}
        >
          {entry.exifCamera ?? (entry.sha256 ? `${entry.sha256.slice(0, 12)}…` : entry.relPath)}
        </span>
      </span>
      <span className="font-mono text-[12px] text-inkSoft truncate" title={entry.exifTimestamp}>
        {shortTime(entry.exifTimestamp)}
      </span>
      <span className="font-mono text-[12px] text-inkSoft text-right">{dims}</span>
      <span className="font-mono text-[12px] text-inkSoft text-right">{formatBytes(entry.size)}</span>
      <span className="justify-self-start">
        <StatusCell entry={entry} validation={validation} />
      </span>
    </div>
  );
}

export function FileList() {
  const files = useStore((s) => s.files);
  const validations = useStore((s) => s.validations);
  const removeFile = useStore((s) => s.removeFile);
  const parentRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW,
    overscan: 12,
  });

  useEffect(() => {
    if (active < files.length) virtualizer.scrollToIndex(active, { align: 'auto' });
  }, [active, files.length, virtualizer]);

  useEffect(() => {
    if (active >= files.length && files.length > 0) setActive(files.length - 1);
  }, [files.length, active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, files.length - 1));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'd' && files.length > 0) {
      e.preventDefault();
      removeFile(files[active].id);
    }
  }

  return (
    <div className="border border-rule bg-panel">
      <div
        className={`grid ${COLS} items-center gap-3 px-3 h-9 border-b border-rule font-[600] text-[11px] tracking-[0.16em] uppercase text-inkSoft`}
      >
        <span aria-hidden />
        <span>File</span>
        <span>Timestamp</span>
        <span className="text-right">Pixels</span>
        <span className="text-right">Size</span>
        <span>Status</span>
      </div>

      <div
        ref={parentRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label="Scanned files. J and K move, D drops the active file."
        className="h-[60vh] overflow-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent -outline-offset-2"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const f = files[vi.index];
            return (
              <div
                key={f.id}
                className="absolute left-0 right-0"
                style={{ height: ROW, transform: `translateY(${vi.start}px)` }}
              >
                <Row
                  entry={f}
                  validation={validations[f.id]}
                  active={vi.index === active}
                  onSelect={() => setActive(vi.index)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
