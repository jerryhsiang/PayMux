import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/server.ts'],
    format: ['esm'],
    dts: true,
    splitting: true,
    sourcemap: false,
    clean: true,
    outDir: 'dist',
    target: 'es2020',
    external: ['express', 'hono'],
  },
  {
    entry: ['src/index.ts', 'src/server.ts'],
    format: ['cjs'],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    outDir: 'dist',
    target: 'es2020',
    external: ['express', 'hono'],
  },
]);
