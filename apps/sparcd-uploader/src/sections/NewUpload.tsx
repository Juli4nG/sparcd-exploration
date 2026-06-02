import { useStore } from '../store';
import { StepIndicator } from '../components/StepIndicator';
import { DropZone } from '../components/DropZone';
import { FileList } from '../components/FileList';
import { formatBytes } from '../lib/scanFiles';

function LaterPhase({ title, note }: { title: string; note: string }) {
  return (
    <div className="max-w-2xl mx-auto border border-ruleSoft bg-panel px-6 py-10 text-center">
      <p className="font-display text-[18px] text-ink mb-1">{title}</p>
      <p className="font-body text-[14px] text-inkSoft">{note}</p>
    </div>
  );
}

export function NewUpload() {
  const step = useStore((s) => s.step);
  const files = useStore((s) => s.files);
  const resetBatch = useStore((s) => s.resetBatch);

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  return (
    <div className="px-6 py-6">
      <div className="mb-6">
        <StepIndicator current={step} />
      </div>

      {step === 'drop' && <DropZone />}

      {step === 'inspect' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="font-body text-[14px] text-inkSoft">
              <span className="font-mono text-ink">{files.length}</span> files ·{' '}
              <span className="font-mono text-ink">{formatBytes(totalBytes)}</span>
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={resetBatch}
                className="border border-ink text-ink px-3.5 py-1.5 text-[14px] font-body hover:bg-paperHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              >
                Start over
              </button>
              <button
                disabled
                title="EXIF, hashing, validation, and assignment arrive in later phases"
                className="bg-ink text-paper border border-ink px-3.5 py-1.5 text-[14px] font-body font-[600] opacity-40 cursor-not-allowed"
              >
                Continue
              </button>
            </div>
          </div>
          <FileList />
          <p className="font-body text-[13px] text-inkMute">
            EXIF timestamps, SHA-256 hashing, thumbnails, and per-file validation arrive in P1.
            Assignment (P2) and upload (P4) follow.
          </p>
        </div>
      )}

      {step === 'assign' && (
        <LaterPhase
          title="Assign — coming in P2"
          note="Deployment picker, uploader identity, and the metadata preview land here."
        />
      )}

      {step === 'upload' && (
        <LaterPhase
          title="Upload — coming in P4"
          note="Streaming blob uploads, blob staging, and the completion sentinel land here."
        />
      )}
    </div>
  );
}
