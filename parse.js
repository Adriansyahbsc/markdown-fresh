// parse.js — a dependency-free Markdown renderer.
//
// parse(markdown) returns the HTML that marked 18.1.3 renders with its
// default options (GFM on, breaks off). The implementation is written from
// scratch after the CommonMark 0.31.2 and GFM 0.29 specifications, tuned
// where marked's own output departs from them: it is a line-oriented block
// parser (containers are extracted and parsed recursively) feeding a
// scanner-based inline parser with a delimiter stack for emphasis.
//
// No state is kept between calls: every parse builds its own link
// reference table, so a case renders exactly as it would on its own.

// ---------------------------------------------------------------- helpers

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape every HTML-special character (used for code and raw values). */
function escapeAll(s) {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const NAMED_ENTITY = /^&(?:[A-Za-z][A-Za-z0-9]*);/;
const NUMERIC_ENTITY = /^&#(?:([0-9]{1,7})|[xX]([0-9A-Fa-f]{1,6}));/;

/**
 * Escape text the way marked escapes running text: `<`, `>`, `"` and `'`
 * always, and `&` unless it begins an entity-shaped reference. Numeric
 * character references never reach this function (the inline scanner
 * decodes them first); named references pass through untouched.
 */
function escapeText(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const m = NAMED_ENTITY.exec(s.slice(i, i + 40));
      if (m) {
        out += m[0];
        i += m[0].length;
      } else {
        out += '&amp;';
        i++;
      }
    } else if (c === '<' || c === '>' || c === '"' || c === "'") {
      out += HTML_ESCAPES[c];
      i++;
    } else {
      // copy the plain run in one go
      let j = i + 1;
      while (j < n) {
        const d = s[j];
        if (d === '&' || d === '<' || d === '>' || d === '"' || d === "'") break;
        j++;
      }
      out += s.slice(i, j);
      i = j;
    }
  }
  return out;
}

/** Percent-encode a link destination the way marked's cleanUrl does. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** The final href attribute value: cleaned, then entity-aware escaping. */
function hrefAttr(rawHref) {
  const cleaned = cleanUrl(rawHref);
  if (cleaned === null) return null;
  return escapeText(cleaned);
}

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

/** Resolve backslash escapes of ASCII punctuation in a captured string. */
function unescapePunct(s) {
  return s.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

// ------------------------------------------------------- whitespace / tabs

/** Columns of leading whitespace in `line` (a tab advances to a multiple of 4). */
function leadingCols(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') {
      col++;
      i++;
    } else if (c === '\t') {
      col += 4 - (col % 4);
      i++;
    } else {
      break;
    }
  }
  return { cols: col, pos: i };
}

/**
 * Remove up to `n` columns of leading whitespace from `line`, where the
 * line is taken to start at column `startCol`. A tab that is only partly
 * consumed leaves its remainder as spaces, and every later tab on the
 * line is expanded to spaces too: once alignment has shifted, the
 * remaining tabs stand for their original absolute columns.
 */
// Expand tabs in the leading whitespace run of str to spaces, using
// absolute columns starting at startCol. marked applies this expansion
// when a container (list item, blockquote) strips a line: the tab keeps
// the width it had in the original line.
function expandLeadingTabs(str, startCol) {
  let col = startCol;
  let out = '';
  let i = 0;
  while (i < str.length && (str[i] === ' ' || str[i] === '\t')) {
    if (str[i] === ' ') {
      out += ' ';
      col++;
      i++;
    } else {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    }
  }
  return i === 0 ? str : out + str.slice(i);
}

// Remove up to n leading whitespace characters (spaces or tabs, each
// counting as one character) — marked's backtick-fence dedent.
function dedentChars(line, n) {
  let k = 0;
  while (k < line.length && k < n && (line[k] === ' ' || line[k] === '\t')) k++;
  return line.slice(k);
}

function stripCols(line, n, startCol = 0) {
  const n0 = n;
  let col = startCol;
  let i = 0;
  let out = '';
  let shifted = false;
  let consuming = n > 0;
  while (i < line.length) {
    const c = line[i];
    if (consuming) {
      if (c === ' ') {
        col++;
        i++;
        if (--n === 0) consuming = false;
        continue;
      }
      if (c === '\t') {
        const w = 4 - (col % 4);
        if (w <= n) {
          col += w;
          i++;
          n -= w;
          if (n === 0) consuming = false;
          continue;
        }
        out += ' '.repeat(w - n);
        col += w;
        i++;
        n = 0;
        consuming = false;
        shifted = true;
        continue;
      }
      consuming = false; // less indentation than asked: copy the rest
    }
    if (c === '\t' && shifted) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
      continue;
    }
    out += c;
    col++;
    i++;
  }
  return out;
}

/** True when the line holds nothing but spaces and tabs. */
function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

// ------------------------------------------------------------- block level

const BLOCK_TAGS = new Set(
  (
    'address article aside base basefont blockquote body caption center col ' +
    'colgroup dd details dialog dir div dl dt fieldset figcaption figure ' +
    'footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html legend ' +
    'li link main menu menuitem nav noframes ol optgroup option p param ' +
    'section source summary table tbody td tfoot th thead title tr track ul'
  ).split(' '),
);

/**
 * Classify an HTML block starting at `line`, following the CommonMark
 * rules. Returns 0 (no block), 1..6 for the block kinds that may interrupt
 * a paragraph, or 7 for the kind that may not.
 */
function htmlBlockKind(line) {
  const m = /^ {0,3}</.exec(line);
  if (!m) return 0;
  const rest = line.slice(m[0].length);
  if (/^(?:script|pre|style|textarea)(?:[ \t\n]|>|$)/i.test(rest)) return 1;
  if (rest.startsWith('!--')) return 2;
  if (rest.startsWith('?')) return 3;
  if (/^![A-Z]/.test(rest)) return 4;
  if (rest.startsWith('![CDATA[')) return 5;
  const tag = /^\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (tag && BLOCK_TAGS.has(tag[1].toLowerCase())) {
    const after = rest.slice(tag[0].length);
    if (/^(?:[ \t\n]|>|\/>|$)/.test(after)) return 6;
  }
  // kind 7: any other complete open or closing tag, alone on the line
  // (marked requires the whole line to be the single tag)
  const tagEnd = parseTag(line, m[0].length - 1);
  if (tagEnd !== null && /^[ \t]*$/.test(line.slice(tagEnd))) {
    return 7;
  }
  return 0;
}

/**
 * Try to read a complete HTML tag starting at src[pos] === '<' inside an
 * inline context or for block kind 7. Returns the index just past '>' or
 * null. Attribute grammar follows CommonMark.
 */
function parseTag(src, pos) {
  let i = pos + 1;
  let closing = false;
  if (src[i] === '/') {
    closing = true;
    i++;
  }
  const name = /^[A-Za-z][A-Za-z0-9-]*/.exec(src.slice(i, i + 64));
  if (!name) return null;
  i += name[0].length;
  if (closing) {
    // A closing tag allows only whitespace before the '>'.
    let j = i;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
    return src[j] === '>' ? j + 1 : null;
  }
  for (;;) {
    let j = i;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
    if (j >= src.length) return null;
    if (src[j] === '>') return j + 1;
    if (src[j] === '/' && src[j + 1] === '>') return j + 2;
    if (j === i) return null; // attributes need preceding whitespace
    const attr = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(src.slice(j, j + 128));
    if (!attr) return null;
    j += attr[0].length;
    // optional value
    let k = j;
    while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
    if (src[k] === '=') {
      k++;
      while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
      const q = src[k];
      if (q === '"' || q === "'") {
        const end = src.indexOf(q, k + 1);
        if (end === -1) return null;
        k = end + 1;
      } else {
        const val = /^[^\s"'=<>`]+/.exec(src.slice(k, k + 256));
        if (!val) return null;
        k += val[0].length;
      }
      i = k;
    } else {
      i = j;
    }
  }
}

// ---------------------------------------------------------- block matchers

function matchFence(line) {
  const { cols, pos } = leadingCols(line);
  if (cols > 3) return null;
  const rest = line.slice(pos);
  const m = /^(`{3,}|~{3,})/.exec(rest);
  if (!m) return null;
  const info = rest.slice(m[0].length);
  if (m[1][0] === '`' && info.includes('`')) return null;
  return { ch: m[1][0], len: m[1].length, info, indent: cols };
}

function matchClosingFence(line, ch, len) {
  const { cols, pos } = leadingCols(line);
  if (cols > 3) return false;
  const rest = line.slice(pos);
  const run = ch === '`' ? /^`+/ : /^~+/;
  const m = run.exec(rest);
  if (!m || m[0].length < len) return false;
  return /^[ \t]*$/.test(rest.slice(m[0].length));
}

function matchAtx(line) {
  const { cols, pos } = leadingCols(line);
  if (cols > 3) return null;
  const rest = line.slice(pos);
  const m = /^(#{1,6})(?=$|[ \t])/.exec(rest);
  if (!m) return null;
  let text = rest.slice(m[1].length).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]#+$/, '').replace(/[ \t]+$/, '');
  return { depth: m[1].length, text };
}

function isHr(line) {
  const { cols, pos } = leadingCols(line);
  if (cols > 3) return false;
  return /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line.slice(pos));
}

function matchSetext(line) {
  const { cols, pos } = leadingCols(line);
  if (cols > 3) return 0;
  const rest = line.slice(pos);
  if (/^=+[ \t]*$/.test(rest)) return 1;
  if (/^-+[ \t]*$/.test(rest)) return 2;
  return 0;
}

/** A list marker at the start of `line` (indent at most 3), or null. */
function matchMarker(line) {
  const { cols, pos } = leadingCols(line);
  if (cols > 3) return null;
  const rest = line.slice(pos);
  let m = /^([-*+])(?=$|[ \t])/.exec(rest);
  if (m) {
    return { ordered: false, ch: m[1], num: 0, endCol: cols + 1, baseIndent: cols };
  }
  m = /^([0-9]{1,9})([.)])(?=$|[ \t])/.exec(rest);
  if (m) {
    return {
      ordered: true,
      ch: m[2],
      num: parseInt(m[1], 10),
      endCol: cols + m[1].length + 1,
      baseIndent: cols,
    };
  }
  return null;
}

