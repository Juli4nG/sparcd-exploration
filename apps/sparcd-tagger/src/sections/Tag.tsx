import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { useStore } from '../store';
import { useTagImages, useSpecies } from '../lib/queries';
import { parseCollectionKey, presignImage } from '../lib/s3';
import { correctedTimestamp, shiftTimestamp } from '@sparcd/camtrap';
import { SpeciesPanel } from '../components/SpeciesPanel';
import { AppliedSpecies } from '../components/AppliedSpecies';
import { Cheatsheet } from '../components/Cheatsheet';
import { SyncDialog } from '../components/SyncDialog';
import { SnapshotsDialog } from '../components/SnapshotsDialog';
import { TimeShiftModal } from '../components/TimeShiftModal';
import { PerImageTime } from '../components/PerImageTime';
import { Overview, type PickMods, type ViewKind } from '../components/Overview';
import { groupBursts, type BurstGrouping } from '../lib/bursts';
import { offsetActive, formatOffsetDelta } from '../lib/timeshift';
import { rangeSet, toggleIndex, burstIndexSet } from '../lib/selection';
import { effectiveOf, type Effective } from '../lib/effective';
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
import { isVideoKey, type TagImage } from '../lib/workspace';
import type { DraftRecord } from '../lib/db';

const GHOST_KEY = 'g';
const RECENT_LIMIT = 12;

type View = 'overview' | 'focus';

