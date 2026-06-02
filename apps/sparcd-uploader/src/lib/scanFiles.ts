// Recursive folder scan for both entry points: drag-drop (DataTransferItem +
// webkitGetAsEntry) and the "Choose folder" picker (<input webkitdirectory>).
// Produces a flat list of JPEGs with their bundle-relative paths. EXIF, hash,
// thumbnail, and validation are P1 — P0 surfaces filename + size only.

export type ScannedFile = {
  id: string; // relPath; unique within a scan
  file: File;
  relPath: string; // path within the dropped folder, leading "/" stripped
  fileName: string;
  size: number;
};

function isJpeg(name: string, type: string): boolean {
  if (type === 'image/jpeg') return true;
  return /\.jpe?g$/i.test(name);
}

// A FileSystemDirectoryReader returns entries in batches; keep calling until
// it yields an empty array.
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const pump = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(out);
          return;
        }
        out.push(...batch);
        pump();
      }, reject);
    };
    pump();
  });
}

function entryToFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walkEntry(entry: FileSystemEntry, acc: ScannedFile[]): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await entryToFile(fileEntry);
    if (!isJpeg(file.name, file.type)) return;
    const relPath = entry.fullPath.replace(/^\//, '');
    acc.push({ id: relPath, file, relPath, fileName: file.name, size: file.size });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children = await readAllEntries(reader);
    for (const child of children) {
      await walkEntry(child, acc);
    }
  }
}

/** Scan a drop event's items recursively. */
export async function scanDataTransfer(items: DataTransferItemList): Promise<ScannedFile[]> {
  const roots: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  const acc: ScannedFile[] = [];
  for (const root of roots) {
    await walkEntry(root, acc);
  }
  return acc;
}

/** Scan a <input webkitdirectory> FileList. */
export function scanFileList(list: FileList): ScannedFile[] {
  const acc: ScannedFile[] = [];
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    if (!isJpeg(file.name, file.type)) continue;
    const relPath = (file.webkitRelativePath || file.name).replace(/^\//, '');
    acc.push({ id: relPath, file, relPath, fileName: file.name, size: file.size });
  }
  return acc;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
