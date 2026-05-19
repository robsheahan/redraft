/*
 * Shared rendering helpers for task description + syllabus outcomes.
 * Used by task-detail.html, submit.html, and new-task.html (input normaliser).
 *
 * Exposes on window:
 *   - renderTaskDescription(text, escapeFn)  → HTML string
 *   - renderTaskOutcomes(outcomes, escapeFn) → HTML string
 *   - normaliseOutcomesInput(raw)            → string[]  (clean array)
 */
(function () {
  // NESA-style outcome codes. Covers PD4-1, PDHPE12-1, HM-12-06, MA5.3-1,
  // EN12-1, SC5-7WS, HMS-12-01 etc. The trailing letter-suffix uses a
  // negative lookahead so we don't eat the first letter of the next word
  // when codes are glued to descriptors (e.g. "PD4-1Examines factors...").
  const OUTCOME_CODE_RE = /\b[A-Z]{2,8}-?\d{1,3}(?:\.\d{1,2})?-\d{1,3}(?:[A-Z]{1,3}(?![a-z]))?/g;

  // Section heading markers (Section 1:, Part A:, Step 2., Stage 3 —).
  const SECTION_MARKER_RE = /(^|\n|[\s])((?:Section|Part|Step|Stage)\s+(?:\d+|[A-Z]))[:.\-–—]/g;

  // Heuristic: is this line a noise/table-header fragment we should drop?
  // Strips known boilerplate phrases and sees if anything substantive remains.
  function isNoiseLine(line) {
    const stripped = String(line || '')
      .replace(/nesa/gi, '')
      .replace(/syllabus\s+outcomes?(\s+assessed)?:?/gi, '')
      .replace(/^outcomes?(\s+assessed)?:?$/gi, '')
      .replace(/outcome\s+code:?/gi, '')
      .replace(/descriptors?:?/gi, '')
      .replace(/[\s:|.\-–—]+/g, '')
      .trim();
    return stripped.length === 0;
  }

  function normaliseOutcomesInput(raw) {
    if (!raw) return [];
    // Insert a newline before every outcome code so glued-together pasted
    // tables (where cell boundaries became spaces or nothing) split cleanly.
    const withBreaks = String(raw).replace(OUTCOME_CODE_RE, m => '\n' + m);
    return withBreaks
      .split('\n')
      .map(l => l.replace(/^\s*[-*•]\s*/, '').trim())
      .filter(l => l.length > 0)
      .filter(l => !isNoiseLine(l));
  }

  function parseOutcome(entry) {
    const trimmed = String(entry || '').trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^([A-Z]{2,8}-?\d{1,3}(?:\.\d{1,2})?-\d{1,3}(?:[A-Z]{1,3}(?![a-z]))?)/);
    if (match) {
      const code = match[1];
      let descriptor = trimmed.slice(code.length);
      descriptor = descriptor.replace(/^[\s\-–—:|]+/, '').trim();
      descriptor = descriptor.replace(/\.{2,}$/, '.').trim();
      return { code, descriptor };
    }
    return { code: null, descriptor: trimmed };
  }

  function renderTaskOutcomes(outcomes, escapeFn) {
    if (!Array.isArray(outcomes) || outcomes.length === 0) return '';
    // Run each stored entry back through the normaliser so legacy rows
    // (where the whole NESA table got pasted as one string) still display
    // as separate code+descriptor rows.
    const flat = [];
    outcomes.forEach(o => {
      normaliseOutcomesInput(String(o || '')).forEach(n => flat.push(n));
    });
    if (flat.length === 0) return '';
    const parsed = flat.map(parseOutcome).filter(p => p && (p.code || p.descriptor));
    if (parsed.length === 0) return '';
    let html = '<div class="outcome-grid">';
    parsed.forEach(p => {
      html += '<div class="outcome-row">';
      if (p.code) {
        html += '<span class="outcome-code">' + escapeFn(p.code) + '</span>';
      } else {
        html += '<span class="outcome-code outcome-code-empty">—</span>';
      }
      html += '<span class="outcome-desc">' + escapeFn(p.descriptor || '') + '</span>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  // Section-heading detector for already-split lines.
  function sectionHeadingMatch(line) {
    return line.match(/^((?:Section|Part|Step|Stage)\s+(?:\d+|[A-Z]))\s*[:.\-–—]?\s*(.*)$/i);
  }

  function bulletMatch(line) {
    return line.match(/^\s*[-*•]\s+(.+)$/);
  }

  function renderTaskDescription(text, escapeFn) {
    if (!text) return '';
    // Strip a redundant leading heading like "Task Description" / "Description"
    // that some teachers paste at the top — we already render a label above.
    let prepared = String(text).replace(
      /^\s*(?:task\s+description|task\s+brief|description|task)\s*:?\s*(?:\n+|$)/i,
      ''
    );
    // Ensure section markers start on their own line, so blob-pasted
    // descriptions like "...three sections: Section 1: ... Section 2: ..."
    // get visible structure.
    prepared = prepared.replace(SECTION_MARKER_RE, (m, pre, marker) => {
      const punct = m.slice((pre + marker).length);
      return '\n\n' + marker + punct;
    });
    // Collapse 3+ newlines to 2 (paragraph break).
    prepared = prepared.replace(/\n{3,}/g, '\n\n');

    const paragraphs = prepared.split(/\n{2,}/);
    let html = '<div class="task-desc">';
    paragraphs.forEach(block => {
      const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length === 0) return;

      // If consecutive lines all look like bullets, render as a list.
      const allBullets = lines.every(l => bulletMatch(l));
      if (allBullets) {
        html += '<ul class="task-desc-list">';
        lines.forEach(l => {
          const bm = bulletMatch(l);
          html += '<li>' + escapeFn(bm[1].trim()) + '</li>';
        });
        html += '</ul>';
        return;
      }

      // If first line is a section heading, render heading + (optional) body.
      const headMatch = sectionHeadingMatch(lines[0]);
      if (headMatch) {
        const marker = headMatch[1];
        const rest = headMatch[2] ? headMatch[2].trim() : '';
        // Try to extract a short subtitle (first sentence) — only if it's
        // genuinely short. Otherwise the source probably glued heading and
        // body together, so we just bold the marker inline and keep the
        // whole line as a paragraph.
        const subtitleSeparator = rest.match(/^(.+?)[.!?]\s+(.*)$/);
        const hasShortSubtitle = subtitleSeparator && subtitleSeparator[1].length <= 40;
        if (rest && hasShortSubtitle) {
          const subtitle = subtitleSeparator[1].trim();
          const body = (subtitleSeparator[2] || '').trim();
          html += '<h4 class="task-desc-h"><span class="task-desc-h-marker">' + escapeFn(marker) + ':</span> ' + escapeFn(subtitle) + '</h4>';
          const remainingLines = (body ? [body] : []).concat(lines.slice(1));
          if (remainingLines.length > 0) {
            html += renderParagraphBody(remainingLines, escapeFn);
          }
        } else if (rest) {
          // Marker glued to body — bold the marker, keep the rest as paragraph.
          html += '<p class="task-desc-p"><strong class="task-desc-h-marker">' + escapeFn(marker) + ':</strong> ' + escapeFn(rest) + '</p>';
          if (lines.length > 1) {
            html += renderParagraphBody(lines.slice(1), escapeFn);
          }
        } else {
          // Heading line with no inline body.
          html += '<h4 class="task-desc-h"><span class="task-desc-h-marker">' + escapeFn(marker) + ':</span></h4>';
          if (lines.length > 1) {
            html += renderParagraphBody(lines.slice(1), escapeFn);
          }
        }
        return;
      }

      html += renderParagraphBody(lines, escapeFn);
    });
    html += '</div>';
    return html;
  }

  // Renders a sequence of lines as a single <p>, joining soft-wrapped lines
  // and splitting any lines that match a bullet pattern into a sibling <ul>.
  function renderParagraphBody(lines, escapeFn) {
    let html = '';
    let buffer = [];
    let bullets = [];

    function flushBuffer() {
      if (buffer.length === 0) return;
      html += '<p class="task-desc-p">' + escapeFn(buffer.join(' ').trim()) + '</p>';
      buffer = [];
    }
    function flushBullets() {
      if (bullets.length === 0) return;
      html += '<ul class="task-desc-list">';
      bullets.forEach(b => { html += '<li>' + escapeFn(b) + '</li>'; });
      html += '</ul>';
      bullets = [];
    }

    lines.forEach(l => {
      const bm = bulletMatch(l);
      if (bm) {
        flushBuffer();
        bullets.push(bm[1].trim());
      } else {
        flushBullets();
        buffer.push(l);
      }
    });
    flushBuffer();
    flushBullets();
    return html;
  }

  window.renderTaskDescription = renderTaskDescription;
  window.renderTaskOutcomes = renderTaskOutcomes;
  window.normaliseOutcomesInput = normaliseOutcomesInput;
})();