export function Tag() {
  const cfg = useStore((s) => s.s3Config);
  const connectionId = useStore((s) => s.connectionId);
  const collectionKey = useStore((s) => s.selectedCollectionKey);
  const uploadPrefix = useStore((s) => s.selectedUploadPrefix);
  const burstGroupingEnabled = useStore((s) => s.burstGroupingEnabled);
  const burstThreshold = useStore((s) => s.burstThresholdSec);
  const pendingSnapshots = useStore((s) => s.pendingSnapshots);
  const clearPendingSnapshots = useStore((s) => s.clearPendingSnapshots);

  const images = useTagImages(cfg, connectionId, collectionKey, uploadPrefix);
  const species = useSpecies(cfg, connectionId);

  const { bucket } = collectionKey ? parseCollectionKey(collectionKey) : { bucket: '' };
  const ctx = useMemo<UploadCtx>(() => ({ bucket, uploadPrefix: uploadPrefix ?? '' }), [bucket, uploadPrefix]);

  const drafts = useDraftStore((s) => s.drafts);
  const timeOffset = useDraftStore((s) => s.timeOffset);
  const loadUpload = useDraftStore((s) => s.loadUpload);
  const addSpeciesFn = useDraftStore((s) => s.addSpecies);
  const removeSpeciesFn = useDraftStore((s) => s.removeSpecies);
  const setSpeciesCountFn = useDraftStore((s) => s.setSpeciesCount);
  const detagFn = useDraftStore((s) => s.detag);
  const setQuestionableManyFn = useDraftStore((s) => s.setQuestionableMany);
  const setTimeOffsetFn = useDraftStore((s) => s.setTimeOffset);
  const setTimeOverrideFn = useDraftStore((s) => s.setTimeOverride);
  const flushSaves = useDraftStore((s) => s.flushSaves);
  const discardUpload = useDraftStore((s) => s.discardUpload);

  // Hydrate drafts for this upload from Dexie when it changes.
  useEffect(() => {
    if (bucket && uploadPrefix) void loadUpload({ bucket, uploadPrefix });
  }, [bucket, uploadPrefix, loadUpload]);

  const [view, setView] = useState<View>('overview');
  const [overviewKind, setOverviewKind] = useState<ViewKind>('grid');
  const [focus, setFocus] = useState(0);
  const [anchor, setAnchor] = useState(0); // last single pick — the base for Shift-range
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');
  const [capturingFor, setCapturingFor] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [showTimeShift, setShowTimeShift] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);

  const list = images.data ?? [];
  const current = list[focus];

  // An upload offset shifts every image equally, so it never changes a burst
  // gap — only the band labels. Feed the offset-corrected time so bands read the
  // corrected span; per-image overrides are rare and intentionally don't re-band
  // (keeps grouping off the per-keystroke draft path). Undefined → base time.
  const tsOf = useMemo(
    () =>
      offsetActive(timeOffset)
        ? (img: TagImage) => shiftTimestamp(img.baseTimestamp, timeOffset!)
        : undefined,
    [timeOffset],
  );

  // Burst grouping (visual bands + whole-burst selection / nav). Recomputed when
  // the image list, the per-session threshold, or the upload offset changes.
  const grouping = useMemo<BurstGrouping>(
    () => groupBursts(list, burstThreshold, burstGroupingEnabled, tsOf),
    [list, burstThreshold, burstGroupingEnabled, tsOf],
  );

  const sampleTimestamp = useMemo(() => list.find((i) => i.baseTimestamp)?.baseTimestamp ?? '', [
    list,
  ]);

  // Reset focus/selection when the upload changes / data arrives.
  useEffect(() => {
    setFocus(0);
    setAnchor(0);
    setSelected(new Set());
  }, [uploadPrefix, images.data]);

  // History routes here with `pendingSnapshots` set to jump straight into the
  // recovery dialog for the chosen upload; consume the flag once.
  useEffect(() => {
    if (pendingSnapshots) {
      setShowSnapshots(true);
      clearPendingSnapshots();
    }
  }, [pendingSnapshots, clearPendingSnapshots]);

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
      .map((img) => ({
        mediaPath: img.key,
        deploymentId: img.deploymentId,
        // Seed a fresh draft from the FULL canonical base set so a partial edit
        // (adding one species, toggling questionable) keeps every existing one.
        base: { observations: img.baseObservations },
      }));
  };

  const apply = (tag: AppliedTag) => {
    const targets = targetsOf();
    if (!targets.length) return;
    addSpeciesFn(ctx, targets, tag);
    if (tag.scientificName) pushRecent(tag.scientificName);
  };

  // --- Mouse selection gestures (single / Shift-range / Cmd-additive). --------
  const pick = (i: number, mods: PickMods) => {
    if (mods.shift) {
      setSelected(rangeSet(anchor, i));
      setFocus(i);
    } else if (mods.meta) {
      setSelected(toggleIndex(selected, i));
      setFocus(i);
      setAnchor(i);
    } else {
      setFocus(i);
      setSelected(new Set());
      setAnchor(i);
    }
  };

  const selectBurst = (start: number) => {
    setSelected(burstIndexSet(grouping, start));
    setFocus(start);
    setAnchor(start);
  };

  const drill = (i: number) => {
    setFocus(i);
    setSelected(new Set());
    setAnchor(i);
    setView('focus');
  };

  // --- Global key handler: attached once, reads the latest state via a ref so
  // it never re-binds per render (plan perf requirement). ----------------------
  const stateRef = useRef<HandlerState>(null!);
  stateRef.current = {
    list,
    focus,
    setFocus,
    setAnchor,
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
    detag: detagFn,
    setQuestionableMany: setQuestionableManyFn,
    drafts,
    flushSaves,
    flashSaved: () => setSavedAt(Date.now()),
    showCheatsheet,
    setShowCheatsheet,
    filterRef,
    speciesList,
    filter,
    view,
    setView,
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
  const currentBase = current ? { observations: current.baseObservations } : undefined;
  const nDirty = dirtyCount(drafts);
  const hasUploadShift = offsetActive(timeOffset);
  const correctedTs = current
    ? correctedTimestamp(current.baseTimestamp, timeOffset, draft?.timeOverride ?? null)
    : '';

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Workspace toolbar: mode + view switches, position, selection, save */}
      <div className="shrink-0 h-10 border-b border-rule bg-panel flex items-center gap-3 px-3">
        <Segmented
          value={view}
          onChange={(v) => setView(v as View)}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'focus', label: 'Focus' },
          ]}
        />
        {view === 'overview' && (
          <Segmented
            value={overviewKind}
            onChange={(v) => setOverviewKind(v as ViewKind)}
            options={[
              { value: 'grid', label: '▦ Grid' },
              { value: 'list', label: '☰ List' },
            ]}
          />
        )}

        <span className="text-[12px] font-mono text-inkSoft">
          {selected.size > 0 ? (
            <span className="text-accent">{selected.size} selected</span>
          ) : (
            <>
              {focus + 1} / {list.length}
            </>
          )}
        </span>

        {/* Upload time-shift entry + persistent active-offset indicator (§08). */}
        <button
          onClick={() => setShowTimeShift(true)}
          className={`inline-flex items-center gap-1.5 text-[11.5px] font-mono px-2 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
            hasUploadShift
              ? 'bg-mark border border-ink text-ink font-[600]'
              : 'border border-rule text-inkSoft hover:text-ink hover:border-ink'
          }`}
          title={
            hasUploadShift
              ? 'Upload time shift is active — click to edit'
              : 'Shift every frame in this upload by a signed offset'
          }
        >
          <span aria-hidden>◷</span>
          {hasUploadShift ? `clock ${formatOffsetDelta(timeOffset)}` : 'Time shift'}
        </button>

        <div className="ml-auto flex items-center gap-3">
          {savedAt > 0 && <span className="text-[12px] font-mono text-accent">saved ✓</span>}
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
          <button
            onClick={() => setShowSnapshots(true)}
            className="text-[12px] font-mono border border-rule px-2.5 py-1 text-inkSoft hover:text-ink hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            title="Browse and restore prior canonical snapshots of this upload"
          >
            Snapshots…
          </button>
          <button
            onClick={() => setShowSync(true)}
            className="text-[12px] font-mono border border-ink px-2.5 py-1 text-ink hover:bg-panelHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            title="Review and sync local edits to the canonical S3 files"
          >
            Sync…
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {view === 'overview' ? (
          <div className="h-full grid grid-cols-[1fr_340px] min-h-0">
            <Overview
              list={list}
              grouping={grouping}
              focus={focus}
              selected={selected}
              kind={overviewKind}
              onPick={pick}
              onSelectBurst={selectBurst}
              onDrill={drill}
            />
            <SpeciesPanel {...speciesPanelProps()} />
          </div>
        ) : (
          <div className="h-full grid grid-cols-[280px_1fr_340px] grid-rows-[minmax(0,1fr)] min-h-0">
            <Overview
              list={list}
              grouping={grouping}
              focus={focus}
              selected={selected}
              kind="list"
              onPick={pick}
              onSelectBurst={selectBurst}
            />
            <FocusPane
              current={current}
              eff={eff}
              savedAt={savedAt}
              corrected={correctedTs}
              hasUploadShift={hasUploadShift}
              overridden={!!draft?.timeOverride}
              onSetTime={(iso) =>
                current && setTimeOverrideFn(ctx, current.key, current.deploymentId, currentBase, iso)
              }
              onClearTime={() =>
                current && setTimeOverrideFn(ctx, current.key, current.deploymentId, currentBase, null)
              }
              onDetag={() => detagFn(ctx, targetsOf())}
            />
            <SpeciesPanel {...speciesPanelProps()} />
          </div>
        )}
      </div>

      {showCheatsheet && <Cheatsheet onClose={() => setShowCheatsheet(false)} />}
      {showSync && (
        <SyncDialog ctx={ctx} images={list} drafts={drafts} onClose={() => setShowSync(false)} />
      )}
      {showSnapshots && <SnapshotsDialog ctx={ctx} onClose={() => setShowSnapshots(false)} />}
      {showTimeShift && (
        <TimeShiftModal
          offset={timeOffset}
          sampleTimestamp={sampleTimestamp}
          totalFrames={list.length}
          onApply={(o) => setTimeOffsetFn(ctx, o)}
          onClose={() => setShowTimeShift(false)}
        />
      )}
    </div>
  );

  function speciesPanelProps() {
    const observations = eff?.observations ?? [];
    return {
      species: speciesList,
      onApply: apply,
      filter,
      onFilterChange: setFilter,
      filterRef,
      bindingFor,
      capturingFor,
      onStartCapture: setCapturingFor,
      onClearKey: clearKey,
      recent,
      appliedSet: new Set(observations.map((o) => o.scientificName)),
      hasFocus: !!current,
      selectionCount: selected.size,
      disabled: !current,
      // The compact applied-species strip edits the focused image only. Mounted
      // in the panel header so it covers both Overview and Focus layouts (the
      // same panel renders in both) with one site.
      headerSlot: (
        <AppliedSpecies
          observations={observations}
          disabled={!current}
          onSetCount={(sci, n) =>
            current && setSpeciesCountFn(ctx, current.key, current.deploymentId, currentBase, sci, n)
          }
          onRemove={(sci) =>
            current && removeSpeciesFn(ctx, current.key, current.deploymentId, currentBase, sci)
          }
          onDetagAll={() =>
            current &&
            detagFn(ctx, [
              {
                mediaPath: current.key,
                deploymentId: current.deploymentId,
                base: currentBase,
              },
            ])
          }
        />
      ),
    };
  }
}