/** Columns of whitespace at the start of `s`, counting from column `from`. */
function wsCols(s, from) {
  let col = from;
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') {
      col++;
      i++;
    } else if (s[i] === '\t') {
      col += 4 - (col % 4);
      i++;
    } else {
      break;
    }
  }
  return { cols: col - from, pos: i };
}

/** Content indent and first content line for an item opened by `mk` on `line`. */
function itemStart(line, mk) {
  const after = line.slice(leadingCols(line).pos + (mk.endCol - mk.baseIndent));
  const { cols: sp, pos } = wsCols(after, mk.endCol);
  const blank = pos >= after.length;
  let contentIndent;
  if (blank || sp >= 5) contentIndent = mk.endCol + 1;
  else contentIndent = mk.endCol + sp;
  const first = blank
    ? ''
    : stripCols(expandLeadingTabs(after, mk.endCol), contentIndent - mk.endCol, mk.endCol);
  return { contentIndent, first, blank };
}

function sameListMarker(a, b) {
  return a.ordered === b.ordered && a.ch === b.ch;
}

/** Would this marker, on this line, interrupt a paragraph? */
function markerInterrupts(mk, line, anyNum = false) {
  const { blank } = itemStart(line, mk);
  if (blank) return false;
  if (mk.ordered && mk.num !== 1 && !anyNum) return false;
  return true;
}

// ------------------------------------------------------ link reference defs

const CASE_FOLD_EXTRA = {
  ß: 'ss',
  ẞ: 'ss',
  ς: 'σ',
  ﬀ: 'ff',
  ﬁ: 'fi',
  ﬂ: 'fl',
  ﬃ: 'ffi',
  ﬄ: 'ffl',
  ﬅ: 'st',
  ﬆ: 'st',
};

function normalizeLabel(s) {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[ßẞςﬀ-ﬆ]/g, (c) => CASE_FOLD_EXTRA[c] ?? c)
    .toLowerCase();
}

/**
 * Try to read a link reference definition starting at lines[i]. Returns
 * { label, href, title, next } or null when the text is not a definition
 * (in which case it is ordinary paragraph text).
 */
function tryDef(lines, i) {
  const { cols, pos } = leadingCols(lines[i]);
  if (cols > 3 || lines[i][pos] !== '[') return null;
  // Work on a joined window so labels and titles may span lines.
  const window = lines.slice(i, i + 12).join('\n');
  let p = pos;
  // label
  let label = '';
  let closed = false;
  p++; // consume '['
  while (p < window.length) {
    const c = window[p];
    if (c === '\\' && p + 1 < window.length && ASCII_PUNCT.has(window[p + 1])) {
      label += window.slice(p, p + 2);
      p += 2;
      continue;
    }
    if (c === '[') return null;
    if (c === ']') {
      closed = true;
      p++;
      break;
    }
    label += c;
    p++;
  }
  if (!closed || label.trim() === '') return null;
  if (window[p] !== ':') return null;
  p++;
  // optional whitespace, at most one line ending
  const skipWs = (allowNewline) => {
    let sawNl = false;
    while (p < window.length) {
      const c = window[p];
      if (c === ' ' || c === '\t') {
        p++;
      } else if (c === '\n' && allowNewline && !sawNl) {
        sawNl = true;
        p++;
      } else {
        break;
      }
    }
    return sawNl;
  };
  skipWs(true);
  // destination
  let href;
  if (window[p] === '<') {
    const end = window.indexOf('>', p + 1);
    if (end === -1) return null;
    href = window.slice(p + 1, end);
    if (/[<]/.test(href) || href.includes('\n')) return null;
    p = end + 1;
  } else {
    const m = /^[^\s<>]+/.exec(window.slice(p));
    if (!m) return null;
    href = m[0];
    p += m[0].length;
  }
  // Optional title: separated from the destination by whitespace (which
  // may include one line ending), with only whitespace after it on its
  // line. A title that does not match completely is simply absent — but
  // then the destination must end its own line.
  let title = null;
  let endP = -1;
  {
    let tp = p;
    let sawWs = false;
    let sawNl = false;
    while (tp < window.length) {
      const c = window[tp];
      if (c === ' ' || c === '\t') {
        tp++;
        sawWs = true;
      } else if (c === '\n' && !sawNl) {
        tp++;
        sawWs = true;
        sawNl = true;
      } else {
        break;
      }
    }
    const q = window[tp];
    if (sawWs && (q === '"' || q === "'" || q === '(')) {
      const close = q === '(' ? ')' : q;
      let t = '';
      let ok = false;
      let q2 = tp + 1;
      while (q2 < window.length) {
        const c = window[q2];
        if (c === '\\' && q2 + 1 < window.length && ASCII_PUNCT.has(window[q2 + 1])) {
          t += window.slice(q2, q2 + 2);
          q2 += 2;
          continue;
        }
        if (c === close) {
          ok = true;
          q2++;
          break;
        }
        if (q === '(' && c === '(') break;
        t += c;
        q2++;
      }
      if (ok) {
        let q3 = q2;
        while (q3 < window.length && (window[q3] === ' ' || window[q3] === '\t')) q3++;
        if (q3 >= window.length || window[q3] === '\n') {
          title = t;
          endP = q3;
        }
      }
    }
  }
  if (endP < 0) {
    let q3 = p;
    while (q3 < window.length && (window[q3] === ' ' || window[q3] === '\t')) q3++;
    if (q3 < window.length && window[q3] !== '\n') return null;
    endP = q3;
  }
  p = endP;
  const consumed = window.slice(0, p).split('\n').length - 1;
  // a definition may not span a blank line
  for (let k = i + 1; k <= i + consumed; k++) {
    if (k < lines.length && isBlank(lines[k])) return null;
  }
  return {
    label: normalizeLabel(label),
    href: unescapePunct(href),
    title: title === null ? null : unescapePunct(title),
    next: i + consumed + 1,
  };
}

// ------------------------------------------------------------------ tables

/**
 * Split a table row into cell strings. Pipes that are backslash-escaped or
 * inside a code span do not split. Cells come back trimmed.
 */
function splitRow(line) {
  // marked splits cells on every unescaped pipe; code spans do not
  // protect pipes. An escaped pipe becomes a literal pipe in the cell.
  const cells = [];
  let cur = '';
  let i = 0;
  const s = line;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && (s[i + 1] === '|' || s[i + 1] === '\\' || s[i + 1] === '`')) {
      cur += s[i + 1] === '|' ? '|' : s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  // A leading or trailing pipe is a border, not an empty cell.
  const trimmed = line.trim();
  if (trimmed.startsWith('|') && cells.length > 1 && cells[0].trim() === '') cells.shift();
  if (
    cells.length > 1 &&
    cells[cells.length - 1].trim() === '' &&
    /(?<!\\)\|[ \t]*$/.test(trimmed)
  ) {
    cells.pop();
  }
  return cells.map((c) => c.trim());
}

/** If lines[i], lines[i+1] open a table, return { header, align }. */
function tableStart(lines, i) {
  if (i + 1 >= lines.length) return null;
  const delimLine = lines[i + 1];
  if (isBlank(lines[i]) || isBlank(delimLine)) return null;
  const header = splitRow(lines[i]);
  const delim = splitRow(delimLine);
  if (header.length !== delim.length || header.length === 0) return null;
  if (!delimLine.includes('|') && delim.length < 2) return null;
  const align = [];
  for (const cell of delim) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return { header, align };
}

// ------------------------------------------------------------- block driver

/** Remap a parent lazy-line set through a line-index mapping. */
function remapLazy(srcIdx, env) {
  if (!env.lazy) return null;
  const out = new Set();
  for (let k = 0; k < srcIdx.length; k++) {
    if (env.lazy.has(srcIdx[k])) out.add(k);
  }
  return out.size ? out : null;
}

