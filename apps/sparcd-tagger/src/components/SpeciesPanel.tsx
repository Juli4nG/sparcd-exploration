import { useMemo, type RefObject } from 'react';
import Fuse from 'fuse.js';
import type { Species } from '../lib/species';
import type { AppliedTag } from '../lib/drafts';
import { GHOST } from '../lib/drafts';

// The species selector. Persistent, scrollable, browsable — not only a
// type-to-filter popover — because volunteers scan to recognize a species.
// Each row carries an example thumbnail, common + scientific name, and its
// assigned key (a kbd badge with an assign affordance). Recent species this
// session float to the top; that affects ordering only, never key assignment.

export type SpeciesPanelProps = {
  species: Species[];
  count: number;
  onCountChange: (n: number) => void;
  onApply: (tag: AppliedTag) => void;
  filter: string;
  onFilterChange: (v: string) => void;
  filterRef: RefObject<HTMLInputElement>;
  bindingFor: (scientificName: string) => string | null;
  capturingFor: string | null;
  onStartCapture: (scientificName: string) => void;
  onClearKey: (scientificName: string) => void;
  recent: string[]; // scientificNames, most-recent first
  currentLabel: string; // applied label on the focused image, for highlight
  selectionCount: number; // >0 → applying a species hits the whole selection
  disabled: boolean; // no image focused
};

const GHOST_KEY = 'G';

export function SpeciesPanel(props: SpeciesPanelProps) {
  const { species, filter } = props;

  const fuse = useMemo(
    () =>
      new Fuse(species, {
        keys: ['commonName', 'scientificName'],
        threshold: 0.34,
        ignoreLocation: true,
      }),
    [species],
  );

  const ordered = useMemo(() => {
    const base = filter.trim() ? fuse.search(filter.trim()).map((r) => r.item) : species;
    if (!props.recent.length) return base;
    const rank = new Map(props.recent.map((s, i) => [s, i]));
    // Stable float: recents to the top in recency order, everything else as-is.
    return [...base].sort((a, b) => {
      const ra = rank.has(a.scientificName) ? rank.get(a.scientificName)! : Infinity;
      const rb = rank.has(b.scientificName) ? rank.get(b.scientificName)! : Infinity;
      return ra - rb;
    });
  }, [species, filter, fuse, props.recent]);

  const trimmed = filter.trim();
  const exact = species.some(
    (s) => s.commonName.toLowerCase() === trimmed.toLowerCase() || s.scientificName.toLowerCase() === trimmed.toLowerCase(),
  );

  return (
    <div className="h-full flex flex-col border-l border-rule bg-panel min-h-0">
      {props.selectionCount > 1 && (
        <div className="px-3 py-1.5 bg-mark border-b border-rule text-[12px] font-mono text-accent">
          Applying to {props.selectionCount} selected images
        </div>
      )}
      <div className="p-3 border-b border-rule space-y-3">
        <input
          ref={props.filterRef}
          value={filter}
          onChange={(e) => props.onFilterChange(e.target.value)}
          placeholder="Filter species…  (Space)"
          className="w-full bg-paper border border-rule px-3 py-2 text-[14px] font-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
          autoComplete="off"
          spellCheck={false}
          aria-label="Filter species"
        />
        <label className="flex items-center gap-2 text-[13px] font-body text-inkSoft">
          Count
          <input
            type="number"
            min={1}
            value={props.count}
            onChange={(e) => props.onCountChange(Math.max(1, Number(e.target.value) || 1))}
            className="w-20 bg-paper border border-rule px-2 py-1 text-[14px] font-mono text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Ghost — a built-in label, shown as a text chip not a photo. */}
        <Row
          chip="◯ Ghost"
          common="Ghost"
          scientific="empty / false-trigger"
          badge={GHOST_KEY}
          active={props.currentLabel === GHOST.label}
          disabled={props.disabled}
          onApply={() => props.onApply({ label: GHOST.label, commonName: GHOST.commonName, count: props.count })}
        />

        {ordered.map((s) => (
          <Row
            key={s.key}
            iconUrl={s.iconUrl}
            common={s.commonName}
            scientific={s.scientificName}
            badge={props.bindingFor(s.scientificName)}
            capturing={props.capturingFor === s.scientificName}
            active={props.currentLabel === s.scientificName}
            disabled={props.disabled}
            onApply={() => props.onApply({ label: s.scientificName, commonName: s.commonName, count: props.count })}
            onStartCapture={() => props.onStartCapture(s.scientificName)}
            onClearKey={props.bindingFor(s.scientificName) ? () => props.onClearKey(s.scientificName) : undefined}
          />
        ))}

        {trimmed && !exact && (
          <Row
            chip="✛ Request"
            common={`Tag as requested species`}
            scientific={`“${trimmed}” → [REQUESTED_SPECIES]`}
            disabled={props.disabled}
            onApply={() =>
              props.onApply({ label: trimmed, commonName: '', count: props.count, requestedSpecies: trimmed })
            }
          />
        )}

        {!ordered.length && !trimmed && (
          <p className="p-4 text-[13px] text-inkMute font-body">No species in the vocabulary.</p>
        )}
      </div>
    </div>
  );
}

type RowProps = {
  iconUrl?: string;
  chip?: string;
  common: string;
  scientific: string;
  badge?: string | null;
  capturing?: boolean;
  active?: boolean;
  disabled: boolean;
  onApply: () => void;
  onStartCapture?: () => void;
  onClearKey?: () => void;
};

function Row(p: RowProps) {
  return (
    <div
      className={`group flex items-center gap-3 px-3 py-2 border-b border-ruleSoft ${
        p.active ? 'bg-mark' : 'hover:bg-panelHover'
      }`}
    >
      <button
        onClick={p.onApply}
        disabled={p.disabled}
        className="flex items-center gap-3 flex-1 min-w-0 text-left disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent -outline-offset-2"
        title={p.disabled ? 'Focus an image first' : `Apply ${p.common}`}
      >
        {p.iconUrl ? (
          <img
            src={p.iconUrl}
            alt=""
            loading="lazy"
            className="w-10 h-10 object-cover border border-rule bg-paperHover shrink-0"
          />
        ) : (
          <span className="w-10 h-10 grid place-items-center border border-rule bg-paperHover text-[10px] font-mono text-inkMute shrink-0">
            {p.chip ?? '—'}
          </span>
        )}
        <span className="min-w-0">
          <span className="block text-[14px] text-ink truncate">{p.common}</span>
          <span className="block text-[12px] text-inkMute font-mono italic truncate">{p.scientific}</span>
        </span>
      </button>

      <div className="flex items-center gap-1.5 shrink-0">
        {p.capturing ? (
          <span className="text-[11px] font-mono text-accent animate-pulse">press a key…</span>
        ) : p.badge ? (
          <kbd className="px-1.5 h-5 min-w-5 grid place-items-center border border-ink text-[11px] font-mono uppercase text-ink">
            {p.badge}
          </kbd>
        ) : null}
        {p.onStartCapture && !p.capturing && (
          <button
            onClick={p.onStartCapture}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-[11px] font-mono text-inkSoft hover:text-ink underline decoration-dotted focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            title="Assign a key to this species"
          >
            {p.badge ? 'rebind' : 'assign key'}
          </button>
        )}
        {p.onClearKey && !p.capturing && (
          <button
            onClick={p.onClearKey}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-[11px] font-mono text-inkMute hover:text-warn"
            title="Clear this key"
            aria-label={`Clear key for ${p.common}`}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
