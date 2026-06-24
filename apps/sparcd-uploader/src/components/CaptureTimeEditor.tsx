import { useState } from 'react';
import { useStore, type FileEntry } from '../store';
import { naiveToInputValue, inputValueToNaive } from '../lib/exifTime';

// Manual capture-time entry for files whose EXIF/container metadata had none.
// The entered wall-clock is stored raw (naive) and interpreted in the upload
// timezone at bundle build, exactly like an EXIF time — so it lands in media.csv
// col 4 and a published batch never carries an empty capture time.

const inputClass =
  'border border-rule bg-paper px-2.5 py-1.5 font-mono text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1';

export function CaptureTimeEditor({ files }: { files: FileEntry[] }) {
  const setManualNaive = useStore((s) => s.setManualNaive);
  const [bulk, setBulk] = useState('');

  const needing = files.filter(
    (f) => f.processState === 'ready' && !f.exifNaive,
  );
  const unset = needing.filter((f) => !f.manualNaive);

  const applyBulkToUnset = () => {
    const naive = inputValueToNaive(bulk);
    if (!naive) return;
    for (const f of unset) setManualNaive(f.id, naive);
  };

  return (
    <div className="space-y-3">
      <div
        className={`border px-3 py-2.5 font-body text-[13px] ${
          unset.length ? 'border-warn/40 text-warn bg-paper' : 'border-ruleSoft text-inkSoft bg-paper'
        }`}
      >
        {unset.length
          ? `${unset.length} of ${needing.length} file(s) still need a capture time.`
          : `All ${needing.length} previously-missing file(s) now have a manual capture time.`}
      </div>

      <p className="font-body text-[12px] text-inkMute">
        Cameras sometimes omit a capture time. Enter the wall-clock the camera would have written; it
        is interpreted in the upload timezone above, exactly like an EXIF time, and written to{' '}
        <span className="font-mono">media.csv</span>.
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="font-[600] text-[10px] tracking-[0.12em] uppercase text-inkSoft">
            Bulk set
          </span>
          <input
            type="datetime-local"
            step={1}
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
            className={inputClass}
          />
        </label>
        <button
          type="button"
          onClick={applyBulkToUnset}
          disabled={!inputValueToNaive(bulk) || unset.length === 0}
          className="border border-ink text-ink px-3 py-1.5 text-[13px] font-body hover:bg-paperHover disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        >
          Apply to {unset.length} unset
        </button>
      </div>

      <div className="max-h-[280px] overflow-auto border border-ruleSoft divide-y divide-ruleSoft">
        {needing.map((f) => (
          <div key={f.id} className="flex items-center gap-2 px-2.5 py-1.5">
            <span className="font-mono text-[12px] text-inkSoft truncate flex-1" title={f.relPath}>
              {f.relPath}
            </span>
            <input
              type="datetime-local"
              step={1}
              value={f.manualNaive ? naiveToInputValue(f.manualNaive) : ''}
              onChange={(e) => setManualNaive(f.id, inputValueToNaive(e.target.value))}
              className={inputClass}
            />
            {f.manualNaive && (
              <button
                type="button"
                onClick={() => setManualNaive(f.id, null)}
                className="text-[12px] font-mono text-inkMute hover:text-warn px-1"
                title="Clear"
                aria-label={`Clear capture time for ${f.relPath}`}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
