// Local draft edit state. The in-memory map is the hot path the UI reads and
// writes optimistically; Dexie is the durable mirror written debounced and off
// the keystroke path (plan: "Dexie writes are debounced and off the hot path").
//
// One record per image, keyed by media path. Mutations replace the top-level
// `drafts` object but preserve unchanged record references, so a per-row
// `s.drafts[path]` selector only re-renders the row that actually changed —
// editing one image never re-renders the whole strip.

import { create } from 'zustand';
import {
  db,
  draftId,
  loadDraftsForUpload,
  discardUploadDrafts,
  uploadId,
  type DraftRecord,
} from './db';

/** The built-in non-animal label. Encoded as a species row (`Casper`, count ≥1)
 *  so it counts as species-present exactly like Java treats it (P0 decision). */
export const GHOST = { label: 'Casper', commonName: 'Ghost' } as const;

export type UploadCtx = { bucket: string; uploadPrefix: string };

/** One image a batch operation targets: its media path + deployment. */
export type TagTarget = { mediaPath: string; deploymentId: string };

/** The tag a UI action applies to an image. */
export type AppliedTag = {
  label: string; // scientificName or '' to detag
  commonName: string;
  count: number;
  requestedSpecies?: string;
  freeTags?: string;
};

type DraftState = {
  loadedKey: string | null; // `${bucket}::${uploadPrefix}` currently hydrated
  loading: boolean;
  drafts: Record<string, DraftRecord>; // by mediaPath

  loadUpload: (ctx: UploadCtx) => Promise<void>;
  applyTag: (ctx: UploadCtx, mediaPath: string, deploymentId: string, tag: AppliedTag) => void;
  detag: (ctx: UploadCtx, mediaPath: string, deploymentId: string) => void;
  toggleQuestionable: (ctx: UploadCtx, mediaPath: string, deploymentId: string) => void;

  // Batch variants for whole-burst / multi-select: one state update + one Dexie
  // write per target, so applying to a 2,000-image burst is a single re-render
  // of the changed rows, not 2,000 sequential store mutations.
  applyTagMany: (ctx: UploadCtx, targets: TagTarget[], tag: AppliedTag) => void;
  detagMany: (ctx: UploadCtx, targets: TagTarget[]) => void;
  setQuestionableMany: (ctx: UploadCtx, targets: TagTarget[], value: boolean) => void;

  /** Flush every pending debounced Dexie write now (manual Cmd/Ctrl+S confirm). */
  flushSaves: () => Promise<void>;
  discardUpload: (ctx: UploadCtx) => Promise<void>;
};

// Per-record debounce so a burst of keystrokes coalesces into one Dexie write.
const SAVE_DEBOUNCE_MS = 200;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(record: DraftRecord): void {
  const existing = pending.get(record.id);
  if (existing) clearTimeout(existing);
  pending.set(
    record.id,
    setTimeout(() => {
      pending.delete(record.id);
      void db.drafts.put(record);
    }, SAVE_DEBOUNCE_MS),
  );
}

function blankDraft(ctx: UploadCtx, mediaPath: string, deploymentId: string): DraftRecord {
  return {
    id: draftId(ctx.bucket, ctx.uploadPrefix, mediaPath),
    bucket: ctx.bucket,
    uploadPrefix: ctx.uploadPrefix,
    mediaPath,
    deploymentId,
    label: '',
    commonName: '',
    count: 0,
    requestedSpecies: '',
    freeTags: '',
    questionable: false,
    timeOverride: null,
    lastEdited: '',
    dirty: false,
  };
}