function endsWithOpenParagraph(tokens) {
  if (!tokens.length) return false;
  const last = tokens[tokens.length - 1];
  if (last.type === 'paragraph') return true;
  if (last.type === 'blockquote') return endsWithOpenParagraph(last.children);
  if (last.type === 'list') {
    return (
      last.items.length > 0 &&
      endsWithOpenParagraph(last.items[last.items.length - 1].children)
    );
  }
  return false;
}

/** A line that may continue a paragraph (for lazy continuation checks). */
function isParaContinuation(line) {
  if (matchFence(line)) return false;
  if (matchAtx(line)) return false;
  if (isHr(line)) return false;
  const { cols, pos } = leadingCols(line);
  if (cols <= 3 && line[pos] === '>') return false;
  const mk = matchMarker(line);
  if (mk && markerInterrupts(mk, line)) return false;
  const hk = htmlBlockKind(line);
  if (hk >= 1 && hk <= 6) return false;
  return true;
}

function interruptsParagraph(lines, j, inItem = false) {
  const line = lines[j];
  if (matchFence(line)) return true;
  if (matchAtx(line)) return true;
  if (isHr(line)) return true;
  const { cols, pos } = leadingCols(line);
  if (cols <= 3 && line[pos] === '>') return true;
  const mk = matchMarker(line);
  if (mk && markerInterrupts(mk, line, inItem)) return true;
  const hk = htmlBlockKind(line);
  if (hk >= 1 && hk <= 6) return true;
  return false;
}

function collectParagraph(lines, i, env) {
  const textLines = [lines[i]];
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) {
      // marked quirk: a whitespace-only line at the very end of the block
      // sequence still belongs to the paragraph.
      if (line !== '' && j === lines.length - 1) {
        textLines.push(line);
        j++;
      }
      break;
    }
    const sx = matchSetext(line);
    if (sx && !(env.lazy && env.lazy.has(j))) {
      return {
        token: { type: 'heading', depth: sx, text: textLines.join('\n').trim() },
        next: j + 1,
      };
    }
    if (tableStart(lines, j)) break;
    // A lazy continuation line is always paragraph text.
    if (env.lazy && env.lazy.has(j)) {
      textLines.push(line);
      j++;
      continue;
    }
    if (interruptsParagraph(lines, j, env.inItem)) break;
    textLines.push(line);
    j++;
  }
  return { token: { type: 'paragraph', text: textLines.join('\n') }, next: j };
}

function consumeHtmlBlock(lines, i, kind, env) {
  let end = i;
  if (kind >= 6) {
    while (end + 1 < lines.length && !isBlank(lines[end + 1])) end++;
  } else {
    let test;
    if (kind === 1) {
      const name = /<\/?(script|pre|style|textarea)/i.exec(lines[i])[1].toLowerCase();
      test = (l) => l.toLowerCase().includes('</' + name);
    } else if (kind === 2) test = (l) => l.includes('-->');
    else if (kind === 3) test = (l) => l.includes('?>');
    else if (kind === 4) test = (l) => l.includes('>');
    else test = (l) => l.includes(']]>');
    while (end < lines.length && !test(lines[end])) end++;
    if (end >= lines.length) end = lines.length - 1;
  }
  const seg = lines.slice(i, end + 1);
  // marked's HTML block token is the raw block text. A trailing newline
  // is part of it only when the block runs to the end of the input (and
  // the input ends with one), or when a terminator-ended block (kinds
  // 1-5) is followed immediately by a non-blank line.
  let text = seg.join('\n');
  const atDocEnd = env.endIsDocEnd && end === lines.length - 1;
  if (atDocEnd) {
    if (env.srcNl) text += '\n';
  } else if (kind <= 5 && end + 1 < lines.length && lines[end + 1] !== '') {
    // Kinds 1-5: any following line except a zero-length one keeps the
    // newline (even a whitespace-only line).
    text += '\n';
  }
  return { text, next: end + 1 };
}

function parseBlockquote(lines, i, env) {
  const inner = [];
  const innerSrc = [];
  const lazyIdx = new Set();
  let lazyInPara = 0;
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    const { cols, pos } = leadingCols(line);
    if (cols <= 3 && line[pos] === '>') {
      let rest = line.slice(pos + 1);
      if (rest.startsWith(' ')) rest = expandLeadingTabs(rest.slice(1), cols + 2);
      else if (rest.startsWith('\t')) rest = stripCols(rest, 1, cols + 1);
      else rest = expandLeadingTabs(rest, cols + 1);
      inner.push(rest);
      innerSrc.push(j);
      lazyInPara = 0;
      j++;
      continue;
    }
    if (isBlank(line)) break;
    if (!isParaContinuation(line)) break;
    // Laziness cannot cross a blank line inside the quote.
    if (inner.length === 0 || isBlank(inner[inner.length - 1])) break;
    const probe = parseBlocks(inner, {
      defs: env.defs,
      lazy: remapLazy(innerSrc, env),
      srcNl: env.srcNl,
      endIsDocEnd: false,
      inItem: env.inItem,
    });
    if (!endsWithOpenParagraph(probe)) break;
    // marked quirk: a lazy line shaped like a setext underline that is
    // not the first lazy line of its paragraph is appended indented by
    // four spaces, which keeps it plain paragraph text. A lazy line
    // indented by four or more columns loses its indentation entirely.
    let pushed = line;
    if (leadingCols(line).cols >= 4) pushed = line.slice(leadingCols(line).pos);
    if (matchSetext(pushed) === 1 && lazyInPara >= 1) {
      pushed = '    ' + pushed.trim();
    }
    lazyIdx.add(inner.length);
    inner.push(pushed);
    innerSrc.push(j);
    lazyInPara++;
    j++;
  }
  const childLazy = new Set(lazyIdx);
  if (env.lazy) {
    for (let k = 0; k < innerSrc.length; k++) {
      if (env.lazy.has(innerSrc[k])) childLazy.add(k);
    }
  }
  const children = parseBlocks(inner, {
    defs: env.defs,
    lazy: childLazy.size ? childLazy : null,
    srcNl: env.srcNl,
    endIsDocEnd: env.endIsDocEnd && j >= lines.length,
    inItem: env.inItem,
  });
  return { token: { type: 'blockquote', children }, next: j };
}

/** Scan block lines; return the fence left open at the end, if any. */
function unclosedFence(blockLines) {
  let open = null;
  for (let idx = 0; idx < blockLines.length; idx++) {
    const l = blockLines[idx];
    if (open) {
      if (matchClosingFence(l, open.ch, open.len)) open = null;
    } else {
      const f = matchFence(l);
      if (f) open = { ...f, idx };
    }
  }
  return open;
}

