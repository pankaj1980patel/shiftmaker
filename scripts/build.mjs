#!/usr/bin/env node
// Builds store packages from the same source:
//   dist/shiftmate-chrome-v<version>.zip   (manifest as-is)
//   dist/shiftmate-firefox-v<version>.zip  (manifest adapted for Firefox)
// Usage: node scripts/build.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const { version } = manifest;
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

function pack(name, mf, { exclude = [], transform = {} } = {}) {
  const dir = join(dist, name);
  mkdirSync(dir);
  cpSync(join(root, 'src'), join(dir, 'src'), {
    recursive: true,
    filter: (p) => !p.endsWith('.DS_Store') && !exclude.some((x) => p.endsWith(x))
  });
  for (const [file, fn] of Object.entries(transform)) {
    const path = join(dir, file);
    writeFileSync(path, fn(readFileSync(path, 'utf8')));
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(mf, null, 4) + '\n');
  const zip = join(dist, `shiftmate-${name}-v${version}.zip`);
  execFileSync('zip', ['-qr', '-X', zip, 'manifest.json', 'src'], { cwd: dir });
  console.log('built', zip);
}

pack('chrome', manifest);

// Firefox: event page instead of a service worker (it has a DOM, so
// geolocation works there directly and no offscreen document is needed),
// a gecko ID, and the data-collection disclosure AMO requires.
const firefox = structuredClone(manifest);
firefox.permissions = firefox.permissions.filter((p) => p !== 'offscreen');
firefox.background = { scripts: [manifest.background.service_worker], type: 'module' };
firefox.browser_specific_settings = {
  gecko: {
    id: 'shiftmate@pankaj1980patel.github.io',
    // data_collection_permissions needs Firefox 140 (Android 142).
    strict_min_version: '140.0',
    data_collection_permissions: {
      // Sent only to Keka (the service you sign in to), never to the developer.
      required: ['authenticationInfo', 'locationInfo']
    }
  },
  gecko_android: { strict_min_version: '142.0' }
};
firefox.icons = { ...firefox.icons, 16: 'src/icons/smily-pumpkin-16.png' };
// The event page has a DOM and geolocation, so drop the Chrome offscreen code.
const stripChromeOnly = (code) => {
  const out = code.replace(/\/\/ #chrome-only-start[\s\S]*?\/\/ #chrome-only-end\n/g, 'const offscreenLocation = async () => null;\n');
  if (out === code) throw new Error('chrome-only markers not found');
  return out;
};
pack('firefox', firefox, {
  exclude: ['src/offscreen.html', 'src/offscreen.js'],
  transform: { 'src/utils/location.js': stripChromeOnly }
});