export const useDraftStore = create<DraftState>((set, get) => {
  /** Apply the same patch to one or more images in a single state update,
   *  scheduling a debounced Dexie write per touched record. */
  const mutateMany = (ctx: UploadCtx, targets: TagTarget[], patch: Partial<DraftRecord>): void => {
    if (!targets.length) return;
    const now = new Date().toISOString();
    const updates: Record<string, DraftRecord> = {};
    const cur = get().drafts;
    for (const { mediaPath, deploymentId } of targets) {
      const prev = cur[mediaPath] ?? blankDraft(ctx, mediaPath, deploymentId);
      const next: DraftRecord = {
        ...prev,
        deploymentId: deploymentId || prev.deploymentId,
        ...patch,
        lastEdited: now,
        dirty: true,
      };
      updates[mediaPath] = next;
      scheduleSave(next);
    }
    set((s) => ({ drafts: { ...s.drafts, ...updates } }));
  };

  const mutate = (
    ctx: UploadCtx,
    mediaPath: string,
    deploymentId: string,
    patch: Partial<DraftRecord>,
  ): void => mutateMany(ctx, [{ mediaPath, deploymentId }], patch);

  const tagPatch = (tag: AppliedTag): Partial<DraftRecord> => ({
    label: tag.label,
    commonName: tag.commonName,
    count: tag.label ? Math.max(1, tag.count) : 0,
    requestedSpecies: tag.requestedSpecies ?? '',
    freeTags: tag.freeTags ?? '',
  });

  return {
    loadedKey: null,
    loading: false,
    drafts: {},

    loadUpload: async (ctx) => {
      const key = uploadId(ctx.bucket, ctx.uploadPrefix);
      if (get().loadedKey === key) return;
      set({ loading: true, loadedKey: key, drafts: {} });
      const rows = await loadDraftsForUpload(ctx.bucket, ctx.uploadPrefix);
      // Ignore a result that arrived after the user switched uploads.
      if (get().loadedKey !== key) return;
      const map: Record<string, DraftRecord> = {};
      for (const r of rows) map[r.mediaPath] = r;
      // Record the session's upload row (loadedAt) for the eventual P4 grounding.
      void db.uploads.put({
        id: key,
        bucket: ctx.bucket,
        uploadPrefix: ctx.uploadPrefix,
        loadedAt: new Date().toISOString(),
        timeOffset: null,
      });
      set({ loading: false, drafts: map });
    },

    applyTag: (ctx, mediaPath, deploymentId, tag) =>
      mutate(ctx, mediaPath, deploymentId, tagPatch(tag)),

    detag: (ctx, mediaPath, deploymentId) =>
      mutate(ctx, mediaPath, deploymentId, {
        label: '',
        commonName: '',
        count: 0,
        requestedSpecies: '',
      }),

    toggleQuestionable: (ctx, mediaPath, deploymentId) => {
      const prev = get().drafts[mediaPath];
      mutate(ctx, mediaPath, deploymentId, { questionable: !prev?.questionable });
    },

    applyTagMany: (ctx, targets, tag) => mutateMany(ctx, targets, tagPatch(tag)),

    detagMany: (ctx, targets) =>
      mutateMany(ctx, targets, { label: '', commonName: '', count: 0, requestedSpecies: '' }),

    setQuestionableMany: (ctx, targets, value) =>
      mutateMany(ctx, targets, { questionable: value }),

    flushSaves: async () => {
      const records: DraftRecord[] = [];
      for (const [id, timer] of pending) {
        clearTimeout(timer);
        const rec = Object.values(get().drafts).find((d) => d.id === id);
        if (rec) records.push(rec);
      }
      pending.clear();
      if (records.length) await db.drafts.bulkPut(records);
    },

    discardUpload: async (ctx) => {
      await discardUploadDrafts(ctx.bucket, ctx.uploadPrefix);
      if (get().loadedKey === uploadId(ctx.bucket, ctx.uploadPrefix)) set({ drafts: {} });
    },
  };
});

/** Count of dirty drafts in the loaded upload — drives the "N unsaved" readout. */
export function dirtyCount(drafts: Record<string, DraftRecord>): number {
  let n = 0;
  for (const id in drafts) if (drafts[id].dirty) n++;
  return n;
}
