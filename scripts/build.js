// Builds the app for publishing.
//
//   node scripts/build.js            -> dist/   (Claude-hosted page)
//   node scripts/build.js --site     -> _site/  (GitHub Pages or any static host)
//
// Every CSS/JS file gets a content hash in its name (main.3f9a1c.js) and all
// references are rewritten to match. Browsers cache these files, so without
// this a returning visitor can get a new page with an old script (or the
// reverse) and the app breaks. With hashed names, each version only ever loads
// its own files.
//
// The Claude-hosted page supplies its own <!doctype>/<html>/<head>/<body>
// skeleton, so for that target index.html keeps only the regions marked
// <!-- build:keep -->. The site target keeps the full document.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const site = process.argv.includes('--site');
const root = new URL('../', import.meta.url);
const out = new URL(site ? '../_site/' : '../dist/', import.meta.url);
const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 10);

await rm(out, { recursive: true, force: true });
await mkdir(new URL('js/', out), { recursive: true });
await mkdir(new URL('css/', out), { recursive: true });

// Modules in dependency order (leaves first), so each file's imports are
// rewritten to already-hashed names before the file itself is hashed.
const modules = ['timer.js', 'store.js', 'sounds.js', 'format.js', 'main.js'];
const names = {}; // 'timer.js' -> 'timer.ab12cd34ef.js'

for (const file of modules) {
  let code = await readFile(new URL(`js/${file}`, root), 'utf8');
  code = code.replace(/from '\.\/([\w-]+\.js)'/g, (m, dep) => {
    if (!names[dep]) throw new Error(`${file} imports ${dep} before it was built`);
    return `from './${names[dep]}'`;
  });
  names[file] = file.replace(/\.js$/, `.${hash(code)}.js`);
  await writeFile(new URL(`js/${names[file]}`, out), code);
}

const css = await readFile(new URL('css/styles.css', root), 'utf8');
const cssName = `styles.${hash(css)}.css`;
await writeFile(new URL(`css/${cssName}`, out), css);

const html = await readFile(new URL('index.html', root), 'utf8');
let page = site
  ? html
  : [...html.matchAll(/<!-- build:keep -->([\s\S]*?)<!-- \/build:keep -->/g)].map((m) => m[1].trim()).join('\n\n') + '\n';
page = page.replace('href="css/styles.css"', `href="css/${cssName}"`).replace('src="js/main.js"', `src="js/${names['main.js']}"`);
if (page.includes('"css/styles.css"') || page.includes('"js/main.js"')) throw new Error('unhashed reference left in index.html');
await writeFile(new URL('index.html', out), page);

const files = { [`css/${cssName}`]: `css/${cssName}` };
for (const n of Object.values(names)) files[`js/${n}`] = `js/${n}`;
if (!site) await writeFile(new URL('files.json', out), JSON.stringify(files, null, 2) + '\n'); // file map for publishing the hosted page
console.log(`Wrote ${site ? '_site' : 'dist'}/ with ${Object.keys(files).length} hashed files`);
