import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { useDraftStore } from '../lib/drafts';
import { listDirtyDrafts, type DraftRecord } from '../lib/db';

// Local recovery view (History section). This surfaces every upload that still
// has unsaved drafts in IndexedDB so a closed/reopened tab can jump back to its
// work or discard it. The S3 snapshot/version recovery flow (restoring prior
// canonical snapshots, P5) is per-upload and lives in the Tag workspace's
// "Snapshots…" action, where the upload's bucket/prefix context exists; a
// cross-upload snapshot browser is the P6 History section's job.

type Group = {
  bucket: string;
  uploadPrefix: string;
  collectionKey: string; // `${bucket}::${uuid}` — what the store/Tag workspace key on
  stamp: string;
  count: number; // dirty drafts
  taggedCount: number; // dirty drafts carrying a species/label
  lastEdited: string;
};

// uploadPrefix is `Collections/<uuid>/Uploads/<stamp>/`.
function uuidOf(uploadPrefix: string): string {
  return /Collections\/([^/]+)\/Uploads\//.exec(uploadPrefix)?.[1] ?? '';
}
function stampOf(uploadPrefix: string): string {
  return uploadPrefix.replace(/\/$/, '').split('/').pop() ?? uploadPrefix;
}

function groupDirty(rows: DraftRecord[]): Group[] {
  const byUpload = new Map<string, Group>();
  for (const r of rows) {
    const id = `${r.bucket}::${r.uploadPrefix}`;
    let g = byUpload.get(id);
    if (!g) {
      g = {
        bucket: r.bucket,
        uploadPrefix: r.uploadPrefix,
        collectionKey: `${r.bucket}::${uuidOf(r.uploadPrefix)}`,
        stamp: stampOf(r.uploadPrefix),
        count: 0,
        taggedCount: 0,
        lastEdited: '',
      };
      byUpload.set(id, g);
    }
    g.count++;
    if (r.label) g.taggedCount++;
    if (r.lastEdited > g.lastEdited) g.lastEdited = r.lastEdited;
  }
  return [...byUpload.values()].sort((a, b) => b.lastEdited.localeCompare(a.lastEdited));
}

export function Recovery() {
  const selectCollection = useStore((s) => s.selectCollection);
  const selectUpload = useStore((s) => s.selectUpload);
  const discardUpload = useDraftStore((s) => s.discardUpload);
  // Re-derive whenever the in-memory drafts change (a fresh edit/discard while
  // the History tab is open should refresh the list).
  const liveDrafts = useDraftStore((s) => s.drafts);

  const [groups, setGroups] = useState<Group[] | null>(null);

  const refresh = useCallback(async () => {
    setGroups(groupDirty(await listDirtyDrafts()));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, liveDrafts]);

  const open = (g: Group) => {
    selectCollection(g.collectionKey); // resets upload selection
    selectUpload(g.uploadPrefix); // sets section → 'tag'
  };

  const discard = async (g: Group) => {
    if (!confirm(`Discard ${g.count} unsaved local edit(s) for ${g.stamp}?`)) return;
    await discardUpload({ bucket: g.bucket, uploadPrefix: g.uploadPrefix });
    await refresh();
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-[760px] mx-auto space-y-4">
        <header>
          <h1 className="font-display text-[22px] text-ink">Recovery</h1>
          <p className="text-[13px] text-inkSoft font-body mt-1">
            Uploads with unsaved local edits, kept in this browser. Reopen one to keep tagging or
            discard its local changes. To restore a prior <em>synced</em> snapshot, open the upload
            and use the Tag workspace’s “Snapshots…” action.
          </p>
        </header>

        {groups === null && <p className="text-[13px] text-inkMute font-body">Scanning local drafts…</p>}

        {groups && groups.length === 0 && (
          <p className="text-[14px] text-inkMute font-body border border-ruleSoft bg-panel px-4 py-6 text-center">
            No unsaved local edits. Everything here is clean.
          </p>
        )}

        {groups && groups.length > 0 && (
          <ul className="space-y-2">
            {groups.map((g) => (
              <li
                key={`${g.bucket}::${g.uploadPrefix}`}
                className="border border-rule bg-panel px-4 py-3 flex items-center gap-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[14px] text-ink truncate" title={g.uploadPrefix}>
                    {g.stamp}
                  </div>
                  <div className="font-mono text-[12px] text-inkMute truncate" title={g.bucket}>
                    {g.bucket}
                  </div>
                  <div className="text-[12px] text-inkSoft font-body mt-0.5">
                    {g.count} unsaved · {g.taggedCount} tagged · edited {shortTime(g.lastEdited)}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => open(g)}
                    className="text-[13px] border border-ink px-3 py-1.5 text-ink hover:bg-panelHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    Open →
                  </button>
                  <button
                    onClick={() => void discard(g)}
                    className="text-[13px] border border-rule px-3 py-1.5 text-inkSoft hover:text-warn hover:border-warn focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function shortTime(iso: string): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');
}
