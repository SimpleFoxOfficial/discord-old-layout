// Downloads the stylesheets of the current Discord web build and writes every class name to classes.txt.
// usage: node fetch-classes.js
const fs = require('fs');
const path = require('path');

const BASE = 'https://discord.com';
const UA = { 'User-Agent': 'Mozilla/5.0' };

async function text(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(res.status + ' ' + url);
  return res.text();
}

async function main() {
  const html = await text(BASE + '/app');
  const runtime = html.match(/\/assets\/web\.[0-9a-f]+\.js/);
  if (!runtime) throw new Error('web runtime not found in /app');
  const js = await text(BASE + runtime[0]);
  const start = js.indexOf('p.k=e=>{');
  const fn = js.slice(start, js.indexOf('+".css"}', start) + 8);
  const files = new Set(html.match(/\/assets\/[A-Za-z0-9._-]+\.css/g) || []);
  for (const m of fn.matchAll(/if\((\d+)===e\)return""\+e\+"\.([0-9a-f]{16})\.css"/g)) files.add(`/assets/${m[1]}.${m[2]}.css`);
  for (const m of fn.slice(fn.lastIndexOf('({')).matchAll(/\d+:"([0-9a-f]{16})"/g)) files.add(`/assets/${m[1]}.css`);

  const classes = new Set();
  const list = [...files];
  let done = 0;
  async function worker() {
    while (list.length) {
      const f = list.pop();
      try {
        const css = await text(BASE + f);
        for (const m of css.matchAll(/\.([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]{6})(?![A-Za-z0-9_-])/g)) classes.add(m[1]);
      } catch (e) {}
      done++;
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));
  const build = (html.match(/"BUILD_NUMBER":"(\d+)"/) || [])[1] || 'unknown';
  fs.writeFileSync(path.join(__dirname, 'classes.txt'), [...classes].sort().join('\n') + '\n');
  console.log(`build ${build}: ${done} stylesheets, ${classes.size} classes written to classes.txt`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
