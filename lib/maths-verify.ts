/**
 * Deterministic numerical equivalence checker (Phase 2 verifier).
 *
 * Self-contained — no CAS dependency. It converts a SAFE subset of LaTeX
 * (polynomial / rational arithmetic: + - * / ^, parentheses, \frac, \cdot,
 * single-letter variables, implicit multiplication) into an infix expression,
 * evaluates both expressions at a fixed spread of points, and compares.
 *
 * Safety contract — the whole point of this module:
 *   It returns 'unknown' for ANYTHING it cannot parse with confidence
 *   (functions, sqrt, trig, logs, subscripts, absolute value, Greek letters,
 *   leftover LaTeX, equals signs). A definite verdict ('equivalent' /
 *   'not_equivalent') is emitted ONLY when the expression is fully within the
 *   supported grammar and the numeric evidence is unambiguous. We would rather
 *   say "unknown" a hundred times than be confidently wrong once — a wrong
 *   verdict could tell a student their correct work is wrong.
 *
 * Used by the Pass B `check_equivalence` tool. The model decides WHICH pairs of
 * expressions to check (it knows intent — is this a simplification, an
 * expansion?); this module gives the deterministic answer.
 */

export type EquivalenceVerdict = 'equivalent' | 'not_equivalent' | 'unknown';

const SUPPORTED_CHARS = /^[0-9.+\-*/^()a-zA-Z]*$/;

/**
 * Convert a LaTeX expression to an infix string in the supported grammar, or
 * null if it contains anything outside that grammar.
 */
function latexToInfix(latex: string): string | null {
  if (typeof latex !== 'string') return null;
  let s = latex.trim();
  if (!s) return null;

  // Strip spacing / formatting commands that don't affect value.
  s = s.replace(/\\left|\\right|\\!|\\,|\\;|\\:|\\quad|\\qquad|\\displaystyle|\\,/g, '');
  // Multiplication / division words.
  s = s.replace(/\\cdot|\\times/g, '*');
  s = s.replace(/\\div/g, '/');

  // \frac{A}{B} -> ((A)/(B)), brace-matched, innermost-first. Bail if a \frac
  // can't be cleanly matched.
  for (let guard = 0; s.indexOf('\\frac') !== -1; guard++) {
    if (guard > 100) return null;
    const next = replaceOneFrac(s);
    if (next === null) return null;
    s = next;
  }

  // ^{...} -> ^(...). Only non-nested braces; nested/leftover braces fail the
  // brace check below and bail to unknown.
  s = s.replace(/\^\{([^{}]*)\}/g, '^($1)');

  // Drop all whitespace.
  s = s.replace(/\s+/g, '');

  // Anything still carrying a backslash or brace is unsupported → unknown.
  if (/[\\{}]/.test(s)) return null;
  if (!SUPPORTED_CHARS.test(s)) return null;
  return s;
}

/** Replace the first \frac{A}{B} (brace-matched) with ((A)/(B)). */
function replaceOneFrac(s: string): string | null {
  const idx = s.indexOf('\\frac');
  if (idx === -1) return s;
  let i = idx + 5;
  const a = readBraceGroup(s, i);
  if (!a) return null;
  i = a.end;
  const b = readBraceGroup(s, i);
  if (!b) return null;
  return s.slice(0, idx) + '((' + a.inner + ')/(' + b.inner + '))' + s.slice(b.end);
}

/** Read a {...} group starting at index `i` (which must point at '{'). */
function readBraceGroup(s: string, i: number): { inner: string; end: number } | null {
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}') {
      depth--;
      if (depth === 0) return { inner: s.slice(i + 1, j), end: j + 1 };
    }
  }
  return null;
}

type Token = { t: 'num'; v: number } | { t: 'var'; v: string } | { t: 'op'; v: string } | { t: 'lp' } | { t: 'rp' };

/** Tokenize the infix string, inserting implicit-multiplication operators. */
function tokenize(s: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isAlpha = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

  const maybeImplicitMul = () => {
    // Insert '*' if the previous token ends an operand and the next starts one.
    const prev = out[out.length - 1];
    if (!prev) return;
    if (prev.t === 'num' || prev.t === 'var' || prev.t === 'rp') out.push({ t: 'op', v: '*' });
  };

  while (i < s.length) {
    const c = s[i];
    if (isDigit(c) || c === '.') {
      let j = i + 1;
      while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++;
      const num = Number(s.slice(i, j));
      if (!Number.isFinite(num)) return null;
      maybeImplicitMul();
      out.push({ t: 'num', v: num });
      i = j;
    } else if (isAlpha(c)) {
      maybeImplicitMul();
      out.push({ t: 'var', v: c }); // single-letter variables; adjacency multiplies
      i++;
    } else if (c === '+' || c === '-' || c === '*' || c === '/' || c === '^') {
      out.push({ t: 'op', v: c });
      i++;
    } else if (c === '(') {
      maybeImplicitMul();
      out.push({ t: 'lp' });
      i++;
    } else if (c === ')') {
      out.push({ t: 'rp' });
      i++;
    } else {
      return null;
    }
  }
  return out;
}

const PREC: Record<string, number> = { '+': 2, '-': 2, '*': 3, '/': 3, '^': 4, 'u-': 5 };
const RIGHT_ASSOC = new Set(['^', 'u-']);

