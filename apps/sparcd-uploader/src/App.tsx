import { useEffect } from 'react';
import { Connection } from '@sparcd/auth-ui';
import { useStore } from './store';
import { Chrome } from './components/Chrome';
import { NewUpload } from './sections/NewUpload';
import { History } from './sections/History';
import { Settings } from './sections/Settings';

// Dev-only, non-secret prefill (endpoint only). Secrets are never prefilled.
const devEndpoint = import.meta.env.VITE_SPARCD_S3_ENDPOINT as string | undefined;

export function App() {
  const s3Config = useStore((s) => s.s3Config);
  const section = useStore((s) => s.section);
  const connect = useStore((s) => s.connect);
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  if (!s3Config) {
    return (
      <Connection
        toolName="Uploader"
        initialConfig={devEndpoint ? { endpoint: devEndpoint } : undefined}
        onConnect={connect}
      />
    );
  }

  return (
    <Chrome uploadState="ready">
      {section === 'new' && <NewUpload />}
      {section === 'history' && <History />}
      {section === 'settings' && <Settings />}
    </Chrome>
  );
}