function parseList(lines, i, env) {
  const first = matchMarker(lines[i]);
  const rawItems = [];
  let loose = false;
  let j = i;
  let listDone = false;
  while (j < lines.length && !listDone) {
    if (isHr(lines[j])) break;
    const mk = matchMarker(lines[j]);
    if (!mk || !sameListMarker(mk, first)) break;
    const start = itemStart(lines[j], mk);
    const ci = start.contentIndent;
    const itemLines = [start.first];
    const itemSrc = [j];
    const itemLazy = new Set();
    let k = j + 1;
    if (start.blank && k < lines.length && isBlank(lines[k])) {
      // The item opens with a blank line and another blank follows: the
      // item is empty. The list continues only when an item marker comes
      // next; anything else is outside the list.
      let m = k;
      while (m < lines.length && isBlank(lines[m])) m++;
      const amk = m < lines.length ? matchMarker(lines[m]) : null;
      rawItems.push({ lines: itemLines, src: itemSrc, lazy: itemLazy });
      if (amk && sameListMarker(amk, first) && leadingCols(lines[m]).cols < ci) {
        loose = true;
        j = m;
        continue;
      }
      // Resume at the blank run so the parent sees the separation.
      j = k;
      listDone = true;
      break;
    }
    while (k < lines.length) {
      const line = lines[k];
      // A fenced code block inside the item swallows following lines
      // verbatim (even unindented ones) until its closing fence, as long
      // as no blank line intervenes and the fence already has content.
      const openF = itemLines.length > 0 ? unclosedFence(itemLines) : null;
      if (
        openF &&
        itemLines.length - 1 > openF.idx &&
        itemLines[itemLines.length - 1] !== '' &&
        !isBlank(line)
      ) {
        itemLines.push(stripCols(expandLeadingTabs(line, 0), ci));
        itemSrc.push(k);
        k++;
        continue;
      }
      if (isBlank(line)) {
        let b = k;
        while (b < lines.length && isBlank(lines[b])) b++;
        if (b >= lines.length) {
          k = b;
          listDone = true;
          break;
        }
        const nxt = lines[b];
        const nmk = matchMarker(nxt);
        if (nmk && sameListMarker(nmk, first) && leadingCols(nxt).cols < ci) {
          loose = true;
          k = b;
          break;
        }
        if (leadingCols(nxt).cols >= ci) {
          // the item continues after the blank run; keep every blank line
          for (let x = k; x < b; x++) {
            itemLines.push('');
            itemSrc.push(x);
          }
          k = b;
          continue;
        }
        // Resume at the blank run so the parent sees the separation.
        listDone = true;
        break;
      }
      if (leadingCols(line).cols >= ci) {
        itemLines.push(stripCols(expandLeadingTabs(line, 0), ci));
        itemSrc.push(k);
        k++;
        continue;
      }
      if (isHr(line)) {
        listDone = true;
        break;
      }
      const nmk = matchMarker(line);
      if (nmk) {
        if (sameListMarker(nmk, first)) break;
        listDone = true;
        break;
      }
      if (itemLines[itemLines.length - 1] !== '' && isParaContinuation(line)) {
        const probe = parseBlocks(itemLines, {
          defs: env.defs,
          lazy: remapLazy(itemSrc, env),
          srcNl: env.srcNl,
          endIsDocEnd: false,
          inItem: true,
        });
        if (endsWithOpenParagraph(probe)) {
          itemLazy.add(itemLines.length);
          itemLines.push(
            leadingCols(line).cols >= 4 ? line.slice(leadingCols(line).pos) : line,
          );
          itemSrc.push(k);
          k++;
          continue;
        }
      }
      listDone = true;
      break;
    }
    rawItems.push({ lines: itemLines, src: itemSrc, lazy: itemLazy });
    j = k;
  }
  const items = rawItems.map((raw, idx) => {
    // marked trims trailing whitespace from each item's raw text.
    while (raw.lines.length > 1 && raw.lines[raw.lines.length - 1] === '') {
      raw.lines.pop();
      raw.src.pop();
    }
    const lastIdx = raw.lines.length - 1;
    raw.lines[lastIdx] = raw.lines[lastIdx].replace(/[ \t]+$/, '');
    const lazySet = new Set(remapLazy(raw.src, env) ?? []);
    for (const x of raw.lazy) lazySet.add(x);
    const tracked = parseBlocksTracked(raw.lines, {
      defs: env.defs,
      lazy: lazySet.size ? lazySet : null,
      srcNl: env.srcNl,
      endIsDocEnd:
        env.endIsDocEnd && idx === rawItems.length - 1 && j >= lines.length,
      inItem: true,
    });
    const children = tracked.tokens;
    // An item whose top-level blocks are separated by a blank line makes
    // the whole list loose.
    if (tracked.blankBetween) loose = true;
    // Task list items: a leading "[ ] ", "[x] " or "[X] " in the first
    // paragraph becomes a checkbox.
    let task = false;
    let checked = false;
    if (children.length && children[0].type === 'paragraph') {
      const m = /^\[([ xX])\] /.exec(children[0].text);
      if (m) {
        task = true;
        checked = m[1] !== ' ';
        children[0] = { ...children[0], text: children[0].text.slice(4) };
      }
    }
    return { children, task, checked };
  });
  return {
    token: { type: 'list', ordered: first.ordered, start: first.num, loose, items },
    next: j,
  };
}

/** Does this line end a table body (it opens another block structure)? */
function rowEndsTable(lines, j) {
  const line = lines[j];
  if (matchFence(line) || matchAtx(line) || isHr(line)) return true;
  const { cols, pos } = leadingCols(line);
  if (cols <= 3 && line[pos] === '>') return true;
  if (matchMarker(line)) return true;
  const hk = htmlBlockKind(line);
  if (hk >= 1 && hk <= 6) return true;
  if (tryDef(lines, j)) return true;
  return false;
}

function parseBlocks(lines, env) {
  return parseBlocksTracked(lines, env).tokens;
}

function parseBlocksTracked(lines, env) {
  const tokens = [];
  let blankBetween = false;
  let pendingBlank = false;
  let blocksSeen = 0;
  const noteBlock = () => {
    if (blocksSeen && pendingBlank) blankBetween = true;
    pendingBlank = false;
    blocksSeen++;
  };
  const push = (t) => {
    noteBlock();
    tokens.push(t);
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      pendingBlank = true;
      i++;
      continue;
    }
    if (leadingCols(line).cols >= 4) {
      const buf = [];
      let j = i;
      while (j < n && (leadingCols(lines[j]).cols >= 4 || isBlank(lines[j]))) {
        const L = lines[j];
        buf.push({
          text: isBlank(L)
            ? leadingCols(L).cols >= 4
              ? stripCols(L, 4)
              : ''
            : stripCols(L, 4),
          blank: isBlank(L),
        });
        j++;
      }
      while (buf.length && buf[buf.length - 1].blank) buf.pop();
      push({
        type: 'code',
        lang: '',
        text: buf.map((b) => b.text).join('\n') + '\n',
      });
      i = j;
      continue;
    }
    const fence = matchFence(line);
    if (fence) {
      const buf = [];
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (matchClosingFence(lines[j], fence.ch, fence.len)) {
          closed = true;
          break;
        }
        // Backtick fences strip their indentation from content lines,
        // removing up to `indent` leading whitespace characters (a tab
        // counts as one character and is removed whole); tilde fences
        // keep content lines verbatim.
        buf.push(fence.ch === '~' ? lines[j] : dedentChars(lines[j], fence.indent));
        j++;
      }
      // marked drops a single trailing empty content line.
      if (buf.length && buf[buf.length - 1] === '') buf.pop();
      const info = fence.info.trim();
      push({
        type: 'code',
        lang: info === '' ? '' : unescapePunct(info.split(/\s+/)[0]),
        text: buf.length ? buf.join('\n') + '\n' : '',
      });
      i = closed ? j + 1 : j;
      continue;
    }
    const atx = matchAtx(line);
    if (atx) {
      push({ type: 'heading', depth: atx.depth, text: atx.text });
      i++;
      continue;
    }
    if (isHr(line)) {
      push({ type: 'hr' });
      i++;
      continue;
    }
    const lead = leadingCols(line);
    if (lead.cols <= 3 && line[lead.pos] === '>') {
      const r = parseBlockquote(lines, i, env);
      push(r.token);
      i = r.next;
      continue;
    }
    if (matchMarker(line)) {
      const r = parseList(lines, i, env);
      push(r.token);
      i = r.next;
      continue;
    }
    const hk = htmlBlockKind(line);
    if (hk) {
      const r = consumeHtmlBlock(lines, i, hk, env);
      push({ type: 'html', text: r.text });
      i = r.next;
      continue;
    }
    const def = tryDef(lines, i);
    if (def) {
      noteBlock();
      if (!env.defs.has(def.label)) {
        env.defs.set(def.label, { href: def.href, title: def.title });
      }
      i = def.next;
      continue;
    }
    const ts = tableStart(lines, i);
    if (ts) {
      const rows = [];
      let j = i + 2;
      // A line of only spaces plus exactly one trailing tab counts as an
      // (empty) row in marked, though other blank lines end the table.
      while (
        j < n &&
        (!isBlank(lines[j]) || /^ {0,3}\t$/.test(lines[j])) &&
        !rowEndsTable(lines, j)
      ) {
        const cells = splitRow(lines[j]);
        while (cells.length < ts.header.length) cells.push('');
        rows.push(cells.slice(0, ts.header.length));
        j++;
      }
      push({ type: 'table', header: ts.header, align: ts.align, rows });
      i = j;
      continue;
    }
    const r = collectParagraph(lines, i, env);
    push(r.token);
    i = r.next;
  }
  return { tokens, blankBetween };
}

// ------------------------------------------------------------ inline level

const WS_CHAR = /\s/;
const PUNCT_CHAR = /[\p{P}\p{S}]/u;

function isWsChar(c) {
  return c === undefined || WS_CHAR.test(c);
}
function isPunctChar(c) {
  return c !== undefined && PUNCT_CHAR.test(c);
}

const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]$/;

/** Match a domain (dot-separated labels) at src[pos]; return end index. */
function matchDomain(src, pos, needDot) {
  // Dot-separated labels of [A-Za-z0-9_-]; every label must end with an
  // alphanumeric character (so a trailing '-' or '_' invalidates the
  // whole address, as do empty labels).
  let i = pos;
  let labels = 0;
  let end = -1;
  for (;;) {
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 128));
    if (!m) break;
    if (!/[A-Za-z0-9]$/.test(m[0])) return -1;
    labels++;
    end = i + m[0].length;
    i = end;
    if (src[i] === '.' && /[A-Za-z0-9_-]/.test(src[i + 1] || '')) {
      i++;
      continue;
    }
    break;
  }
  if (labels === 0) return -1;
  if (needDot && labels < 2) return -1;
  return end;
}

/** Is `dom` a valid dotted domain under the same label rules? */
function validDomain(dom) {
  if (!dom.includes('.')) return false;
  return dom
    .split('.')
    .every((lab) => /^[A-Za-z0-9_-]+$/.test(lab) && /[A-Za-z0-9]$/.test(lab));
}

