// Builds dist/ for publishing as a hosted page.
//
// 1. The host supplies the <!doctype>/<html>/<head>/<body> skeleton, so
//    dist/index.html keeps only the regions marked <!-- build:keep -->.
// 2. Every CSS/JS file gets a content hash in its name (main.3f9a1c.js) and all
//    references are rewritten to match. Browsers cache these files, so without
//    this a returning visitor can get a new page with an old script (or the
//    reverse) and the app breaks. With hashed names, each version only ever
//    loads its own files.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 10);

await rm(dist, { recursive: true, force: true });
await mkdir(new URL('js/', dist), { recursive: true });
await mkdir(new URL('css/', dist), { recursive: true });

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
  await writeFile(new URL(`js/${names[file]}`, dist), code);
}

const css = await readFile(new URL('css/styles.css', root), 'utf8');
const cssName = `styles.${hash(css)}.css`;
await writeFile(new URL(`css/${cssName}`, dist), css);

const html = await readFile(new URL('index.html', root), 'utf8');
let page = [...html.matchAll(/<!-- build:keep -->([\s\S]*?)<!-- \/build:keep -->/g)].map((m) => m[1].trim()).join('\n\n');
page = page.replace('href="css/styles.css"', `href="css/${cssName}"`).replace('src="js/main.js"', `src="js/${names['main.js']}"`);
if (page.includes('"css/styles.css"') || page.includes('"js/main.js"')) throw new Error('unhashed reference left in index.html');
await writeFile(new URL('index.html', dist), page + '\n');

// File map for the publish call: { "published/path": "source/path" }
const files = { [`css/${cssName}`]: `dist/css/${cssName}` };
for (const n of Object.values(names)) files[`js/${n}`] = `dist/js/${n}`;
await writeFile(new URL('files.json', dist), JSON.stringify(files, null, 2) + '\n');
console.log('Wrote dist/ with', Object.keys(files).length, 'hashed files');
console.log(JSON.stringify(files, null, 2));
