import { useEffect, useMemo } from 'react';
import { useStore } from '../store';
import { useLocations } from '../lib/useLocations';
import { useCollections, useCollectionDeployments } from '../lib/useCollections';
import { DeploymentPicker } from '../components/DeploymentPicker';
import { CollectionPicker } from '../components/CollectionPicker';
import { MetadataPreview } from '../components/MetadataPreview';
import { CaptureTimeEditor } from '../components/CaptureTimeEditor';
import { sanitizeUploaderUser } from '../lib/normalize';
import { supportedTimeZones } from '../lib/exifTime';
import { captureTimeComplete } from '../lib/validation';

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
  const connectionId = useStore((s) => s.connectionId);
  const setStep = useStore((s) => s.setStep);
  const uploaderUser = useStore((s) => s.uploaderUser);
  const setUploaderUser = useStore((s) => s.setUploaderUser);
  const description = useStore((s) => s.uploadDescription);
  const setDescription = useStore((s) => s.setUploadDescription);
  const uploadTimeZone = useStore((s) => s.uploadTimeZone);
  const setUploadTimeZone = useStore((s) => s.setUploadTimeZone);
  const selectedLocationKey = useStore((s) => s.selectedLocationKey);
  const setSelectedLocationKey = useStore((s) => s.setSelectedLocationKey);
  const selectedBucket = useStore((s) => s.selectedBucket);
  const setSelectedBucket = useStore((s) => s.setSelectedBucket);
  const elevationUnit = useStore((s) => s.elevationUnit);
  const setElevationUnit = useStore((s) => s.setElevationUnit);
  const files = useStore((s) => s.files);

  const { data, isLoading, isError, error } = useLocations(s3Config, connectionId);
  const collections = useCollections(s3Config, connectionId);
  const slug = sanitizeUploaderUser(uploaderUser);

  // Preselect the first collection the connected credentials can read.
  useEffect(() => {
    if (!collections.data?.length) return;
    if (selectedBucket && collections.data.some((c) => c.key === selectedBucket || c.bucket === selectedBucket)) {
      return;
    }
    setSelectedBucket(collections.data[0].key);
  }, [collections.data, selectedBucket, setSelectedBucket]);

  const collection =
    collections.data?.find((c) => c.key === selectedBucket || c.bucket === selectedBucket) ?? null;

  // Strict filter: the deployment picker only shows locations this collection
  // has already deployed (derived from its uploads' deployments.csv).
  const deployments = useCollectionDeployments(s3Config, connectionId, collection);
  const collectionLocations = useMemo(() => {
    if (!data?.locations || !deployments.data) return [];
    const used = new Set(deployments.data);
    return data.locations.filter((l) => used.has(l.id));
  }, [data?.locations, deployments.data]);

  // Drop a stale location selection when it isn't among the chosen collection's
  // deployments (e.g. after switching collections).
  useEffect(() => {
    if (!deployments.data) return;
    if (selectedLocationKey && !collectionLocations.some((l) => l.key === selectedLocationKey)) {
      setSelectedLocationKey(null);
    }
  }, [collectionLocations, deployments.data, selectedLocationKey, setSelectedLocationKey]);

  const location = collectionLocations.find((l) => l.key === selectedLocationKey) ?? null;
  const needsCaptureTime = files.some(
    (f) => f.processState === 'ready' && !f.exifNaive,
  );
  const captureComplete = captureTimeComplete(files);
  const canContinue = !!selectedLocationKey && !!slug && !!collection && captureComplete;

  // The chosen zone is always offered even if it isn't in the platform's list.
  const timeZones = useMemo(() => {
    const all = supportedTimeZones();
    return all.includes(uploadTimeZone) ? all : [uploadTimeZone, ...all];
  }, [uploadTimeZone]);

  return (
    <div className="max-w-2xl mx-auto space-y-8">
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
            {collections.data.length === 0 ? (
              <LocationsState
                tone="warn"
                message="No collections found. The connected credentials must be able to read Collections/<uuid>/collection.json in a sparcd-<uuid> bucket, and that bucket must allow this web origin via CORS."
              />
            ) : (
              <>
                <CollectionPicker
                  collections={collections.data}
                  value={selectedBucket}
                  onChange={(key) => setSelectedBucket(key)}
                />
                <p className="font-body text-[12px] text-inkMute">
                  {collection?.name ? (
                    <>
                      <span className="text-inkSoft">{collection.name}</span> ·{' '}
                    </>
                  ) : null}
                  Discovered from{' '}
                  <span className="font-mono">Collections/{collection?.uuid ?? '<uuid>'}/collection.json</span>
                  . Uploads land in this bucket under{' '}
                  <span className="font-mono">Collections/{collection?.uuid ?? '<uuid>'}/Uploads/</span>.
                </p>
              </>
            )}
          </div>
        )}
      </section>

      <section>
        <h2 className={sectionLabel}>Deployment</h2>
        {(isLoading || (collection && deployments.isLoading)) && (
          <LocationsState tone="mute" message="Loading this collection's deployments…" />
        )}
        {isError && (
          <LocationsState
            tone="warn"
            message={(error as Error)?.message ?? 'Could not load locations.'}
          />
        )}
        {data && deployments.isError && (
          <LocationsState
            tone="warn"
            message={(deployments.error as Error)?.message ?? 'Could not read this collection’s deployments.'}
          />
        )}
        {data && !collection && (
          <LocationsState tone="mute" message="Select a target collection first." />
        )}
        {data && collection && deployments.data && (
          <div className="space-y-2">
            {collectionLocations.length === 0 ? (
              <LocationsState
                tone="warn"
                message="This collection has no deployments yet. Only locations it has already uploaded to can be selected here."
              />
            ) : (
              <DeploymentPicker
                locations={collectionLocations}
                value={selectedLocationKey}
                onChange={setSelectedLocationKey}
                elevationUnit={elevationUnit}
              />
            )}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="font-body text-[12px] text-inkMute">
                <span className="font-mono text-inkSoft">{collectionLocations.length}</span> of{' '}
                <span className="font-mono text-inkSoft">{data.locations.length}</span> locations —
                filtered to those <span className="font-mono">{collection.uuid}</span> has already
                deployed. Each becomes <span className="font-mono">deployment_id</span> ={' '}
                <span className="font-mono">&lt;collection-uuid&gt;:&lt;location-id&gt;</span>.
              </p>
              <label className="flex items-center gap-1.5 shrink-0 font-body text-[12px] text-inkSoft">
                Elevation
                <span className="inline-flex border border-rule">
                  {(['meters', 'feet'] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setElevationUnit(u)}
                      aria-pressed={elevationUnit === u}
                      className={`px-2 py-0.5 text-[12px] font-mono focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
                        elevationUnit === u ? 'bg-ink text-paper' : 'text-inkSoft hover:bg-panelHover'
                      }`}
                    >
                      {u === 'meters' ? 'm' : 'ft'}
                    </button>
                  ))}
                </span>
              </label>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className={sectionLabel}>Uploader</h2>
        <input
          value={uploaderUser}
          onChange={(e) => setUploaderUser(e.target.value)}
          placeholder="e.g. John Doe"
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
        <h2 className={sectionLabel}>Timezone</h2>
        <select
          value={uploadTimeZone}
          onChange={(e) => setUploadTimeZone(e.target.value)}
          className="w-full border border-rule bg-paper px-3 py-2 font-body text-[14px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        >
          {timeZones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
        <p className="font-body text-[12px] text-inkMute mt-1.5">
          EXIF times are wall-clock with no zone. Interpreting them in this zone fixes the stored
          capture instant (DST-aware). Defaults to this machine’s zone; change it to the camera’s
          zone when they differ.
        </p>
      </section>

      {needsCaptureTime && (
        <section>
          <h2 className={sectionLabel}>Capture time</h2>
          <CaptureTimeEditor files={files} />
        </section>
      )}

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
        <h2 className={sectionLabel}>Preview</h2>
        {location && collection && slug ? (
          <MetadataPreview
            location={location}
            collectionUuid={collection.uuid}
            bucket={collection.bucket}
            uploaderSlug={slug}
            description={description}
            timeZone={uploadTimeZone}
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
                  : !slug
                    ? 'Set an uploader identity first'
                    : 'Set a capture time for every file missing one'
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