/** Trim an extended autolink's tail the way the GFM rules prescribe. */
function trimAutolink(url) {
  // marked cuts the match at the first unclosed '('.
  {
    const stack = [];
    for (let i = 0; i < url.length; i++) {
      if (url[i] === '(') stack.push(i);
      else if (url[i] === ')' && stack.length) stack.pop();
    }
    if (stack.length) url = url.slice(0, stack[0]);
  }
  for (;;) {
    if (url === '') return url;
    const last = url[url.length - 1];
    if ('?!.,:*_~'.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ';') {
      const ent = /&[A-Za-z0-9]+;$/.exec(url);
      if (ent) {
        url = url.slice(0, url.length - ent[0].length);
      } else {
        url = url.slice(0, -1);
      }
      continue;
    }
    if (last === ')') {
      // Find the '(' matching this trailing ')'. A free ')' is dropped;
      // a ')' whose group itself contains a '(' is dropped too; a ')'
      // closing a paren-free group stays.
      let depth = 0;
      let openIdx = -1;
      for (let i = url.length - 1; i >= 0; i--) {
        if (url[i] === ')') depth++;
        else if (url[i] === '(') {
          depth--;
          if (depth === 0) {
            openIdx = i;
            break;
          }
        }
      }
      if (openIdx === -1 || url.slice(openIdx + 1, -1).includes('(')) {
        url = url.slice(0, -1);
        continue;
      }
      return url;
    }
    return url;
  }
}

/**
 * Parse the "(destination title)" tail of an inline link starting at
 * src[pos] === '('. Returns { href, title, end } or null.
 */
