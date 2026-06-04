import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore } from '../store';
import { useTagImages, useSpecies } from '../lib/queries';
import { parseCollectionKey, presignImage } from '../lib/s3';
import { Thumb } from '../components/Thumb';
import { SpeciesPanel } from '../components/SpeciesPanel';
import { Cheatsheet } from '../components/Cheatsheet';
import { groupBursts, type Burst, type BurstGrouping } from '../lib/bursts';
import {
  useDraftStore,
  dirtyCount,
  GHOST,
  type AppliedTag,
  type TagTarget,
  type UploadCtx,
} from '../lib/drafts';
import { useKeyBindings, effectiveKey, normalizeJavaKeyCode } from '../lib/keys';
import type { Species } from '../lib/species';
import type { TagImage } from '../lib/workspace';
import type { DraftRecord } from '../lib/db';

const GHOST_KEY = 'g';
const RECENT_LIMIT = 12;

// What's actually applied to one image: the local draft wins over the canonical
// base it was grounded on.
type Effective = {
  label: string;
  commonName: string;
  count: number;
  questionable: boolean;
  requested: string;
  source: 'draft' | 'base' | 'none';
};

function effectiveOf(img: TagImage, draft: DraftRecord | undefined): Effective {
  if (draft) {
    return {
      label: draft.label,
      commonName: draft.commonName,
      count: draft.count,
      questionable: draft.questionable,
      requested: draft.requestedSpecies,
      source: 'draft',
    };
  }
  if (img.baseLabel)
    return {
      label: img.baseLabel,
      commonName: img.baseCommonName,
      count: img.baseCount,
      questionable: false,
      requested: img.baseRequested,
      source: 'base',
    };
  return { label: '', commonName: '', count: 0, questionable: false, requested: '', source: 'none' };
}

