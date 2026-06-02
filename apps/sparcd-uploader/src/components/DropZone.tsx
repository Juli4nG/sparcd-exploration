import { useRef, useState } from 'react';
import { useStore } from '../store';
import { scanDataTransfer, scanFileList, type ScannedFile } from '../lib/scanFiles';

export function DropZone() {
  const setFiles = useStore((s) => s.setFiles);
  const setScanning = useStore((s) => s.setScanning);
  const scanning = useStore((s) => s.scanning);
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function commit(scan: () => Promise<ScannedFile[]> | ScannedFile[]) {
    setScanning(true);
    try {
      setFiles(await scan());
    } finally {
      setScanning(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setHover(false);
    const items = e.dataTransfer.items;
    if (items && items.length) void commit(() => scanDataTransfer(items));
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop a folder of JPEGs, or choose a folder"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={onDrop}
        className={`border ${
          hover ? 'border-accent bg-accentSoft' : 'border-rule bg-panel'
        } px-8 py-16 text-center cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2`}
      >
        {scanning ? (
          <p className="font-body text-[15px] text-inkSoft">Scanning folder…</p>
        ) : (
          <>
            <p className="font-display text-[20px] text-ink mb-1">Drop a folder of images</p>
            <p className="font-body text-[14px] text-inkSoft mb-5">
              JPEG only. Subfolders are scanned recursively.
            </p>
            <span className="inline-block bg-ink text-paper border border-ink px-4 py-2 text-[14px] font-body font-[600]">
              Choose folder
            </span>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        // @ts-expect-error — non-standard but widely supported folder picker
        webkitdirectory=""
        directory=""
        multiple
        hidden
        onChange={(e) => {
          const list = e.target.files;
          if (list && list.length) void commit(() => scanFileList(list));
          e.target.value = '';
        }}
      />
    </div>
  );
}