function parseLinkDest(src, pos) {
  let p = pos + 1;
  const skipWs = () => {
    while (p < src.length && (src[p] === ' ' || src[p] === '\t' || src[p] === '\n')) p++;
  };
  skipWs();
  let href;
  if (src[p] === '<') {
    let q = p + 1;
    let ok = false;
    while (q < src.length) {
      const c = src[q];
      if (c === '\\' && ASCII_PUNCT.has(src[q + 1] || '')) {
        q += 2;
        continue;
      }
      if (c === '>') {
        ok = true;
        break;
      }
      if (c === '<' || c === '\n') return null;
      q++;
    }
    if (!ok) return null;
    href = unescapePunct(src.slice(p + 1, q));
    p = q + 1;
  } else {
    let q = p;
    let depth = 0;
    while (q < src.length) {
      const c = src[q];
      if (c === '\\' && ASCII_PUNCT.has(src[q + 1] || '')) {
        q += 2;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      q++;
    }
    if (depth !== 0) return null;
    href = unescapePunct(src.slice(p, q));
    p = q;
  }
  const afterDest = p;
  skipWs();
  if (src[p] === ')') return { href, title: null, end: p + 1 };
  const q0 = src[p];
  if (p === afterDest) return null; // a title must follow whitespace
  if (q0 !== '"' && q0 !== "'" && q0 !== '(') return null;
  const close = q0 === '(' ? ')' : q0;
  let t = '';
  let ok = false;
  p++;
  while (p < src.length) {
    const c = src[p];
    if (c === '\\' && ASCII_PUNCT.has(src[p + 1] || '')) {
      t += src.slice(p, p + 2);
      p += 2;
      continue;
    }
    if (c === close) {
      ok = true;
      p++;
      break;
    }
    if (q0 === '(' && c === '(') return null;
    t += c;
    p++;
  }
  if (!ok) return null;
  skipWs();
  if (src[p] !== ')') return null;
  return { href, title: unescapePunct(t), end: p + 1 };
}


/**
 * Scan a label's raw text toggling an in-code-span flag at every
 * backtick run: a ']' only closes the label while outside a span.
 * Returns true when the text ends inside a span.
 */
function labelEndInSpan(label) {
  let inSpan = false;
  let endsWithRun = false;
  let i = 0;
  while (i < label.length) {
    const c = label[i];
    if (c === '\\') {
      i += 2;
      endsWithRun = false;
      continue;
    }
    if (c === '`') {
      let r = 0;
      while (label[i + r] === '`') r++;
      inSpan = !inSpan;
      i += r;
      endsWithRun = i >= label.length;
      continue;
    }
    endsWithRun = false;
    i++;
  }
  // A label whose final backtick run touches the ']' still closes, even
  // with odd run parity.
  return inSpan && !endsWithRun;
}

/** Scan a reference label starting after '['; returns { label, end }. */
function parseRefLabel(src, pos) {
  let p = pos;
  let label = '';
  while (p < src.length) {
    const c = src[p];
    if (c === '\\' && ASCII_PUNCT.has(src[p + 1] || '')) {
      label += src.slice(p, p + 2);
      p += 2;
      continue;
    }
    if (c === '[') return null;
    if (c === ']') return { label, end: p + 1 };
    label += c;
    p++;
  }
  return null;
}

function parseInline(text, defs, inLabel = false) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  // marked masks code spans over the raw inline text before emphasis
  // matching: backtick runs are paired with the next run of equal
  // length, ignoring link structure. Emphasis delimiters inside a
  // masked range are inert.
  const maskedRanges = [];
  {
    let i = 0;
    while (i < text.length) {
      if (text[i] !== '`') {
        i++;
        continue;
      }
      let r = 0;
      while (text[i + r] === '`') r++;
      // an escaped backtick does not open a span
      let bs = 0;
      for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) bs++;
      if (bs % 2 === 1) {
        i += r;
        continue;
      }
      let j = i + r;
      let closeEnd = -1;
      while (j < text.length) {
        if (text[j] === '`') {
          let r2 = 0;
          while (text[j + r2] === '`') r2++;
          if (r2 === r) {
            closeEnd = j + r2;
            break;
          }
          j += r2;
        } else j++;
      }
      if (closeEnd >= 0) {
        maskedRanges.push([i, closeEnd]);
        i = closeEnd;
      } else {
        i += r;
      }
    }
  }
  const inMask = (s, e) =>
    maskedRanges.some(([a, b]) => s < b && e > a);
  let seg = []; // pending text segments { s, raw }
  let emailBarrier = 0; // plain-text length before which no email may start
  let pos = 0;
  const len = text.length;

  function segPlain() {
    let out = '';
    for (const g of seg) out += g.s;
    return out;
  }
  function addText(s) {
    if (s) seg.push({ s, raw: false });
  }
  function addRaw(s) {
    if (s) seg.push({ s, raw: true });
  }
  function flushText() {
    if (!seg.length) return;
    let html = '';
    let plain = '';
    const parts = [];
    for (const g of seg) {
      const h = g.raw ? g.s : escapeText(g.s);
      html += h;
      plain += g.s;
      parts.push({ h, p: g.s, raw: g.raw });
    }
    const last = nodes[nodes.length - 1];
    if (last && last.kind === 'text') {
      last.html += html;
      last.plain += plain;
      last.parts.push(...parts);
    } else {
      nodes.push({ kind: 'text', html, plain, parts });
    }
    seg = [];
    emailBarrier = 0;
  }

  /** Plain text of the pending segment plus trailing text/delim nodes. */
  function precedingPlain() {
    let tail = '';
    for (let k = nodes.length - 1; k >= 0; k--) {
      const node = nodes[k];
      if (node.kind === 'text') tail = node.plain + tail;
      else if (node.kind === 'delim') tail = node.char.repeat(node.len) + tail;
      else break;
    }
    return tail + segPlain();
  }

  /** Remove `count` plain characters from the end of the pending output. */
  function dropPlainTail(count) {
    let n = count;
    while (n > 0 && seg.length) {
      const g = seg[seg.length - 1];
      if (g.s.length <= n) {
        n -= g.s.length;
        seg.pop();
      } else {
        g.s = g.s.slice(0, g.s.length - n);
        n = 0;
      }
    }
    while (n > 0 && nodes.length) {
      const node = nodes[nodes.length - 1];
      if (node.kind === 'text') {
        if (!node.parts) {
          node.parts = [{ h: node.html, p: node.plain, raw: node.html === node.plain }];
        }
        while (n > 0 && node.parts.length) {
          const part = node.parts[node.parts.length - 1];
          if (part.p.length <= n) {
            n -= part.p.length;
            node.plain = node.plain.slice(0, node.plain.length - part.p.length);
            node.html = node.html.slice(0, node.html.length - part.h.length);
            node.parts.pop();
          } else {
            const keepP = part.p.slice(0, part.p.length - n);
            const keepH = part.raw ? keepP : escapeText(keepP);
            node.plain = node.plain.slice(0, node.plain.length - n);
            node.html = node.html.slice(0, node.html.length - (part.h.length - keepH.length));
            part.p = keepP;
            part.h = keepH;
            n = 0;
          }
        }
        if (!node.parts.length) nodes.pop();
      } else if (node.kind === 'delim') {
        const take = Math.min(n, node.len);
        node.len -= take;
        n -= take;
        if (node.len === 0) {
          node.canOpen = false;
          node.canClose = false;
          nodes.pop();
        }
      } else {
        break;
      }
    }
  }
  function pushNode(node) {
    flushText();
    nodes.push(node);
  }

  /** Process emphasis for delimiters above stack index `bottom`. */
  /**
   * marked refuses an emphasis match when the content's last inner
   * emphasis (same delimiter char, opposite length) was opened at a
   * word boundary and its closing run is immediately followed by a word
   * character — unless a closer-only run of the same char follows it
   * inside the content, or the closer run itself has leftover chars.
   */
  // Checks nodes[lo..hi) (the would-be content of a '*' match) for
  // marked's poison pattern; see processEmphasis.
  function isPoisoned(lo, hi, opener, use) {
    let eIdx = -1;
    let E = null;
    for (let k = hi - 1; k >= lo; k--) {
      const nd = nodes[k];
      if (
        (nd.kind === 'em' || nd.kind === 'strong') &&
        nd.dchar === '*'
      ) {
        // The last inner emphasis poisons the outer match when it was
        // built with a different use-length, or when a stray '*' opener
        // precedes it inside the span.
        let strayOpener = false;
        for (let m = lo; m < k; m++) {
          const sd = nodes[m];
          if (sd.kind === 'delim' && sd.char === '*' && sd.canOpen && sd.len > 0) {
            strayOpener = true;
            break;
          }
        }
        if (nd.duse !== use || (use === 1 && opener.len >= 2) || strayOpener) {
          E = nd;
          eIdx = k;
          break;
        }
      }
    }
    if (!E) return false;
    const before = E.oStart > 0 ? text[E.oStart - 1] : undefined;
    if (before !== undefined && !isWsChar(before) && !isPunctChar(before)) {
      return false;
    }
    const after = E.cEnd < text.length ? text[E.cEnd] : undefined;
    if (after === undefined || isWsChar(after) || isPunctChar(after)) {
      return false;
    }
    // A closer-only '*' later in the span rescues strong matches.
    if (use === 2) {
      for (let k = eIdx + 1; k < hi; k++) {
        const nd = nodes[k];
        if (nd.kind === 'delim' && nd.char === '*' && nd.canClose && !nd.canOpen) {
          return false;
        }
      }
    }
    return true;
  }

  function processEmphasis(bottom) {
    let ci = bottom + 1;
    while (ci < delims.length) {
      const closer = delims[ci];
      if (!closer.canClose) {
        ci++;
        continue;
      }
      let oi = ci - 1;
      let opener = null;
      let use = 0;
      let absorb = 0;
      const cnIdx = nodes.indexOf(closer);
      while (oi > bottom) {
        const cand = delims[oi];
        if (cand.char === closer.char && cand.canOpen) {
          let ok = false;
          if (cand.char === '~') {
            ok = cand.len === closer.len;
          } else {
            const odd =
              (closer.canOpen || cand.canClose) &&
              (cand.len + closer.len) % 3 === 0 &&
              !(cand.len % 3 === 0 && closer.len % 3 === 0);
            ok = !odd;
          }
          if (ok) {
            const u =
              closer.char === '~'
                ? closer.len
                : cand.len >= 2 && closer.len >= 2
                  ? 2
                  : 1;
            if (
              closer.char === '*' &&
              isPoisoned(nodes.indexOf(cand) + 1, cnIdx, cand, u)
            ) {
              if (u === 2 && closer.len > u && closer.canClose && !closer.canOpen) {
                // The match survives by extending the content into the
                // closer run: the leftover chars render inside.
                absorb = closer.len - u;
                closer.len = u;
                opener = cand;
                use = u;
                break;
              }
              // marked refuses this pairing; try an earlier opener.
              oi--;
              continue;
            }
            opener = cand;
            use = u;
            break;
          }
        }
        oi--;
      }
      if (!opener) {
        if (!closer.canOpen) {
          delims.splice(ci, 1);
          continue;
        }
        ci++;
        continue;
      }
      const on = nodes.indexOf(opener);
      const cn = cnIdx;
      const inner = nodes.splice(on + 1, cn - on - 1);
      if (absorb > 0) {
        inner.push({
          kind: 'delim',
          char: '*',
          len: absorb,
          canOpen: false,
          canClose: false,
          start: closer.end - absorb,
          end: closer.end,
        });
      }
      const wrap = {
        kind: closer.char === '~' ? 'del' : use === 2 ? 'strong' : 'em',
        children: inner,
        dchar: closer.char,
        duse: use,
        oStart: opener.start,
        cEnd: closer.end,
      };
      nodes.splice(on + 1, 0, wrap);
      opener.len -= use;
      closer.len -= use;
      delims.splice(oi + 1, ci - oi - 1);
      let openerRemoved = false;
      if (opener.len === 0) {
        nodes.splice(nodes.indexOf(opener), 1);
        delims.splice(oi, 1);
        openerRemoved = true;
      }
      if (closer.len === 0) {
        nodes.splice(nodes.indexOf(closer), 1);
        delims.splice(delims.indexOf(closer), 1);
        ci = oi + (openerRemoved ? 0 : 1);
      } else {
        ci = delims.indexOf(closer);
      }
    }
  }

  /** Extended autolinks do not survive inside a link label. */
  function unwrapAutoLinks(list) {
    for (let k = 0; k < list.length; k++) {
      const node = list[k];
      if (node.kind === 'link' && node.auto) {
        const plain = node.children.map((ch) => ch.plain || '').join('');
        list[k] = {
          kind: 'text',
          html: escapeText(plain),
          plain,
          parts: [{ h: escapeText(plain), p: plain, raw: false }],
        };
      } else if (node.children) {
        unwrapAutoLinks(node.children);
      }
    }
  }

  /** Attempt to close a link or image at text[pos] === ']'. */
  function closeBracket() {
    const oi = brackets.length - 1;
    if (oi < 0) {
      addText(']');
      return pos + 1;
    }
    const opener = brackets[oi];
    if (!opener.active) {
      // An inactive innermost opener is simply discarded.
      brackets.length = oi;
      addText(']');
      return pos + 1;
    }
    const textRaw = text.slice(opener.contentPos, pos);
    if (labelEndInSpan(textRaw)) {
      // This ']' sits inside a code span (backtick-run parity), so it
      // does not close the label at all.
      brackets.length = oi;
      // When an inline destination follows the ']', marked's failed
      // link attempt leaves the label's emphasis delimiters inert.
      if (text[pos + 1] === '(') {
        for (let k = opener.delimIdx; k < delims.length; k++) {
          delims[k].canOpen = false;
          delims[k].canClose = false;
        }
      }
      addText(']');
      return pos + 1;
    }
    let href = null;
    let title = null;
    let end = -1;
    let isRef = false;
    if (text[pos + 1] === '(') {
      const d = parseLinkDest(text, pos + 1);
      if (d) {
        href = d.href;
        title = d.title;
        end = d.end;
      }
    }
    let labelPresent = false;
    if (end < 0 && text[pos + 1] === '[') {
      const r = parseRefLabel(text, pos + 2);
      if (r) {
        labelPresent = true;
        const label = r.label === '' ? textRaw : r.label;
        const def = defs.get(normalizeLabel(label));
        if (def) {
          href = def.href;
          title = def.title;
          end = r.end;
          isRef = true;
        }
      }
    }
    if (end < 0 && !isRef && !labelPresent) {
      const def = defs.get(normalizeLabel(textRaw));
      if (def) {
        href = def.href;
        title = def.title;
        end = pos + 1;
      }
    }
    if (end < 0) {
      brackets.length = oi;
      addText(']');
      return pos + 1;
    }
    // Form the link or image. marked tokenizes the label separately
    // from the surrounding text, so re-parse the raw label on its
    // own: its code-span mask and autolink suppression are scoped
    // to the label, and tags inside it do not leak the in-link flag.
    flushText();
    delims.length = opener.delimIdx;
    const on = nodes.indexOf(opener.node);
    nodes.length = on + 1;
    const children = parseInline(textRaw, defs, true);
    docInLink = opener.inLinkSnapshot;
    const node = {
      kind: opener.isImage ? 'image' : 'link',
      href,
      title,
      children,
    };
    nodes[on] = node;
    brackets.length = oi;
    if (!opener.isImage) {
      for (const b of brackets) {
        if (!b.isImage) b.active = false;
      }
    }
    return end;
  }

  /** Try an extended (GFM) autolink at `pos`; return end index or -1. */
  function tryUrlAutolink() {
    if (docInLink || inLabel) return -1;
    let hrefPrefix = '';
    if (text.startsWith('www.', pos)) {
      hrefPrefix = 'http://';
    } else if (
      !/^https?:\/\//i.test(text.slice(pos, pos + 9)) &&
      !/^ftp:\/\//i.test(text.slice(pos, pos + 7))
    ) {
      return -1;
    }
    if (pos > 0 && /[A-Za-z0-9]/.test(text[pos - 1])) return -1;
    const m = /^[^\s<]+/.exec(text.slice(pos));
    if (!m) return -1;
    let raw = m[0];
    // Inside an active open bracket, the match must not swallow the
    // closing ']': if the bracket forms a link, the label text is plain
    // again anyway.
    if (brackets.length && brackets[brackets.length - 1].active) {
      const cut = raw.indexOf(']');
      if (cut >= 0) raw = raw.slice(0, cut);
    }
    const url = trimAutolink(raw);
    const schemeLen = hrefPrefix ? 4 : text.indexOf('://', pos) + 3 - pos;
    if (url.length <= schemeLen) return -1;
    pushNode({
      kind: 'link',
      auto: true,
      href: hrefPrefix + url,
      title: null,
      children: [{ kind: 'text', html: escapeText(url), plain: url, parts: [] }],
    });
    return pos + url.length;
  }

  /** Try an extended email autolink; text[pos] === '@'. Return end or -1. */
  function tryEmailAutolink() {
    if (docInLink || inLabel) return -1;
    const segLen = segPlain().length;
    const plain = precedingPlain();
    // emailBarrier is measured from the start of the pending segment;
    // zero means the lookback may extend into earlier text/delim nodes.
    const barrier = emailBarrier > 0 ? plain.length - segLen + emailBarrier : 0;
    let li = plain.length;
    while (li > barrier && LOCAL_PART.test(plain[li - 1])) li--;
    const local = plain.slice(li);
    if (local === '') return -1;
    let prefix = '';
    const before = plain.slice(0, li);
    if (before.endsWith('mailto:') && li - 7 >= barrier) prefix = 'mailto:';
    else if (before.endsWith('xmpp:') && li - 5 >= barrier) prefix = 'xmpp:';
    let domEnd = matchDomain(text, pos + 1, true);
    let trimmedRun = 0;
    if (domEnd < 0) {
      // marked tokenizes emphasis content separately, so a domain that
      // runs into an emphasis-closing run of '_' still links when an
      // unmatched '_' opener is on the delimiter stack.
      const raw = /^[A-Za-z0-9_.-]+/.exec(text.slice(pos + 1));
      if (
        raw &&
        /_$/.test(raw[0]) &&
        delims.some((d) => d.char === '_' && d.canOpen && d.len > 0)
      ) {
        const stripped = raw[0].replace(/_+$/, '');
        if (validDomain(stripped)) {
          domEnd = pos + 1 + stripped.length;
          trimmedRun = raw[0].length - stripped.length;
        }
      }
    }
    if (domEnd < 0) return -1;
    const after = text[domEnd + trimmedRun];
    if (after !== undefined && /[A-Za-z0-9_-]/.test(after)) return -1;
    let end = domEnd;
    if (prefix) {
      const segm = /^\/[^\s<>@\/]+/.exec(text.slice(end));
      if (segm) {
        let e2 = end + segm[0].length;
        if (text[e2] === '@') {
          const d2 = matchDomain(text, e2 + 1, false);
          if (d2 > 0 && !/[A-Za-z0-9_-]/.test(text[d2] || '')) e2 = d2;
        }
        end = e2;
      }
    }
    const addr = local + '@' + text.slice(pos + 1, domEnd);
    const full = prefix + addr + text.slice(domEnd, end);
    // Drop the local part (and any scheme prefix) from the pending text.
    dropPlainTail(local.length + prefix.length);
    pushNode({
      kind: 'link',
      auto: true,
      href: prefix ? full : 'mailto:' + addr,
      title: null,
      children: [{ kind: 'text', html: escapeText(full), plain: full, parts: [] }],
    });
    return end;
  }

  while (pos < len) {
    const c = text[pos];
    if (c === '\\') {
      const next = text[pos + 1];
      if (next === '\n') {
        pushNode({ kind: 'br' });
        pos += 2;
        // marked strips the next line's leading whitespace after a break
        while (text[pos] === ' ' || text[pos] === '\t') pos++;
      } else if (next !== undefined && ASCII_PUNCT.has(next)) {
        addText(next);
        emailBarrier = segPlain().length;
        pos += 2;
      } else {
        addText('\\');
        pos += 1;
      }
      continue;
    }
    if (c === '`') {
      let r = 0;
      while (text[pos + r] === '`') r++;
      let close = -1;
      // Inside an open bracket, the closing run must come before the
      // bracket's end: a code span cannot swallow the link's ']'.
      // Only an active bracket bounds the search; leftover inactive
      // brackets (their ']' was consumed by an autolink or a nested
      // link) no longer delimit anything.
      let limit = len;
      let innerActive = null;
      for (let b = brackets.length - 1; b >= 0; b--) {
        if (brackets[b].active) {
          innerActive = brackets[b];
          break;
        }
      }
      if (innerActive) {
        // Find the bracket's label end: a ']' counts only at depth
        // zero and outside a code span (backtick-run parity).
        let depth = 1;
        let inSpan = false;
        let k = innerActive.contentPos;
        while (k < len) {
          const ch = text[k];
          if (ch === '\\') {
            k += 2;
            continue;
          }
          if (ch === '`') {
            let r = 0;
            while (text[k + r] === '`') r++;
            inSpan = !inSpan;
            k += r;
            continue;
          }
          if (!inSpan) {
            if (ch === '[') depth++;
            else if (ch === ']') {
              depth--;
              if (depth === 0) {
                limit = k;
                break;
              }
            }
          }
          k++;
        }
      }
      let j = pos + r;
      while (j < limit) {
        if (text[j] === '`') {
          let r2 = 0;
          while (text[j + r2] === '`') r2++;
          if (r2 === r) {
            close = j;
            break;
          }
          j += r2;
        } else {
          j++;
        }
      }
      if (close < 0) {
        addText('`'.repeat(r));
        pos += r;
      } else {
        let content = text.slice(pos + r, close).replace(/\n/g, ' ');
        if (
          content.length >= 2 &&
          content.startsWith(' ') &&
          content.endsWith(' ') &&
          content.trim() !== ''
        ) {
          content = content.slice(1, -1);
        }
        pushNode({ kind: 'code', text: content });
        pos = close + r;
      }
      continue;
    }
    if (c === '<') {
      const rest = text.slice(pos, pos + 9);
      let done = false;
      if (rest.startsWith('<!--')) {
        // The abrupt closings <!--> and <!---> are complete comments.
        let e = -1;
        if (text.startsWith('<!-->', pos)) e = pos + 2;
        else if (text.startsWith('<!--->', pos)) e = pos + 3;
        else e = text.indexOf('-->', pos + 4);
        if (e >= 0) {
          pushNode({ kind: 'html', text: text.slice(pos, e + 3) });
          pos = e + 3;
          done = true;
        }
      } else if (rest.startsWith('<?')) {
        const e = text.indexOf('?>', pos + 2);
        if (e >= 0) {
          pushNode({ kind: 'html', text: text.slice(pos, e + 2) });
          pos = e + 2;
          done = true;
        }
      } else if (rest.startsWith('<![CDATA[')) {
        const e = text.indexOf(']]>', pos + 9);
        if (e >= 0) {
          pushNode({ kind: 'html', text: text.slice(pos, e + 3) });
          pos = e + 3;
          done = true;
        }
      } else if (/^<![A-Z]/.test(rest)) {
        const e = text.indexOf('>', pos + 2);
        if (e >= 0) {
          pushNode({ kind: 'html', text: text.slice(pos, e + 1) });
          pos = e + 1;
          done = true;
        }
      }
      if (done) continue;
      const auto = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(text.slice(pos));
      if (auto) {
        pushNode({
          kind: 'link',
          href: auto[1],
          title: null,
          children: [{ kind: 'text', html: escapeText(auto[1]), plain: auto[1] }],
        });
        pos += auto[0].length;
        continue;
      }
      const mail = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+))>/.exec(
        text.slice(pos),
      );
      if (mail && validDomain(mail[2])) {
        pushNode({
          kind: 'link',
          href: 'mailto:' + mail[1],
          title: null,
          children: [{ kind: 'text', html: escapeText(mail[1]), plain: mail[1] }],
        });
        pos += mail[0].length;
        continue;
      }
      const tagEnd = parseTag(text, pos);
      if (tagEnd !== null) {
        const tagText = text.slice(pos, tagEnd);
        pushNode({ kind: 'html', text: tagText });
        // marked sets its in-link flag for an <a> tag that carries
        // attributes (i.e. "<a" followed by whitespace), even a
        // self-closing one; only an exact </a> clears it.
        if (/^<a\s/i.test(tagText)) {
          docInLink = true;
        } else if (tagText.toLowerCase() === '</a>') {
          docInLink = false;
        }
        pos = tagEnd;
        continue;
      }
      addText('<');
      pos++;
      continue;
    }
    if (c === '!' && text[pos + 1] === '[') {
      flushText();
      const node = { kind: 'opener', raw: '![', isImage: true };
      nodes.push(node);
      brackets.push({
        node,
        isImage: true,
        active: true,
        delimIdx: delims.length,
        contentPos: pos + 2,
        inLinkSnapshot: docInLink,
      });
      pos += 2;
      continue;
    }
    if (c === '[') {
      flushText();
      const node = { kind: 'opener', raw: '[', isImage: false };
      nodes.push(node);
      brackets.push({
        node,
        isImage: false,
        active: true,
        delimIdx: delims.length,
        contentPos: pos + 1,
        inLinkSnapshot: docInLink,
      });
      pos += 1;
      continue;
    }
    if (c === ']') {
      pos = closeBracket();
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let r = 0;
      while (text[pos + r] === c) r++;
      if (c === '~' && r >= 3) {
        addText('~'.repeat(r));
        pos += r;
        continue;
      }
      const before = pos > 0 ? text[pos - 1] : undefined;
      const after = pos + r < len ? text[pos + r] : undefined;
      const leftFlank =
        !isWsChar(after) && (!isPunctChar(after) || isWsChar(before) || isPunctChar(before));
      const rightFlank =
        !isWsChar(before) &&
        (!isPunctChar(before) || isWsChar(after) || isPunctChar(after));
      let canOpen;
      let canClose;
      if (c === '_') {
        canOpen = leftFlank && (!rightFlank || isPunctChar(before));
        canClose = rightFlank && (!leftFlank || isPunctChar(after));
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      if ((c === '*' || c === '_') && inMask(pos, pos + r)) {
        canOpen = false;
        canClose = false;
      }
      flushText();
      const node = {
        kind: 'delim',
        char: c,
        len: r,
        canOpen,
        canClose,
        start: pos,
        end: pos + r,
      };
      nodes.push(node);
      delims.push(node);
      pos += r;
      continue;
    }
    if (c === '&') {
      const num = NUMERIC_ENTITY.exec(text.slice(pos, pos + 12));
      if (num) {
        const cp =
          num[1] !== undefined ? parseInt(num[1], 10) : parseInt(num[2], 16);
        const ch =
          cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)
            ? '\ufffd'
            : String.fromCodePoint(cp);
        addText(ch);
        pos += num[0].length;
        continue;
      }
      const named = NAMED_ENTITY.exec(text.slice(pos, pos + 42));
      if (named) {
        addRaw(named[0]);
        pos += named[0].length;
        continue;
      }
      addText('&');
      pos++;
      continue;
    }
    if (c === '\n') {
      const plain = segPlain();
      if (/ {2,}$/.test(plain)) {
        // hard break: drop the trailing spaces
        let drop = / {2,}$/.exec(plain)[0].length;
        while (drop > 0 && seg.length) {
          const g = seg[seg.length - 1];
          if (g.s.length <= drop) {
            drop -= g.s.length;
            seg.pop();
          } else {
            g.s = g.s.slice(0, g.s.length - drop);
            drop = 0;
          }
        }
        pushNode({ kind: 'br' });
        pos++;
        while (text[pos] === ' ' || text[pos] === '\t') pos++;
        continue;
      }
      addText('\n');
      pos++;
      continue;
    }
    if (c === '@') {
      const end = tryEmailAutolink();
      if (end > 0) {
        pos = end;
        continue;
      }
      addText('@');
      pos++;
      continue;
    }
    // ordinary text run, watching for extended autolinks
    let j = pos;
    while (j < len) {
      const ch = text[j];
      if (
        ch === '\\' || ch === '`' || ch === '<' || ch === '[' || ch === ']' ||
        ch === '*' || ch === '_' || ch === '~' || ch === '&' || ch === '\n' ||
        ch === '@'
      ) {
        break;
      }
      if (ch === '!' && text[j + 1] === '[') break;
      if (
        (ch === 'w' && text.startsWith('www.', j)) ||
        ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(text.slice(j, j + 9))) ||
        ((ch === 'f' || ch === 'F') && /^ftp:\/\//i.test(text.slice(j, j + 7)))
      ) {
        break;
      }
      j++;
    }
    if (j === pos) {
      // an autolink starts here
      const end = tryUrlAutolink();
      if (end > 0) {
        pos = end;
        continue;
      }
      addText(text[pos]);
      pos++;
      continue;
    }
    addText(text.slice(pos, j));
    pos = j;
  }
  flushText();
  processEmphasis(-1);
  return nodes;
}

