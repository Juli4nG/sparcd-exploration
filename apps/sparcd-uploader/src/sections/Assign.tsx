import { useEffect } from 'react';
import { useStore } from '../store';
import { useLocations } from '../lib/useLocations';
import { useCollections, useCollectionName } from '../lib/useCollections';
import { DeploymentPicker } from '../components/DeploymentPicker';
import { MetadataPreview } from '../components/MetadataPreview';
import { sanitizeUploaderUser } from '../lib/normalize';

// The collection authorized for this workspace; preselected when present.
const DEFAULT_BUCKET = 'sparcd-8dbd9c43-5c3d-411d-8778-617d4693c69b';

const sectionLabel =
  'font-[600] text-[11px] tracking-[0.16em] uppercase text-inkSoft mb-2';

function LocationsState({ message, tone }: { message: string; tone: 'mute' | 'warn' }) {
  return (
    <div
      className={`border px-3 py-2.5 font-body text-[13px] ${
        tone === 'warn' ? 'border-warn/40 text-warn bg-paper' : 'border-ruleSoft text-inkSoft bg-paper'
      }`}
    >
      {message}
    </div>
  );
}

export function Assign() {
  const s3Config = useStore((s) => s.s3Config);
  const setStep = useStore((s) => s.setStep);
  const uploaderUser = useStore((s) => s.uploaderUser);
  const setUploaderUser = useStore((s) => s.setUploaderUser);
  const description = useStore((s) => s.uploadDescription);
  const setDescription = useStore((s) => s.setUploadDescription);
  const selectedLocationKey = useStore((s) => s.selectedLocationKey);
  const setSelectedLocationKey = useStore((s) => s.setSelectedLocationKey);
  const selectedBucket = useStore((s) => s.selectedBucket);
  const setSelectedBucket = useStore((s) => s.setSelectedBucket);
  const files = useStore((s) => s.files);

  const { data, isLoading, isError, error } = useLocations(s3Config);
  const collections = useCollections(s3Config);
  const slug = sanitizeUploaderUser(uploaderUser);

  // Preselect the authorized collection (else the first discovered) once.
  useEffect(() => {
    if (selectedBucket || !collections.data?.length) return;
    const def = collections.data.find((c) => c.bucket === DEFAULT_BUCKET);
    setSelectedBucket((def ?? collections.data[0]).bucket);
  }, [collections.data, selectedBucket, setSelectedBucket]);

  const collection = collections.data?.find((c) => c.bucket === selectedBucket) ?? null;
  const collectionName = useCollectionName(s3Config, collection);
  const location = data?.locations.find((l) => l.key === selectedLocationKey) ?? null;
  const canContinue = !!selectedLocationKey && !!slug && !!collection;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <section>
        <h2 className={sectionLabel}>Deployment</h2>
        {isLoading && <LocationsState tone="mute" message="Loading locations…" />}
        {isError && (
          <LocationsState
            tone="warn"
            message={(error as Error)?.message ?? 'Could not load locations.'}
          />
        )}
        {data && (
          <div className="space-y-2">
            <DeploymentPicker
              locations={data.locations}
              value={selectedLocationKey}
              onChange={setSelectedLocationKey}
            />
            <p className="font-body text-[12px] text-inkMute">
              <span className="font-mono text-inkSoft">{data.locations.length}</span> locations from{' '}
              <span className="font-mono text-inkSoft">{data.settingsBucket}</span>
              {'/'}
              <span className="font-mono text-inkSoft">Settings/locations.json</span>
              {data.skipped.length > 0 && (
                <>
                  {' · '}
                  <span className="text-warn">{data.skipped.length}</span> skipped (
                  {data.skipped[0].reason}
                  {data.skipped.length > 1 ? ', …' : ''})
                </>
              )}
              . Each becomes <span className="font-mono">deployment_id</span> ={' '}
              <span className="font-mono">&lt;collection-uuid&gt;:&lt;location-id&gt;</span>.
            </p>
          </div>
        )}
      </section>

      <section>
        <h2 className={sectionLabel}>Uploader</h2>
        <input
          value={uploaderUser}
          onChange={(e) => setUploaderUser(e.target.value)}
          placeholder="e.g. Sara Malusa"
          className="w-full border border-rule bg-paper px-3 py-2 font-body text-[14px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        />
        <p className="font-body text-[12px] text-inkMute mt-1.5">
          Stamped into the upload prefix and object keys as{' '}
          {slug ? (
            <span className="font-mono text-inkSoft">{slug}</span>
          ) : (
            <span className="italic">a key-safe slug</span>
          )}
          . Set a default in Settings.
        </p>
      </section>

      <section>
        <h2 className={sectionLabel}>Description</h2>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="What this batch is — site, date range, notes."
          className="w-full border border-rule bg-paper px-3 py-2 font-body text-[14px] text-ink resize-y focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        />
        <p className="font-body text-[12px] text-inkMute mt-1.5">
          Saved to <span className="font-mono">UploadMeta.json</span> as the upload description.
        </p>
      </section>

      <section>
        <h2 className={sectionLabel}>Target collection</h2>
        {collections.isLoading && <LocationsState tone="mute" message="Discovering collections…" />}
        {collections.isError && (
          <LocationsState
            tone="warn"
            message={(collections.error as Error)?.message ?? 'Could not list collections.'}
          />
        )}
        {collections.data && (
          <div className="space-y-1.5">
            <select
              value={selectedBucket ?? ''}
              onChange={(e) => setSelectedBucket(e.target.value || null)}
              className="w-full border border-rule bg-paper px-3 py-2 font-mono text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
            >
              {collections.data.map((c) => (
                <option key={c.bucket} value={c.bucket}>
                  {c.bucket}
                </option>
              ))}
            </select>
            <p className="font-body text-[12px] text-inkMute">
              {collectionName.data ? (
                <>
                  <span className="text-inkSoft">{collectionName.data}</span> ·{' '}
                </>
              ) : null}
              Uploads land in this bucket under{' '}
              <span className="font-mono">Collections/{collection?.uuid ?? '<uuid>'}/Uploads/</span>.
            </p>
          </div>
        )}
      </section>

      <section>
        <h2 className={sectionLabel}>Preview</h2>
        {location && collection && slug ? (
          <MetadataPreview
            location={location}
            collectionUuid={collection.uuid}
            bucket={collection.bucket}
            uploaderSlug={slug}
            description={description}
            files={files}
          />
        ) : (
          <LocationsState
            tone="mute"
            message="Select a deployment, a target collection, and an uploader identity to preview the bundle."
          />
        )}
      </section>

      <div className="flex items-center justify-between gap-4 border-t border-ruleSoft pt-5">
        <button
          onClick={() => setStep('inspect')}
          className="border border-ink text-ink px-3.5 py-1.5 text-[14px] font-body hover:bg-paperHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        >
          Back
        </button>
        <button
          disabled={!canContinue}
          onClick={() => setStep('upload')}
          title={
            canContinue
              ? 'Continue to upload'
              : !selectedLocationKey
                ? 'Select a deployment location first'
                : !collection
                  ? 'Select a target collection first'
                  : 'Set an uploader identity first'
          }
          className={`bg-ink text-paper border border-ink px-3.5 py-1.5 text-[14px] font-body font-[600] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
            canContinue ? 'hover:opacity-90' : 'opacity-40 cursor-not-allowed'
          }`}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
