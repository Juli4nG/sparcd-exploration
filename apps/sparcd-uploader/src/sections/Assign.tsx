import { useStore } from '../store';
import { useLocations } from '../lib/useLocations';
import { DeploymentPicker } from '../components/DeploymentPicker';
import { sanitizeUploaderUser } from '../lib/normalize';

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

  const { data, isLoading, isError, error } = useLocations(s3Config);
  const slug = sanitizeUploaderUser(uploaderUser);
  const canContinue = !!selectedLocationKey && !!slug;

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
        <h2 className={sectionLabel}>Target collection &amp; preview</h2>
        <div className="border border-ruleSoft bg-panel px-4 py-4">
          <p className="font-body text-[13px] text-inkSoft">
            Choosing the target collection bucket and previewing the five metadata files
            (<span className="font-mono">UploadMeta.json</span>,{' '}
            <span className="font-mono">UploadComplete.json</span>, and the three CSVs) lands in P3,
            where the in-memory Camtrap-DP bundle is generated.
          </p>
        </div>
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