// --------------------------------------------------------------- rendering

function plainOfNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'text':
        out += nd.plain;
        break;
      case 'code':
        out += nd.text;
        break;
      case 'delim':
        out += nd.char.repeat(nd.len);
        break;
      case 'opener':
        out += nd.raw;
        break;
      case 'em':
      case 'strong':
      case 'del':
      case 'link':
        out += plainOfNodes(nd.children);
        break;
      case 'image':
        out += plainOfNodes(nd.children);
        break;
      default:
        break;
    }
  }
  return out;
}

function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'text':
        out += nd.html;
        break;
      case 'code':
        out += '<code>' + escapeAll(nd.text) + '</code>';
        break;
      case 'html':
        out += nd.text;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'delim':
        out += nd.char.repeat(nd.len);
        break;
      case 'opener':
        out += nd.raw;
        break;
      case 'em':
        out += '<em>' + renderInline(nd.children) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderInline(nd.children) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderInline(nd.children) + '</del>';
        break;
      case 'link': {
        const href = hrefAttr(nd.href);
        if (href === null) {
          out += renderInline(nd.children);
          break;
        }
        out += '<a href="' + href + '"';
        if (nd.title) out += ' title="' + escapeText(nd.title) + '"';
        out += '>' + renderInline(nd.children) + '</a>';
        break;
      }
      case 'image': {
        const href = hrefAttr(nd.href);
        const alt = escapeText(plainOfNodes(nd.children));
        if (href === null) {
          out += alt;
          break;
        }
        out += '<img src="' + href + '" alt="' + alt + '"';
        if (nd.title) out += ' title="' + escapeText(nd.title) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

function inlineHtml(text, defs) {
  return renderInline(parseInline(text, defs));
}

function renderListItem(item, loose, defs) {
  let out = '';
  item.children.forEach((child, idx) => {
    const isTaskPara = item.task && idx === 0 && child.type === 'paragraph';
    if (!loose && child.type === 'paragraph') {
      if (isTaskPara) {
        out +=
          (item.checked
            ? '<input checked="" disabled="" type="checkbox"> '
            : '<input disabled="" type="checkbox"> ') + inlineHtml(child.text, defs);
      } else {
        out += inlineHtml(child.text, defs);
      }
    } else if (isTaskPara) {
      out +=
        '<p>' +
        (item.checked
          ? '<input checked="" disabled="" type="checkbox"> '
          : '<input disabled="" type="checkbox"> ') +
        inlineHtml(child.text, defs) +
        '</p>\n';
    } else {
      out += renderToken(child, defs);
    }
  });
  return out;
}

function renderToken(tok, defs) {
  switch (tok.type) {
    case 'paragraph':
      return '<p>' + inlineHtml(tok.text, defs) + '</p>\n';
    case 'heading':
      return (
        '<h' + tok.depth + '>' + inlineHtml(tok.text, defs) + '</h' + tok.depth + '>\n'
      );
    case 'code': {
      const cls = tok.lang ? ' class="language-' + escapeText(tok.lang) + '"' : '';
      return '<pre><code' + cls + '>' + escapeAll(tok.text) + '</code></pre>\n';
    }
    case 'html':
      return tok.text;
    case 'hr':
      return '<hr>\n';
    case 'blockquote':
      return (
        '<blockquote>\n' +
        tok.children.map((t) => renderToken(t, defs)).join('') +
        '</blockquote>\n'
      );
    case 'list': {
      const tag = tok.ordered ? 'ol' : 'ul';
      let out =
        '<' +
        tag +
        (tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '') +
        '>\n';
      for (const item of tok.items) {
        out += '<li>' + renderListItem(item, tok.loose, defs) + '</li>\n';
      }
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      tok.header.forEach((cell, i) => {
        const a = tok.align[i] ? ' align="' + tok.align[i] + '"' : '';
        out += '<th' + a + '>' + inlineHtml(cell, defs) + '</th>\n';
      });
      out += '</tr>\n</thead>\n';
      if (tok.rows.length) {
        out += '<tbody>';
        for (const row of tok.rows) {
          out += '<tr>\n';
          row.forEach((cell, i) => {
            const a = tok.align[i] ? ' align="' + tok.align[i] + '"' : '';
            out += '<td' + a + '>' + inlineHtml(cell, defs) + '</td>\n';
          });
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

// -------------------------------------------------------------------- main

/**
 * Render a Markdown document to the HTML marked 18.1.3 produces for it
 * with default options.
 */
// marked keeps a lexer-level "in link" flag: an inline <a> opening tag
// suppresses extended autolinks (www/scheme/bare email) from that point
// on — across block boundaries — until a </a> tag appears.
let docInLink = false;

export function parse(markdown) {
  docInLink = false;
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const srcNl = src.endsWith('\n');
  const lines = src.split('\n');
  if (srcNl) lines.pop();
  const defs = new Map();
  const tokens = parseBlocks(lines, {
    defs,
    lazy: null,
    srcNl,
    endIsDocEnd: true,
  });
  return tokens.map((t) => renderToken(t, defs)).join('');
}