/** Shunting-yard → RPN. Handles unary minus. Returns null on malformed input. */
function toRpn(tokens: Token[]): Token[] | null {
  const output: Token[] = [];
  const ops: Token[] = [];
  let prev: Token | null = null;
  for (const tok of tokens) {
    if (tok.t === 'num' || tok.t === 'var') {
      output.push(tok);
    } else if (tok.t === 'op') {
      let v = tok.v;
      // Unary minus/plus: at start, or after another operator or '('.
      if ((v === '-' || v === '+') && (!prev || prev.t === 'op' || prev.t === 'lp')) {
        v = v === '-' ? 'u-' : 'u+';
        if (v === 'u+') { prev = tok; continue; } // unary plus is a no-op
      }
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top.t !== 'op') break;
        const tv = top.v;
        const higher = PREC[tv] > PREC[v] || (PREC[tv] === PREC[v] && !RIGHT_ASSOC.has(v));
        if (higher) output.push(ops.pop()!); else break;
      }
      ops.push({ t: 'op', v });
    } else if (tok.t === 'lp') {
      ops.push(tok);
    } else if (tok.t === 'rp') {
      let found = false;
      while (ops.length) {
        const top = ops.pop()!;
        if (top.t === 'lp') { found = true; break; }
        output.push(top);
      }
      if (!found) return null;
    }
    prev = tok;
  }
  while (ops.length) {
    const top = ops.pop()!;
    if (top.t === 'lp') return null;
    output.push(top);
  }
  return output;
}

/** Evaluate RPN at a variable environment. Returns null on any domain error. */
function evalRpn(rpn: Token[], env: Record<string, number>): number | null {
  const st: number[] = [];
  for (const tok of rpn) {
    if (tok.t === 'num') st.push(tok.v);
    else if (tok.t === 'var') {
      const val = env[tok.v];
      if (val === undefined) return null;
      st.push(val);
    } else if (tok.t === 'op') {
      if (tok.v === 'u-') { if (!st.length) return null; st.push(-st.pop()!); continue; }
      if (st.length < 2) return null;
      const b = st.pop()!; const a = st.pop()!;
      let r: number;
      switch (tok.v) {
        case '+': r = a + b; break;
        case '-': r = a - b; break;
        case '*': r = a * b; break;
        case '/': if (Math.abs(b) < 1e-12) return null; r = a / b; break;
        case '^': r = Math.pow(a, b); break;
        default: return null;
      }
      if (!Number.isFinite(r)) return null;
      st.push(r);
    }
  }
  if (st.length !== 1) return null;
  return st[0];
}

function freeVars(tokens: Token[]): string[] {
  const set = new Set<string>();
  for (const t of tokens) if (t.t === 'var') set.add(t.v);
  return [...set];
}

// A fixed, well-spread set of sample values (irrational-ish, no zeros) so the
// verifier is deterministic and reproducible. Each variable is given a distinct
// phase so multi-variable expressions aren't evaluated on the diagonal.
const SAMPLES = [0.7, 1.3, 2.1, -1.7, 3.1, -0.9, 1.9, -2.3, 0.43, 2.7, -1.1, 3.7, 0.91, -3.3, 1.57, -0.61];

function compile(latex: string): { rpn: Token[]; vars: string[] } | null {
  const infix = latexToInfix(latex);
  if (infix === null) return null;
  const tokens = tokenize(infix);
  if (!tokens || tokens.length === 0) return null;
  const rpn = toRpn(tokens);
  if (!rpn) return null;
  return { rpn, vars: freeVars(tokens) };
}

/**
 * Are two LaTeX expressions numerically equivalent? Returns 'unknown' whenever
 * either expression falls outside the supported grammar or the evidence is
 * insufficient — a definite verdict is only ever returned when the engine is
 * confident.
 */
export function checkEquivalence(latexA: string, latexB: string): { verdict: EquivalenceVerdict; detail?: string } {
  const a = compile(latexA);
  const b = compile(latexB);
  if (!a || !b) return { verdict: 'unknown', detail: 'Expression outside the supported (polynomial/rational) grammar.' };

  const vars = [...new Set([...a.vars, ...b.vars])];
  let valid = 0;
  let firstDiff: string | undefined;

  // For 0-variable (pure numeric) expressions, one evaluation suffices.
  const trials = vars.length === 0 ? 1 : SAMPLES.length;

  for (let k = 0; k < trials; k++) {
    const env: Record<string, number> = {};
    vars.forEach((v, vi) => { env[v] = SAMPLES[(k + vi * 5) % SAMPLES.length]; });
    const va = evalRpn(a.rpn, env);
    const vb = evalRpn(b.rpn, env);
    if (va === null || vb === null) continue; // domain error at this point — skip
    valid++;
    const tol = 1e-7 * Math.max(1, Math.abs(va), Math.abs(vb));
    if (Math.abs(va - vb) > tol) {
      if (!firstDiff) firstDiff = `at {${vars.map((v, vi) => `${v}=${SAMPLES[(k + vi * 5) % SAMPLES.length]}`).join(', ') || '(numeric)'}}: ${round(va)} ≠ ${round(vb)}`;
      return { verdict: 'not_equivalent', detail: firstDiff };
    }
  }

  // Need enough agreeing points to be confident. A non-trivial difference of
  // two polynomials/rationals would have shown up across this many spread points.
  const need = vars.length === 0 ? 1 : 5;
  if (valid < need) return { verdict: 'unknown', detail: 'Too few evaluable points (domain restrictions).' };
  return { verdict: 'equivalent' };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
