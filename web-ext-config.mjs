// Keeps build tooling and dependencies out of lint runs and packages.
export default {
  ignoreFiles: [
    'node_modules',
    'build',
    'package.json',
    'package-lock.json',
    'web-ext-config.mjs',
    'piper/worker.src.js',
    'web-ext-artifacts',
    '.mcp.json',
    '.gitattributes',
    'web-ext-artifacts/**'
  ]
};
