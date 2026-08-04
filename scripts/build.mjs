import { build } from 'esbuild';

await build({
  entryPoints: ['_worker.js'],
  outfile: 'dist/worker.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  legalComments: 'none',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});
