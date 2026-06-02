import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Workspace packages are consumed as TypeScript source (no dist/). Aliasing
// them to their src entry lets Vite transpile them as app source.
const pkg = (name: string, entry: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/${entry}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sparcd/types': pkg('types', 'index.ts'),
      '@sparcd/s3-safe': pkg('s3-safe', 'index.ts'),
      '@sparcd/auth-ui': pkg('auth-ui', 'index.ts'),
      '@sparcd/camtrap': pkg('camtrap', 'index.ts'),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
