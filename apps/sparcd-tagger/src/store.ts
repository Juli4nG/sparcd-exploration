import { create } from 'zustand';
import type { S3Config } from '@sparcd/types';
import { clearClientCache } from './lib/s3';

export type Section = 'browse' | 'tag' | 'history' | 'settings';
export type Theme = 'light' | 'dark';

/** Top-bar sync state. P0 is read-only, so live values are `local-only`; the
 *  rest of the union exists so the pill is built once and P4 just feeds it. */
export type SyncState =
  | 'local-only'
  | 'unsynced'
  | 'syncing'
  | 'synced'
  | 'conflict'
  | 'dry-run'
  | 'error';

type TaggerState = {
  s3Config: S3Config | null;
  connectionId: number; // increments on connect/disconnect to scope client-side caches
  section: Section;
  theme: Theme;
  syncState: SyncState;

  // What the researcher has drilled into (Browse → Tag).
  selectedCollectionKey: string | null; // `${bucket}::${uuid}`
  selectedUploadPrefix: string | null; // full `Collections/<uuid>/Uploads/<stamp>/`

  // Settings (the login gate stays three-field; identity + dry-run live here).
  taggerUser: string; // logical userId for snapshot paths + editComments
  dryRun: boolean; // on by default; P4 sync logs and writes nothing until off
  burstThresholdSec: number; // sequence grouping threshold (5–600s)

  connect: (config: S3Config) => void;
  disconnect: () => void;
  setSection: (section: Section) => void;
  toggleTheme: () => void;
  selectCollection: (key: string | null) => void;
  selectUpload: (prefix: string | null) => void;
  setSyncState: (state: SyncState) => void;
  setTaggerUser: (value: string) => void;
  setDryRun: (value: boolean) => void;
  setBurstThreshold: (value: number) => void;
};

export const useStore = create<TaggerState>((set) => ({
  s3Config: null,
  connectionId: 0,
  section: 'browse',
  theme: 'light',
  syncState: 'local-only',
  selectedCollectionKey: null,
  selectedUploadPrefix: null,
  taggerUser: '',
  dryRun: true,
  burstThresholdSec: 60,

  connect: (config) => {
    clearClientCache();
    set((s) => ({
      s3Config: config,
      connectionId: s.connectionId + 1,
      selectedCollectionKey: null,
      selectedUploadPrefix: null,
    }));
  },
  disconnect: () => {
    clearClientCache();
    set((s) => ({
      s3Config: null,
      connectionId: s.connectionId + 1,
      section: 'browse',
      selectedCollectionKey: null,
      selectedUploadPrefix: null,
    }));
  },
  setSection: (section) => set({ section }),
  toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
  selectCollection: (key) =>
    set({ selectedCollectionKey: key, selectedUploadPrefix: null, syncState: 'local-only' }),
  selectUpload: (prefix) =>
    set({ selectedUploadPrefix: prefix, section: prefix ? 'tag' : 'browse', syncState: 'local-only' }),
  setSyncState: (state) => set({ syncState: state }),
  setTaggerUser: (value) => set({ taggerUser: value }),
  setDryRun: (value) => set({ dryRun: value }),
  setBurstThreshold: (value) => set({ burstThresholdSec: value }),
}));
