import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStore } from '../store';
import { formatBytes } from '../lib/scanFiles';

const ROW = 44;

export function FileList() {
  const files = useStore((s) => s.files);
  const removeFile = useStore((s) => s.removeFile);
  const parentRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW,
    overscan: 12,
  });

  // Keep the active row in view as J/K moves it.
  useEffect(() => {
    if (active < files.length) virtualizer.scrollToIndex(active, { align: 'auto' });
  }, [active, files.length, virtualizer]);

  // Clamp when the batch shrinks (e.g. after D drops a row).
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
      <div className="grid grid-cols-[44px_1fr_120px] items-center gap-3 px-3 h-9 border-b border-rule font-[600] text-[11px] tracking-[0.16em] uppercase text-inkSoft">
        <span aria-hidden />
        <span>File</span>
        <span className="text-right">Size</span>
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
            const isActive = vi.index === active;
            return (
              <div
                key={f.id}
                onClick={() => setActive(vi.index)}
                className={`absolute left-0 right-0 grid grid-cols-[44px_1fr_120px] items-center gap-3 px-3 border-b border-ruleSoft cursor-default ${
                  isActive ? 'bg-mark' : 'hover:bg-panelHover'
                }`}
                style={{ height: ROW, transform: `translateY(${vi.start}px)` }}
              >
                {/* Thumbnail placeholder — real thumbnails arrive in P1. */}
                <span className="w-8 h-8 bg-paperHover border border-ruleSoft" aria-hidden />
                <span className="min-w-0 truncate font-mono text-[13px] text-ink" title={f.relPath}>
                  {f.relPath}
                </span>
                <span className="text-right font-mono text-[13px] text-inkSoft">
                  {formatBytes(f.size)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
