// Builds DiscordOldLayout.theme.css from src/ for the Discord build listed in classes.txt.
// Rules are written with [class*="name_"] fragments; the build turns them into the exact class
// names of the current build, which keeps the theme fast. Run fetch-classes.js first after a
// Discord update, then this.
// usage: node build.js
const fs = require('fs');
const path = require('path');
const srcDir = path.join(__dirname, 'src');
const classesFile = path.join(__dirname, 'classes.txt');
const outFile = path.join(__dirname, 'DiscordOldLayout.theme.css');
const headerFile = path.join(__dirname, 'src', 'header.txt');
const EXPAND_MAX = +(process.env.EXPAND_MAX || 64);
const ANCESTOR_MAX = 60;
const classes = fs.readFileSync(classesFile, 'utf8').split('\n').filter(Boolean);
const memo = new Map();
const stats = { expanded: 0, isList: 0, kept: 0, rules: 0, selectorsOut: 0 };
const ATTR = /\[class\s*([*^])=\s*(["'])(.*?)\2\s*\]/g;

function hits(op, value) {
  const start = op === '^' || value.startsWith(' ');
  const frag = value.trim();
  const key = (start ? '^' : '*') + frag;
  if (!memo.has(key)) memo.set(key, frag ? classes.filter(c => (start ? c.startsWith(frag) : c.includes(frag))) : []);
  return memo.get(key);
}

function isList(list) {
  return list.length === 1 ? '.' + list[0] : ':is(' + list.map(c => '.' + c).join(', ') + ')';
}

// split at top level (outside (), [], strings) on a predicate
function splitTop(s, isSep) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === '\\') { cur += s[++i] || ''; } else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && isSep(c, i, s)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// convert attribute selectors inside functional pseudo-class arguments (any depth) to :is lists
function convertAnc(s) {
  return s.replace(ATTR, (whole, op, q, value) => {
    const h = hits(op, value);
    if (!h.length || h.length > +(process.env.ANC_MAX || 8)) return whole;
    stats.isList++;
    return isList(h);
  });
}

function convertInner(s) {
  return s.replace(ATTR, (whole, op, q, value) => {
    const h = hits(op, value);
    if (!h.length || h.length > ANCESTOR_MAX) { stats.kept++; return whole; }
    stats.isList++;
    return isList(h);
  });
}

// split a complex selector into [compound, combinator, compound, ...]
function tokens(sel) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  const s = sel.trim();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === '\\') cur += s[++i] || ''; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && (c === '>' || c === '+' || c === '~' || /\s/.test(c))) {
      let j = i, comb = ' ';
      while (j < s.length && /[\s>+~]/.test(s[j])) { if (s[j] !== ' ' && !/\s/.test(s[j])) comb = s[j]; j++; }
      if (cur) parts.push(cur);
      parts.push(comb);
      cur = '';
      i = j - 1;
      continue;
    }
    cur += c;
  }
  if (cur) parts.push(cur);
  return parts;
}

// within one compound, separate top-level attribute selectors from the rest
function compoundAttrs(compound) {
  const found = [];
  let depth = 0, quote = null, rest = '';
  for (let i = 0; i < compound.length; i++) {
    const c = compound[i];
    if (quote) { rest += c; if (c === '\\') rest += compound[++i] || ''; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; rest += c; continue; }
    if (depth === 0 && c === '[') {
      const end = compound.indexOf(']', i);
      const attr = compound.slice(i, end + 1);
      ATTR.lastIndex = 0;
      const m = /^\[class\s*([*^])=\s*(["'])(.*?)\2\s*\]$/.exec(attr);
      if (m) { found.push({ op: m[1], value: m[3], attr }); rest += '\u0000' + (found.length - 1) + '\u0000'; i = end; continue; }
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    rest += c;
  }
  return { rest, found };
}

function compileSelector(sel) {
  const t = tokens(sel);
  const lastIdx = t.length - 1;
  const fixed = t.map((part, idx) => {
    if (idx % 2 === 1) return part === ' ' ? ' ' : ' ' + part + ' ';
    const inner = part.replace(/(:(?:has|is|not|where)\()/g, '$1');
    if (idx !== lastIdx) {
      return convertAnc(inner).replace(/:has\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (m, a) => ':has(' + convertInner(a) + ')');
    }
    return inner;
  });
  // rightmost compound: expand class attributes into separate selectors
  const right = fixed[lastIdx];
  const { rest, found } = compoundAttrs(right);
  const prefix = fixed.slice(0, lastIdx).join('');
  const restConverted = convertInner(rest.replace(/\u0000\d+\u0000/g, m => m));
  if (!found.length) return [prefix + convertInner(right)];
  const lists = found.map(f => hits(f.op, f.value));
  let combos = [restConverted];
  let product = 1;
  const order = found.map((f, k) => k).sort((a, b) => (lists[a].length || 1e9) - (lists[b].length || 1e9));
  order.forEach(k => {
    const f = found[k];
    const l = lists[k];
    const token = '\u0000' + k + '\u0000';
    if (l.length && product * l.length <= EXPAND_MAX) {
      stats.expanded++;
      product *= l.length;
      const next = [];
      for (const c of combos) for (const cls of l) next.push(c.replace(token, '.' + cls));
      combos = next;
    } else {
      stats.kept++;
      combos = combos.map(c => c.replace(token, f.attr));
    }
  });
  return combos.map(c => prefix + c);
}

function compileRuleList(css) {
  let out = '', i = 0, depth = 0, prelude = '';
  const stack = [];
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') { i = css.indexOf('*/', i + 2) + 2; continue; }
    if (c === '"' || c === "'") { const q = c; let j = i + 1; while (j < css.length && css[j] !== q) { if (css[j] === '\\') j++; j++; } prelude += css.slice(i, j + 1); i = j + 1; continue; }
    if (c === '{') {
      const p = prelude.trim();
      const mode = stack.length && stack[stack.length - 1] !== 'group' ? 'inner' : (p.startsWith('@media') || p.startsWith('@supports') || p.startsWith('@container') || p.startsWith('@layer') ? 'group' : p.startsWith('@') ? 'skip' : 'rule');
      if (mode === 'rule') {
        stats.rules++;
        const sels = splitTop(p, ch => ch === ',').map(s => s.trim()).filter(Boolean).flatMap(compileSelector);
        stats.selectorsOut += sels.length;
        out += sels.join(',\n') + ' {';
      } else {
        out += prelude + '{';
      }
      stack.push(mode);
      prelude = '';
      i++;
      continue;
    }
    if (c === '}') { out += prelude + '}'; prelude = ''; stack.pop(); i++; continue; }
    if (c === ';' && stack.length && stack[stack.length - 1] !== 'group') { out += prelude + ';'; prelude = ''; i++; continue; }
    prelude += c;
    i++;
  }
  return out + prelude;
}

const parts = fs.readdirSync(srcDir).filter(n => /^\d\d-.*\.css$/.test(n)).sort();
const body = parts.map(n => compileRuleList(fs.readFileSync(path.join(srcDir, n), 'utf8').trim()).replace(/\n{3,}/g, '\n\n').trim()).join('\n\n');
const header = headerFile ? fs.readFileSync(headerFile, 'utf8') : '';
fs.writeFileSync(outFile, header + body + '\n');
console.log(JSON.stringify(stats), 'out', Math.round(fs.statSync(outFile).size / 1024) + 'KB');
