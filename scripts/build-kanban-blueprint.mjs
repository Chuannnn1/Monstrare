import { build } from 'esbuild';

await build({
  entryPoints: ['tools/kanban/blueprint-canvas.jsx'],
  bundle: true,
  minify: true,
  sourcemap: true,
  target: ['chrome100', 'firefox100', 'safari15'],
  format: 'esm',
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.IS_PREACT': '"false"',
  },
  outdir: 'tools/kanban/public',
  entryNames: 'blueprint-canvas',
  assetNames: 'assets/[name]-[hash]',
  loader: {
    '.woff2': 'file',
    '.woff': 'file',
  },
});
