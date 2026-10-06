// Bundles every Forge entry point in memory so JSX/import errors fail `npm run check`,
// not just `forge deploy` on main.
import { build } from 'esbuild';

const common = { bundle: true, write: false, logLevel: 'error' };
await build({ ...common, entryPoints: ['src/frontend/admin.jsx', 'src/frontend/schedule.jsx', 'src/frontend/routingSettings.jsx'], outdir: 'out-ui', jsx: 'automatic' });
await build({ ...common, entryPoints: ['src/index.js', 'src/background.js', 'src/schedule.js', 'src/routingSettings.js'], outdir: 'out-backend', platform: 'node', format: 'esm' });
console.log('All Forge entry points bundle cleanly.');