// --- Focus view (single-image detail) ---------------------------------------
function FocusPane({
  current,
  eff,
  savedAt,
  corrected,
  hasUploadShift,
  overridden,
  onSetTime,
  onClearTime,
  onDetag,
}: {
  current: TagImage | undefined;
  eff: Effective | null;
  savedAt: number;
  corrected: string;
  hasUploadShift: boolean;
  overridden: boolean;
  onSetTime: (iso: string) => void;
  onClearTime: () => void;
  onDetag: () => void;
}) {
  return (
    <div className="flex flex-col min-h-0 bg-paper">
      <div className="relative flex-1 min-h-0 grid place-items-center p-4 overflow-hidden">
        {current && <FocusImage objectKey={current.key} alt={current.fileName} />}
      </div>
      {current && eff && (
        <div className="shrink-0 border-t border-rule bg-panel px-5 py-3 flex items-center gap-5 flex-wrap">
          <div className="min-w-0">
            <div className="text-[14px] font-mono text-ink truncate" title={current.fileName}>
              {current.fileName} <span className="text-inkMute">· {shortDeployment(current.deploymentId)}</span>
            </div>
            <div className="mt-1">
              <PerImageTime
                original={current.baseTimestamp}
                corrected={corrected}
                hasUploadShift={hasUploadShift}
                overridden={overridden}
                onSet={onSetTime}
                onClear={onClearTime}
              />
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {savedAt > 0 && <span className="text-[12px] font-mono text-accent">saved ✓</span>}
            {eff.questionable && (
              <span className="text-[12px] font-mono text-warn border border-warn px-2 py-0.5">
                questionable
              </span>
            )}
            {/* The applied species themselves render in the SpeciesPanel header
                strip on the right; the footer keeps only questionable + Detag. */}
            <button
              onClick={onDetag}
              disabled={eff.observations.length === 0}
              className="text-[13px] border border-rule px-2.5 py-1 text-inkSoft hover:text-ink hover:border-ink disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              title="Remove every species from this image"
            >
              Detag
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="inline-flex border border-rule">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={`px-2.5 py-1 text-[12px] font-mono focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
            o.value === value ? 'bg-ink text-paper' : 'text-inkSoft hover:bg-panelHover'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
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
  if (isVideoKey(objectKey)) return <FocusVideo src={data} alt={alt} resetKey={objectKey} />;
  return <ZoomableImage src={data} alt={alt} resetKey={objectKey} />;
}

// Video media plays with native controls. No zoom/pan/Lightbox: the
// react-zoom-pan-pinch wrapper captures wheel/pointer events and would fight
// native scrubbing. `key={resetKey}` recreates the element on navigation so the
// prior clip's playback/seek state never bleeds into the next one.
function FocusVideo({ src, alt, resetKey }: { src: string; alt: string; resetKey: string }) {
  return (
    <video
      key={resetKey}
      src={src}
      aria-label={alt}
      controls
      playsInline
      preload="metadata"
      className="w-full h-full object-contain"
    />
  );
}

const ZOOM_PROPS = {
  minScale: 1,
  maxScale: 6,
  centerOnInit: true,
  centerZoomedOut: true,
  limitToBounds: true,
  wheel: { step: 0.2 },
  doubleClick: { mode: 'zoomIn' as const, step: 0.7 },
  panning: { velocityDisabled: true },
};

function ZoomableImage({ src, alt, resetKey }: { src: string; alt: string; resetKey: string }) {
  const [expanded, setExpanded] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  return (
    <>
      {/* key forces a fresh fit-to-view (reset zoom/pan) on every image change */}
      <TransformWrapper
        key={resetKey}
        {...ZOOM_PROPS}
        onTransform={(_, s) => setZoomed(s.scale > 1.01)}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <TransformComponent
              wrapperClass="!w-full !h-full cursor-grab active:cursor-grabbing"
              contentClass="!w-full !h-full"
            >
              <img
                src={src}
                alt={alt}
                draggable={false}
                className="w-full h-full object-contain select-none"
              />
            </TransformComponent>
            <ZoomControls
              onIn={() => zoomIn()}
              onOut={() => zoomOut()}
              onExpand={() => setExpanded(true)}
              onReset={zoomed ? () => resetTransform() : undefined}
            />
          </>
        )}
      </TransformWrapper>
      {expanded && <Lightbox src={src} alt={alt} onClose={() => setExpanded(false)} />}
    </>
  );
}

function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 bg-ink/90 grid grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[13px] font-mono text-paper/80 truncate">{alt}</span>
        <button
          type="button"
          onClick={onClose}
          className="w-8 h-8 grid place-items-center text-[18px] leading-none text-paper/80 hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          title="Close (Esc)"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="relative min-h-0" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <TransformWrapper {...ZOOM_PROPS} maxScale={10} onTransform={(_, s) => setZoomed(s.scale > 1.01)}>
          {({ zoomIn, zoomOut, resetTransform }) => (
            <>
              <TransformComponent
                wrapperClass="!w-full !h-full cursor-grab active:cursor-grabbing"
                contentClass="!w-full !h-full"
              >
                <img
                  src={src}
                  alt={alt}
                  draggable={false}
                  className="w-full h-full object-contain select-none"
                />
              </TransformComponent>
              <ZoomControls
                onIn={() => zoomIn()}
                onOut={() => zoomOut()}
                onReset={zoomed ? () => resetTransform() : undefined}
                dark
              />
            </>
          )}
        </TransformWrapper>
      </div>
    </div>,
    document.body,
  );
}

function ZoomControls({
  onIn,
  onOut,
  onExpand,
  onReset,
  dark,
}: {
  onIn: () => void;
  onOut: () => void;
  onExpand?: () => void;
  onReset?: () => void;
  dark?: boolean;
}) {
  const tone = dark
    ? 'text-paper/80 hover:text-paper hover:bg-paper/10'
    : 'text-inkSoft hover:text-ink hover:bg-paper';
  const surface = dark
    ? 'bg-ink/60 border-paper/20 divide-paper/20'
    : 'bg-panel/90 border-rule divide-rule';
  const btn = `w-8 h-8 grid place-items-center text-[15px] leading-none ${tone} focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`;
  return (
    <div className="absolute bottom-4 right-4 flex flex-col items-end gap-2">
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          className={`flex items-center gap-1.5 px-3 h-8 border shadow-sm text-[13px] font-mono ${surface} ${tone} focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
          title="Reset to fit"
        >
          ⤢ Reset
        </button>
      )}
      <div className={`flex flex-col border divide-y shadow-sm ${surface}`}>
        <button type="button" onClick={onIn} className={btn} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={onOut} className={btn} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        {onExpand && (
          <button
            type="button"
            onClick={onExpand}
            className={`${btn} text-[12px]`}
            title="Open fullscreen"
            aria-label="Open fullscreen"
          >
            ⤢
          </button>
        )}
      </div>
    </div>
  );
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

// --- Global key handler -----------------------------------------------------

type HandlerState = {
  list: TagImage[];
  focus: number;
  setFocus: (n: number) => void;
  setAnchor: (n: number) => void;
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
  detag: (ctx: UploadCtx, targets: TagTarget[]) => void;
  setQuestionableMany: (ctx: UploadCtx, targets: TagTarget[], value: boolean) => void;
  drafts: Record<string, DraftRecord>;
  flushSaves: () => Promise<void>;
  flashSaved: () => void;
  showCheatsheet: boolean;
  setShowCheatsheet: (v: boolean) => void;
  filterRef: React.RefObject<HTMLInputElement>;
  speciesList: Species[];
  filter: string;
  view: View;
  setView: (v: View) => void;
};

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

// A focused <video>/<audio> owns its own keys (Space = play/pause, arrows =
// seek/volume). Let the browser handle them rather than letting a tagger hotkey
// fire — otherwise Space steals focus to the filter and letter keys tag the clip.
function isMediaTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO');
}

/** Move focus to image `i`, clearing selection and re-anchoring range-select. */
function focusMove(s: HandlerState, i: number): void {
  const clamped = Math.max(0, Math.min(i, s.list.length - 1));
  s.setFocus(clamped);
  s.setAnchor(clamped);
  s.setSelected(new Set());
}

/** Move focus to the start of the burst `dir` away, clearing selection. */
function gotoBurst(s: HandlerState, dir: 1 | -1): void {
  const curBurst = s.grouping.burstOf[s.focus] ?? 0;
  const target = Math.max(0, Math.min(curBurst + dir, s.grouping.bursts.length - 1));
  const b = s.grouping.bursts[target];
  if (!b) return;
  focusMove(s, b.start);
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

  // A focused video/audio control handles its own keys natively; don't let any
  // tagger hotkey fire while the user is scrubbing or playing.
  if (isMediaTarget(e.target)) return;

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
      if (match) s.apply({ scientificName: match.scientificName, commonName: match.commonName, count: 1 });
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
      s.setAnchor(s.focus);
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
      focusMove(s, s.focus + 1);
      return;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      focusMove(s, s.focus - 1);
      return;
    case ' ':
      e.preventDefault();
      s.filterRef.current?.focus();
      return;
    case 'Enter':
      // Drill the focused image into the Focus view from the Overview.
      if (s.view === 'overview') {
        e.preventDefault();
        s.setView('focus');
      }
      return;
    case 'Escape':
      if (s.selected.size) s.setSelected(new Set());
      return;
    case 'x':
    case 'X': {
      const targets = s.targetsOf();
      if (!targets.length || !current) return;
      // Anchor on the focused image so a mixed selection resolves predictably.
      const anchorDraft = s.drafts[current.key];
      s.setQuestionableMany(s.ctx, targets, !anchorDraft?.questionable);
      return;
    }
  }

  const action = s.keyMap.get(e.key.toLowerCase());
  if (!action || !current) return;
  e.preventDefault();
  if (action.kind === 'ghost') s.apply({ scientificName: GHOST.label, commonName: GHOST.commonName, count: 1 });
  else s.apply({ scientificName: action.species.scientificName, commonName: action.species.commonName, count: 1 });
}