export function Tag() {
  const cfg = useStore((s) => s.s3Config);
  const connectionId = useStore((s) => s.connectionId);
  const collectionKey = useStore((s) => s.selectedCollectionKey);
  const uploadPrefix = useStore((s) => s.selectedUploadPrefix);
  const burstThreshold = useStore((s) => s.burstThresholdSec);

  const images = useTagImages(cfg, connectionId, collectionKey, uploadPrefix);
  const species = useSpecies(cfg, connectionId);

  const { bucket } = collectionKey ? parseCollectionKey(collectionKey) : { bucket: '' };
  const ctx = useMemo<UploadCtx>(() => ({ bucket, uploadPrefix: uploadPrefix ?? '' }), [bucket, uploadPrefix]);

  const drafts = useDraftStore((s) => s.drafts);
  const loadUpload = useDraftStore((s) => s.loadUpload);
  const applyTagFn = useDraftStore((s) => s.applyTag);
  const applyTagManyFn = useDraftStore((s) => s.applyTagMany);
  const detagManyFn = useDraftStore((s) => s.detagMany);
  const setQuestionableManyFn = useDraftStore((s) => s.setQuestionableMany);
  const flushSaves = useDraftStore((s) => s.flushSaves);
  const discardUpload = useDraftStore((s) => s.discardUpload);

  // Hydrate drafts for this upload from Dexie when it changes.
  useEffect(() => {
    if (bucket && uploadPrefix) void loadUpload({ bucket, uploadPrefix });
  }, [bucket, uploadPrefix, loadUpload]);

  const [focus, setFocus] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [count, setCount] = useState(1);
  const [filter, setFilter] = useState('');
  const [capturingFor, setCapturingFor] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);

  const list = images.data ?? [];
  const current = list[focus];

  // Burst grouping (visual bands + whole-burst selection / nav). Recomputed when
  // the image list or the per-session threshold changes.
  const grouping = useMemo<BurstGrouping>(
    () => groupBursts(list, burstThreshold),
    [list, burstThreshold],
  );

  // Reset focus/selection when the upload changes / data arrives.
  useEffect(() => {
    setFocus(0);
    setSelected(new Set());
  }, [uploadPrefix, images.data]);

  const { overrides, assignKey, clearKey } = useKeyBindings();
  const speciesList = species.data?.species ?? [];

  const bindingFor = (sci: string): string | null => {
    const k = effectiveKey(sci, speciesJsonKey(speciesList, sci), overrides);
    return k ? k.toUpperCase() : null;
  };

  // key char → action, built once per species/override change. Precedence
  // low→high: Ghost default, species.json bindings, then local overrides.
  const keyMap = useMemo(() => {
    const m = new Map<string, { kind: 'ghost' } | { kind: 'species'; species: Species }>();
    m.set(GHOST_KEY, { kind: 'ghost' });
    for (const s of speciesList) {
      const k = normalizeJavaKeyCode(s.keyBinding);
      if (k) m.set(k, { kind: 'species', species: s });
    }
    for (const s of speciesList) {
      const ov = overrides[s.scientificName];
      if (ov) m.set(ov, { kind: 'species', species: s });
    }
    return m;
  }, [speciesList, overrides]);

  const pushRecent = (sci: string) =>
    setRecent((r) => [sci, ...r.filter((x) => x !== sci)].slice(0, RECENT_LIMIT));

  // Operations target the selection when one exists, else the focused image.
  const targetsOf = (): TagTarget[] => {
    const idx = selected.size ? [...selected].sort((a, b) => a - b) : current ? [focus] : [];
    return idx
      .map((i) => list[i])
      .filter(Boolean)
      .map((img) => ({ mediaPath: img.key, deploymentId: img.deploymentId }));
  };

  const apply = (tag: AppliedTag) => {
    const targets = targetsOf();
    if (!targets.length) return;
    if (targets.length === 1) applyTagFn(ctx, targets[0].mediaPath, targets[0].deploymentId, tag);
    else applyTagManyFn(ctx, targets, tag);
    if (tag.label) pushRecent(tag.label);
  };

  // --- Global key handler: attached once, reads the latest state via a ref so
  // it never re-binds per render (plan perf requirement). ----------------------
  const stateRef = useRef<HandlerState>(null!);
  stateRef.current = {
    list,
    focus,
    setFocus,
    grouping,
    selected,
    setSelected,
    ctx,
    keyMap,
    capturingFor,
    setCapturingFor,
    assignKey,
    apply,
    targetsOf,
    detagMany: detagManyFn,
    setQuestionableMany: setQuestionableManyFn,
    drafts,
    flushSaves,
    flashSaved: () => setSavedAt(Date.now()),
    showCheatsheet,
    setShowCheatsheet,
    filterRef,
    speciesList,
    filter,
    count,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleKey(e, stateRef.current);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Transient "Saved" confirmation after Cmd/Ctrl+S.
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(0), 1500);
    return () => clearTimeout(t);
  }, [savedAt]);

  if (!current && images.isLoading)
    return <Centered>Loading the upload’s canonical media…</Centered>;
  if (images.isError)
    return <Centered tone="warn">{(images.error as Error).message}</Centered>;
  if (!list.length) return <Centered>This upload has no taggable images.</Centered>;

  const draft = current ? drafts[current.key] : undefined;
  const eff = current ? effectiveOf(current, draft) : null;
  const nDirty = dirtyCount(drafts);

  const selectBurst = (i: number) => setSelected(burstIndexSet(grouping, i));
  const selectRow = (i: number) => {
    setFocus(i);
    setSelected(new Set());
  };

  return (
    <div className="h-full grid grid-cols-[280px_1fr_340px] min-h-0">
      {/* Image strip — grouped into burst bands */}
      <aside className="border-r border-rule bg-panel overflow-y-auto min-h-0">
        <div className="sticky top-0 z-10 bg-panel border-b border-rule px-3 py-2 flex items-center justify-between">
          <span className="text-[12px] font-mono text-inkSoft">
            {selected.size > 0 ? (
              <span className="text-accent">{selected.size} selected</span>
            ) : (
              <>
                {focus + 1} / {list.length}
              </>
            )}
          </span>
          {nDirty > 0 && (
            <button
              onClick={() => {
                if (confirm(`Discard ${nDirty} local edit(s) for this upload?`)) void discardUpload(ctx);
              }}
              className="text-[11px] font-mono text-inkMute hover:text-warn underline decoration-dotted"
              title="Discard local changes for this upload"
            >
              {nDirty} unsaved · discard
            </button>
          )}
        </div>
        <ul>
          {grouping.bursts.map((b) => (
            <li key={b.id}>
              <BurstBand
                burst={b}
                selected={isBurstFullySelected(b, selected)}
                onSelect={() => selectBurst(b.start)}
              />
              <ul>
                {range(b.start, b.end).map((i) => (
                  <StripRow
                    key={list[i].key}
                    img={list[i]}
                    index={i}
                    active={i === focus}
                    selected={selected.has(i)}
                    onSelect={() => selectRow(i)}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </aside>

      {/* Focus view */}
      <div className="flex flex-col min-h-0 bg-paper">
        <div className="flex-1 min-h-0 grid place-items-center p-4 overflow-hidden">
          {current && <FocusImage objectKey={current.key} alt={current.fileName} />}
        </div>
        {current && eff && (
          <div className="shrink-0 border-t border-rule bg-panel px-5 py-3 flex items-center gap-5 flex-wrap">
            <div className="min-w-0">
              <div className="text-[14px] font-mono text-ink truncate" title={current.fileName}>
                {current.fileName}
              </div>
              <div className="text-[12px] font-mono text-inkMute">
                {current.baseTimestamp || '— no timestamp —'} · {shortDeployment(current.deploymentId)}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-3">
              {savedAt > 0 && (
                <span className="text-[12px] font-mono text-accent">saved ✓</span>
              )}
              {eff.questionable && (
                <span className="text-[12px] font-mono text-warn border border-warn px-2 py-0.5">questionable</span>
              )}
              <TagChip eff={eff} />
              <button
                onClick={() => detagManyFn(ctx, targetsOf())}
                disabled={!eff.label && eff.source !== 'base'}
                className="text-[13px] border border-rule px-2.5 py-1 text-inkSoft hover:text-ink hover:border-ink disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                title="Remove the species from this image"
              >
                Detag
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Species panel */}
      <SpeciesPanel
        species={speciesList}
        count={count}
        onCountChange={setCount}
        onApply={apply}
        filter={filter}
        onFilterChange={setFilter}
        filterRef={filterRef}
        bindingFor={bindingFor}
        capturingFor={capturingFor}
        onStartCapture={setCapturingFor}
        onClearKey={clearKey}
        recent={recent}
        currentLabel={eff?.label ?? ''}
        selectionCount={selected.size}
        disabled={!current}
      />

      {showCheatsheet && <Cheatsheet onClose={() => setShowCheatsheet(false)} />}
    </div>
  );
}

// --- Burst band header ------------------------------------------------------
function BurstBand({
  burst,
  selected,
  onSelect,
}: {
  burst: Burst;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 border-b border-rule sticky top-[37px] z-[5] ${
        selected ? 'bg-mark' : 'bg-paperHover'
      }`}
    >
      <span className="text-[11px] font-mono text-inkSoft">
        Burst {burst.id + 1} · {burst.size} img · {burstSpan(burst)}
      </span>
      <button
        onClick={onSelect}
        className="ml-auto text-[11px] font-mono text-inkMute hover:text-accent underline decoration-dotted focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        title="Select this burst (⌘/Ctrl+A on the current burst)"
      >
        select
      </button>
    </div>
  );
}

// --- Strip row (subscribes only to its own draft, so editing one image does not
// re-render the whole strip). ------------------------------------------------
function StripRow({
  img,
  index,
  active,
  selected,
  onSelect,
}: {
  img: TagImage;
  index: number;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const draft = useDraftStore((s) => s.drafts[img.key]);
  const eff = effectiveOf(img, draft);
  return (
    <li>
      <button
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-left border-b border-ruleSoft ${
          selected ? 'bg-mark/70' : active ? 'bg-mark' : 'hover:bg-panelHover'
        }`}
      >
        <span className="w-12 shrink-0">
          <Thumb objectKey={img.key} alt={img.fileName} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-mono text-inkSoft truncate" title={img.fileName}>
            {img.fileName}
          </span>
          <span className="block text-[12px] truncate">
            {eff.label ? (
              <span className="text-ink">
                {eff.commonName || eff.label}
                {eff.count > 1 && <span className="text-inkMute"> ×{eff.count}</span>}
              </span>
            ) : (
              <span className="text-inkMute">untagged</span>
            )}
          </span>
        </span>
        <span className="shrink-0 flex flex-col items-end gap-0.5">
          {eff.source === 'draft' && eff.label !== img.baseLabel && (
            <span className="w-1.5 h-1.5 rounded-full bg-accent" title="unsaved edit" />
          )}
          {eff.questionable && <span className="text-[11px] text-warn" title="questionable">?</span>}
          <span className="text-[11px] font-mono text-inkMute">{index + 1}</span>
        </span>
      </button>
    </li>
  );
}

function TagChip({ eff }: { eff: Effective }) {
  if (!eff.label) return <span className="text-[13px] font-mono text-inkMute">untagged</span>;
  const isGhost = eff.label === GHOST.label;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[13px] border ${
        isGhost ? 'border-rule text-inkSoft' : 'border-ink text-ink'
      }`}
    >
      {isGhost ? '◯ Ghost' : eff.commonName || eff.label}
      {eff.count > 1 && <span className="font-mono text-inkMute">×{eff.count}</span>}
      {eff.requested && <span className="font-mono text-inkMute text-[11px]">requested</span>}
    </span>
  );
}

function FocusImage({ objectKey, alt }: { objectKey: string; alt: string }) {
  const cfg = useStore((s) => s.s3Config);
  const connectionId = useStore((s) => s.connectionId);
  const collectionKey = useStore((s) => s.selectedCollectionKey);
  const { data, isError } = useQuery({
    queryKey: ['presign', connectionId, objectKey],
    queryFn: () => {
      const { bucket } = parseCollectionKey(collectionKey!);
      return presignImage(cfg!, bucket, objectKey);
    },
    enabled: !!cfg && !!collectionKey,
    staleTime: 50 * 60 * 1000,
    retry: 1,
  });
  if (isError)
    return <div className="text-[13px] font-mono text-warn">Could not load this image.</div>;
  if (!data) return <div className="text-[13px] font-mono text-inkMute">…</div>;
  return <img src={data} alt={alt} className="max-w-full max-h-full object-contain" />;
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return (
    <div className="h-full grid place-items-center p-8">
      <p className={`text-[15px] font-body ${tone === 'warn' ? 'text-warn' : 'text-inkMute'}`}>
        {children}
      </p>
    </div>
  );
}

// The deploymentId is "<collection-uuid>:<location-id>"; show the readable tail.
function shortDeployment(deploymentId: string): string {
  const tail = deploymentId.split(':').pop() ?? deploymentId;
  return tail || deploymentId;
}

function speciesJsonKey(list: Species[], sci: string): string | null {
  return list.find((s) => s.scientificName === sci)?.keyBinding ?? null;
}

// --- Burst / selection helpers ----------------------------------------------

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

/** The set of image indices in the burst containing image `i`. */
function burstIndexSet(g: BurstGrouping, i: number): Set<number> {
  const b = g.bursts[g.burstOf[i]];
  if (!b) return new Set();
  return new Set(range(b.start, b.end));
}

function isBurstFullySelected(b: Burst, selected: Set<number>): boolean {
  if (!selected.size) return false;
  for (let i = b.start; i <= b.end; i++) if (!selected.has(i)) return false;
  return true;
}

function burstSpan(b: Burst): string {
  const t = (iso: string) => (iso ? iso.slice(11, 19) : '—');
  return b.startTs === b.endTs ? t(b.startTs) : `${t(b.startTs)}–${t(b.endTs)}`;
}

// --- Global key handler -----------------------------------------------------

type HandlerState = {
  list: TagImage[];
  focus: number;
  setFocus: (n: number) => void;
  grouping: BurstGrouping;
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  ctx: UploadCtx;
  keyMap: Map<string, { kind: 'ghost' } | { kind: 'species'; species: Species }>;
  capturingFor: string | null;
  setCapturingFor: (v: string | null) => void;
  assignKey: (sci: string, key: string) => void;
  apply: (tag: AppliedTag) => void;
  targetsOf: () => TagTarget[];
  detagMany: (ctx: UploadCtx, targets: TagTarget[]) => void;
  setQuestionableMany: (ctx: UploadCtx, targets: TagTarget[], value: boolean) => void;
  drafts: Record<string, DraftRecord>;
  flushSaves: () => Promise<void>;
  flashSaved: () => void;
  showCheatsheet: boolean;
  setShowCheatsheet: (v: boolean) => void;
  filterRef: React.RefObject<HTMLInputElement>;
  speciesList: Species[];
  filter: string;
  count: number;
};

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

/** Move focus to the start of the burst `dir` away, clearing selection. */
function gotoBurst(s: HandlerState, dir: 1 | -1): void {
  const curBurst = s.grouping.burstOf[s.focus] ?? 0;
  const target = Math.max(0, Math.min(curBurst + dir, s.grouping.bursts.length - 1));
  const b = s.grouping.bursts[target];
  if (!b) return;
  s.setFocus(b.start);
  s.setSelected(new Set());
}

function handleKey(e: KeyboardEvent, s: HandlerState): void {
  // Cheatsheet modal swallows everything but its own toggle / dismiss.
  if (s.showCheatsheet) {
    if (e.key === '?' || e.key === 'Escape') {
      e.preventDefault();
      s.setShowCheatsheet(false);
    }
    return;
  }

  // Key-capture mode for "assign key" — swallow the next printable key.
  if (s.capturingFor) {
    if (e.key === 'Escape') {
      s.setCapturingFor(null);
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      s.assignKey(s.capturingFor, e.key.toLowerCase());
      s.setCapturingFor(null);
    }
    return;
  }

  const typing = isTypingTarget(e.target);

  // Escape blurs the filter. Enter applies the first filter match to the targets.
  if (typing) {
    if (e.key === 'Escape') s.filterRef.current?.blur();
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = s.filter.trim().toLowerCase();
      const match =
        q &&
        s.speciesList.find(
          (sp) =>
            sp.commonName.toLowerCase().includes(q) || sp.scientificName.toLowerCase().includes(q),
        );
      if (match) s.apply({ label: match.scientificName, commonName: match.commonName, count: s.count });
      s.filterRef.current?.blur();
    }
    return;
  }

  // `?` toggles the cheatsheet (it arrives as Shift+/, so handle before the
  // Shift/modifier guards below).
  if (e.key === '?') {
    e.preventDefault();
    s.setShowCheatsheet(true);
    return;
  }

  // Cmd/Ctrl combos: select-burst (A) and save-now (S).
  if (e.metaKey || e.ctrlKey) {
    const k = e.key.toLowerCase();
    if (k === 'a') {
      e.preventDefault();
      s.setSelected(burstIndexSet(s.grouping, s.focus));
    } else if (k === 's') {
      e.preventDefault();
      void s.flushSaves();
      s.flashSaved();
    }
    return;
  }
  if (e.altKey) return;

  // Shift+J / Shift+K — burst navigation.
  if (e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === 'j') {
      e.preventDefault();
      gotoBurst(s, 1);
    } else if (k === 'k') {
      e.preventDefault();
      gotoBurst(s, -1);
    }
    return;
  }

  const current = s.list[s.focus];
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      s.setFocus(Math.min(s.focus + 1, s.list.length - 1));
      s.setSelected(new Set());
      return;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      s.setFocus(Math.max(s.focus - 1, 0));
      s.setSelected(new Set());
      return;
    case ' ':
      e.preventDefault();
      s.filterRef.current?.focus();
      return;
    case 'Escape':
      if (s.selected.size) s.setSelected(new Set());
      return;
    case 'x':
    case 'X': {
      const targets = s.targetsOf();
      if (!targets.length || !current) return;
      // Anchor on the focused image so a mixed selection resolves predictably.
      const anchor = s.drafts[current.key];
      s.setQuestionableMany(s.ctx, targets, !anchor?.questionable);
      return;
    }
  }

  const action = s.keyMap.get(e.key.toLowerCase());
  if (!action || !current) return;
  e.preventDefault();
  if (action.kind === 'ghost') s.apply({ label: GHOST.label, commonName: GHOST.commonName, count: s.count });
  else s.apply({ label: action.species.scientificName, commonName: action.species.commonName, count: s.count });
}
