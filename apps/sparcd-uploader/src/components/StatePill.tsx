export type UploadState =
  | 'ready'
  | 'uploading'
  | 'publishing'
  | 'complete'
  | 'failed'
  | 'dry-run';

// Distinct by shape + glyph, not color alone (design requirement).
const config: Record<UploadState, { label: string; glyph: string; cls: string }> = {
  ready: { label: 'ready', glyph: '○', cls: 'border-rule text-inkSoft' },
  uploading: { label: 'uploading…', glyph: '↑', cls: 'border-accent text-accent' },
  publishing: { label: 'publishing…', glyph: '⇡', cls: 'border-accent text-accent' },
  complete: { label: 'complete', glyph: '●', cls: 'border-ok text-ok' },
  failed: { label: 'failed', glyph: '✕', cls: 'border-warn text-warn' },
  'dry-run': { label: 'dry-run', glyph: '◇', cls: 'border-warn text-warn' },
};

export function StatePill({ state }: { state: UploadState }) {
  const c = config[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 border px-2.5 py-1 font-mono text-[12px] leading-none ${c.cls}`}
    >
      <span aria-hidden>{c.glyph}</span>
      {c.label}
    </span>
  );
}
