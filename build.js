// Builds the offline (bots-only) version of fragout.io: the game core runs inside the page, you queue,
// play the practice range, and bots fill the lobby after 30 s. Two targets:
//
//   node build.js pages  ->  site/index.html + site/three.min.js
//       A normal web page for GitHub Pages (school link). three.js is copied next to it, so it works on
//       networks that block CDNs.
//   node build.js test   ->  dist/fragout-test.html
//       A single-file page for the claude.ai test artifact (artifacts can only load scripts from CDNs).
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || 'pages';
let commit = 'dev';
try { commit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
const BUILD = `${commit} · ${new Date().toISOString().slice(0, 10)}`;
const pub = f => fs.readFileSync(path.join(__dirname, 'public', f), 'utf8');
const safe = js => js.replace(/<\/script/gi, '<\\/script');
const threeDir = path.join(__dirname, 'node_modules', 'three');
const THREE_VERSION = JSON.parse(fs.readFileSync(path.join(threeDir, 'package.json'), 'utf8')).version;

const index = pub('index.html');
const ui = index.slice(index.indexOf('<!--UI-START-->') + 15, index.indexOf('<!--UI-END-->'));
const FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Chakra+Petch:wght@400;600;700&display=swap">';
const scripts = threeTag => `${threeTag}
<script>window.FRAGOUT_LOCAL = true; window.FRAGOUT_BOT_FILL_MS = 30000; window.FRAGOUT_HIDE_BADGE = ${target === 'pages'}; window.FRAGOUT_BUILD = '${BUILD}';</script>
<script>
${safe(pub('core.js'))}
</script>
<script>
${safe(pub('characters.js'))}
</script>
<script>
${safe(pub('game3d.js'))}
</script>`;

if (target === 'pages') {
  const out = path.join(__dirname, 'site');
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(path.join(threeDir, 'build', 'three.min.js'), path.join(out, 'three.min.js'));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>fragout.io</title>
${FONTS}
<style>
${pub('style.css')}
</style>
</head>
<body>
${ui}
${scripts('<script src="three.min.js"></script>')}
</body>
</html>
`;
  fs.writeFileSync(path.join(out, 'index.html'), html);
  fs.writeFileSync(path.join(out, '.nojekyll'), '');   // serve files as-is on GitHub Pages
  console.log(`wrote site/index.html ${(html.length / 1024).toFixed(1)} KB + site/three.min.js (three ${THREE_VERSION}, no CDN needed)`);
} else if (target === 'test') {
  const html = `<meta charset="utf-8">
<title>fragout.io</title>
<meta name="claude:viewport-fit-sides" content="cover">
${FONTS}
<style>
${pub('style.css')}
</style>
${ui}
${scripts(`<script src="https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.min.js"></script>`)}
`;
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'dist', 'fragout-test.html'), html);
  console.log(`wrote dist/fragout-test.html ${(html.length / 1024).toFixed(1)} KB (three ${THREE_VERSION} from CDN)`);
} else {
  console.error('usage: node build.js pages|test');
  process.exit(1);
}
