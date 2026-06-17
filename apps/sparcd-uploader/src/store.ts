import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { S3Config } from '@sparcd/types';
import type { ScannedFile } from './lib/scanFiles';
import type { ProcessResponse } from './lib/processPool';
import type { FileAccessMode } from './lib/db';
import { validateBatch, type FileValidation } from './lib/validation';
import { clearClientCache } from './lib/s3';
import { localTimeZone, type NaiveDateTime } from './lib/exifTime';

export type Section = 'new' | 'history' | 'settings';
export type WizardStep = 'drop' | 'inspect' | 'assign' | 'upload';
export type Theme = 'light' | 'dark';
export type ProcessState = 'queued' | 'processing' | 'ready' | 'error';

/** A scanned file plus the results of P1 worker processing. */
export type FileEntry = ScannedFile & {
  processState: ProcessState;
  sha256?: string;
  exifNaive?: NaiveDateTime; // naive wall-clock components, no zone
  exifCamera?: string;
  gps?: { lat: number; lon: number };
  width?: number;
  height?: number;
  thumbnail?: Blob;
  mimeType?: string; // worker-authoritative media type
  processError?: string;
};

type UploaderState = {
  s3Config: S3Config | null;
  connectionId: number; // increments on connect/disconnect to scope client-side caches
  section: Section;
  theme: Theme;
  step: WizardStep;
  files: FileEntry[];
  validations: Record<string, FileValidation>;
  scanning: boolean;
  processing: boolean;
  batchToken: number; // bumps each new batch; identifies a processing run
  // A durable folder handle when the browser granted one (Chromium); drives the
  // resume access mode so a closed tab can re-read the same bytes.
  dirHandle: FileSystemDirectoryHandle | null;
  fileAccessMode: FileAccessMode;
  uploaderUser: string; // free-text identity, normalized into a slug for keys
  selectedLocationKey: string | null; // chosen deployment location key (Assign)
  selectedBucket: string | null; // selected collection key `${bucket}::${uuid}` (Assign)
  uploadDescription: string; // free-text description for UploadMeta
  uploadTimeZone: string; // IANA zone EXIF naive times are interpreted in; default = browser zone
  dryRun: boolean; // on by default; logs PUTs and writes nothing
  uploadConcurrency: number; // parallel blob lanes, 4–16

  connect: (config: S3Config) => void;
  disconnect: () => void;
  setSection: (section: Section) => void;
  toggleTheme: () => void;
  setStep: (step: WizardStep) => void;
  setScanning: (scanning: boolean) => void;
  setProcessing: (processing: boolean) => void;
  setFiles: (files: ScannedFile[], dirHandle?: FileSystemDirectoryHandle | null) => void;
  markProcessing: (id: string) => void;
  applyResult: (result: ProcessResponse) => void;
  setThumbnail: (id: string, thumbnail: Blob) => void;
  removeFile: (id: string) => void;
  resetBatch: () => void;
  setUploaderUser: (value: string) => void;
  setSelectedLocationKey: (key: string | null) => void;
  setSelectedBucket: (bucket: string | null) => void;
  setUploadDescription: (value: string) => void;
  setUploadTimeZone: (value: string) => void;
  setDryRun: (value: boolean) => void;
  setUploadConcurrency: (value: number) => void;
  nextBatch: () => void;
};

const toEntry = (f: ScannedFile): FileEntry => ({ ...f, processState: 'queued' });

export const useStore = create<UploaderState>()(
  // Persist only the connection + cheap UI prefs, in sessionStorage: the login
  // survives an HMR/Cmd-R reload within the tab but is dropped when the tab
  // closes, so a fresh tab starts at the connect gate and the S3 secret key
  // never lands on disk. The in-flight batch (files, handles, validations) is
  // deliberately not persisted — see `partialize`.
  persist(
    (set) => ({
      s3Config: null,
      connectionId: 0,
      section: 'new',
      theme: 'light',
      step: 'drop',
      files: [],
      validations: {},
      scanning: false,
      processing: false,
      batchToken: 0,
      dirHandle: null,
      fileAccessMode: 'reselect-required',
      uploaderUser: '',
      selectedLocationKey: null,
      selectedBucket: null,
      uploadDescription: '',
      uploadTimeZone: localTimeZone(),
      dryRun: true,
      uploadConcurrency: 8,

      connect: (config) => {
        clearClientCache();
        set((s) => ({
          s3Config: config,
          connectionId: s.connectionId + 1,
          selectedLocationKey: null,
          selectedBucket: null,
        }));
      },
      disconnect: () => {
        clearClientCache();
        set((s) => ({
          s3Config: null,
          connectionId: s.connectionId + 1,
          section: 'new',
          step: 'drop',
          files: [],
          validations: {},
          dirHandle: null,
          fileAccessMode: 'reselect-required',
          selectedLocationKey: null,
          selectedBucket: null,
          uploaderUser: '',
          uploadTimeZone: localTimeZone(),
        }));
      },
      setSection: (section) => set({ section }),
      toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
      setStep: (step) => set({ step }),
      setScanning: (scanning) => set({ scanning }),
      setProcessing: (processing) => set({ processing }),

      // De-dupe by relPath; a re-scan replaces the batch wholesale and bumps the
      // token so the processing controller starts a fresh run.
      setFiles: (scanned, dirHandle = null) => {
        const seen = new Set<string>();
        const entries = scanned
          .filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)))
          .map(toEntry);
        set((s) => ({
          files: entries,
          validations: validateBatch(entries),
          step: entries.length > 0 ? 'inspect' : 'drop',
          batchToken: s.batchToken + 1,
          dirHandle,
          fileAccessMode: dirHandle ? 'persistent-handle' : 'reselect-required',
        }));
      },

      markProcessing: (id) =>
        set((s) => ({
          files: s.files.map((f) => (f.id === id ? { ...f, processState: 'processing' } : f)),
        })),

      applyResult: (result) =>
        set((s) => {
          const files = s.files.map((f) => {
            if (f.id !== result.id) return f;
            if (result.error)
              return { ...f, processState: 'error' as const, processError: result.error };
            return {
              ...f,
              processState: 'ready' as const,
              sha256: result.sha256,
              exifNaive: result.exifNaive,
              exifCamera: result.exifCamera,
              gps: result.gps,
              width: result.width,
              height: result.height,
              thumbnail: result.thumbnail,
              mimeType: result.mimeType,
            };
          });
          return { files, validations: validateBatch(files) };
        }),

      // Attach a best-effort poster after the fact (video frames are captured on
      // the main thread, post-worker). No validation re-run: a poster never
      // changes a verdict.
      setThumbnail: (id, thumbnail) =>
        set((s) => ({
          files: s.files.map((f) => (f.id === id ? { ...f, thumbnail } : f)),
        })),

      removeFile: (id) =>
        set((s) => {
          const files = s.files.filter((f) => f.id !== id);
          return { files, validations: validateBatch(files) };
        }),

      resetBatch: () =>
        set((s) => ({
          files: [],
          validations: {},
          step: 'drop',
          batchToken: s.batchToken + 1,
          dirHandle: null,
          fileAccessMode: 'reselect-required',
        })),

      // Stored raw; sanitizeUploaderUser derives the key-safe slug at point of use.
      setUploaderUser: (value) => set({ uploaderUser: value }),
      setSelectedLocationKey: (key) => set({ selectedLocationKey: key }),
      setSelectedBucket: (bucket) => set({ selectedBucket: bucket }),
      setUploadDescription: (value) => set({ uploadDescription: value }),
      setUploadTimeZone: (value) => set({ uploadTimeZone: value }),
      setDryRun: (value) => set({ dryRun: value }),
      setUploadConcurrency: (value) => set({ uploadConcurrency: value }),

      // Start a fresh batch after a completed upload, keeping the deployment,
      // uploader, target collection, and description so a researcher can chain
      // batches for the same site without re-entering everything.
      nextBatch: () =>
        set((s) => ({
          files: [],
          validations: {},
          step: 'drop',
          batchToken: s.batchToken + 1,
          dirHandle: null,
          fileAccessMode: 'reselect-required',
        })),
    }),
    {
      name: 'sparcd-uploader-session',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ s3Config: s.s3Config, theme: s.theme }),
    },
  ),
);
