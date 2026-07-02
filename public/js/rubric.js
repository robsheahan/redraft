/**
 * Rubric parsing and rendering — converts teacher's pasted criteria text
 * into a structured band-based table when possible, or falls back to a
 * plain formatted text block.
 */

(function(global) {
  /**
   * Parse a criteria text blob into structured band rows.
   * Returns { bands: [{range, criteria[]}], headers: [] } or null if no band structure.
   */
  function parseRubric(text) {
    if (!text) return null;
    var cleaned = text.replace(/\r\n/g, '\n');

    // Normalise bullet points to • for consistency
    cleaned = cleaned.replace(/^\*\s/gm, '• ').replace(/\n\*\s/g, '\n• ');

    // First-pass: structured pipe-table parsing. Many teachers paste rubrics
    // as a 2-column markdown table with EITHER (band-range | descriptor) OR
    // (criterion text | marks). The naive pipe→newline approach loses this
    // structure. Detect a real pipe table and return it as criterion-list
    // format directly.
    var pipeRows = [];
    cleaned.split('\n').forEach(function(raw) {
      var line = raw.trim();
      if (!line.startsWith('|') || !line.endsWith('|')) return;
      var cells = line.split('|').slice(1, -1).map(function(c) { return c.trim(); });
      if (cells.length < 2) return;
      // Skip separator rows (only -, :, space, |)
      if (cells.every(function(c) { return /^[\s\-:]*$/.test(c); })) return;
      // Skip empty rows
      if (cells.every(function(c) { return !c; })) return;
      pipeRows.push(cells);
    });
    if (pipeRows.length >= 2) {
      // First row is the header if its cells look like header words
      var TABLE_HEADER_WORDS = /^(range|descriptor|description|band|bands?|criteria|criterion|marks?|grade|level|guidelines?)$/i;
      var firstLooksLikeHeader = pipeRows[0].every(function(c) {
        return TABLE_HEADER_WORDS.test(c) || c.length === 0;
      });
      var dataRows = firstLooksLikeHeader ? pipeRows.slice(1) : pipeRows;
      if (dataRows.length >= 2 && dataRows[0].length >= 2) {
        // Detect which column holds short numeric values ("6", "(13-15)", "13-15 marks")
        var col0Numeric = dataRows.every(function(r) { return /^\(?\s*\d{1,2}(\s*[–\-]\s*\d{1,2})?\s*\)?\s*(marks?)?$/i.test(r[0]); });
        var col1Numeric = dataRows.every(function(r) { return /^\(?\s*\d{1,2}(\s*[–\-]\s*\d{1,2})?\s*\)?\s*(marks?)?$/i.test(r[1]); });
        var marksCol = col1Numeric && !col0Numeric ? 1 : 0;
        var descCol = marksCol === 0 ? 1 : 0;
        var criteria = dataRows.map(function(row) {
          var marks = (row[marksCol] || '').replace(/\s+marks?$/i, '').replace(/-/g, '–').trim();
          var desc = row.slice(0).filter(function(_, i) { return i !== marksCol; }).join(' ').trim();
          return { name: desc, range: marks, details: [] };
        }).filter(function(c) { return c.name; });
        if (criteria.length >= 2) return { criteria: criteria, format: 'criterion' };
      }
    }

    // Strip common header noise up front so it doesn't end up as a criterion
    var headerStrips = [
      /marking\s*(rubric|criteria|guidelines?)\s*(\(\s*\d+\s*marks?\s*\))?/gi,
      /band\s*descriptors?/gi,
      /band\s*\/?\s*descriptor/gi,
      /range\s*\/?\s*descriptors?/gi,
      /range\s*\/?\s*criteria/gi,
      /criterion\s*\/?\s*(range|marks?)/gi,
      /\(\s*out\s+of\s+\d+\s*\)/gi,
    ];
    headerStrips.forEach(function(p) { cleaned = cleaned.replace(p, '\n'); });

    // Markdown pipe-table support. Many teachers paste rubrics in this shape:
    //   | Range | Descriptor |
    //   |---|---|
    //   | 13 to 15 | Sophisticated evaluation... |
    //   | 10 to 12 | Effective evaluation...     |
    // Normalise "X to Y" to "X–Y", drop separator rows, and replace pipes
    // with newlines so each cell ends up on its own line for the regular
    // parser below.
    cleaned = cleaned.replace(/(\d{1,2})\s+to\s+(\d{1,2})/gi, '$1–$2');
    // Normalise multi-hyphen ranges ("21--25", "21 -- 25") to en-dash —
    // some teacher rubrics come out of Word/markdown with double hyphens.
    cleaned = cleaned.replace(/(\d{1,2})\s*-{2,}\s*(\d{1,2})/g, '$1–$2');
    // Flattened-table rescue: when a rubric was pasted from a table that
    // lost its column breaks, the highest band's range can end up glued to
    // a leading "MarksCriteria" header — e.g. "MarksCriteria17–20Provides
    // a sustained...". Insert a newline whenever a mark-range is glued
    // directly to a letter on either side (no whitespace). Lines that
    // already have whitespace around the range are unaffected, so this is
    // safe to run unconditionally.
    cleaned = cleaned.replace(/([a-zA-Z\.\)])(\d{1,2}\s*[–\-]\s*\d{1,2})/g, '$1\n$2');
    cleaned = cleaned.replace(/(\d{1,2}\s*[–\-]\s*\d{1,2})([A-Z])/g, '$1\n$2');
    cleaned = cleaned.replace(/^[\s|:\-]+$/gm, '');
    cleaned = cleaned.replace(/\|/g, '\n');

    // Split by newlines first
    var lines = cleaned.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });

    // Drop pure markdown-table header cells ("Range", "Descriptor", etc.)
    // These are usually one-word lines after the pipe-split above.
    var TABLE_HEADERS = /^(range|descriptor|band|criteria|criterion|marks?|description|grade|level|guidelines?|standards?)$/i;
    lines = lines.filter(function(l) { return !TABLE_HEADERS.test(l); });

    // If we have fewer than 3 lines, try to split the blob by rubric-shaped patterns
    if (lines.length < 3) {
      var blob = lines.join(' ') || cleaned;

      // 1. Letter-band headers: "A (17–20)", "B (13-16)", "Band A (17-20)",
      //    "Grade A (21-25)", etc. Insert a newline before each occurrence
      //    so the header lands on its own line.
      blob = blob.replace(/\s*(?:(?:Band|Grade)\s+)?([A-G])\s*\(\s*(\d{1,2})\s*[–\-]\s*(\d{1,2})\s*\)\s*/g, '\n$1 ($2–$3) ');

      // 2. Mark-range headers followed by a bullet or capitalised word
      blob = blob.replace(/(\S)(\d{1,2}\s*[–\-]\s*\d{1,2})(\s*[•*\-])/g, '$1\n$2$3');
      blob = blob.replace(/(\S)(\d{1,2}\s*[–\-]\s*\d{1,2})(\s+[A-Z])/g, '$1\n$2$3');
      blob = blob.replace(/(\S)(\d{1,2}\s*[–\-]\s*\d{1,2}\s*marks?)/gi, '$1\n$2');

      // 2b. Flattened-table rescue: range glued to text on either side with
      // no whitespace ("...terms.16–20Effective..."). Split before the range
      // when it follows a letter/punctuation, and after the range when
      // followed by an uppercase letter. Keeps the range on its own line.
      blob = blob.replace(/([a-zA-Z\.\)])(\d{1,2}\s*[–\-]\s*\d{1,2})/g, '$1\n$2');
      blob = blob.replace(/(\d{1,2}\s*[–\-]\s*\d{1,2})([A-Z])/g, '$1\n$2');

      // 3. Bullet markers inline
      blob = blob.replace(/([^\n])(\s*•\s)/g, '$1\n$2');
      blob = blob.replace(/([^\n])(\s*\*\s)/g, '$1\n• ');

      // 4. "Criterion N:" / "Criteria N:" / "N." inline
      blob = blob.replace(/([^\n])\s*((?:Criteri[ao]\s+)\d+[\.\):]\s*)/gi, '$1\n$2');

      lines = blob.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
    }

    // Detect band-based rubric: lines that look like mark ranges,
    // optionally prefixed with a band letter ("A", "Band A", "Grade A").
    // Single-number bands ("A (4): Highly Developed") also supported for
    // small mark allocations. "marks" can appear either inside or outside
    // the parens.
    var markRangeRegex = /^(?:(?:Band|Grade)\s+)?([A-G])?\s*\(?\s*(\d{1,2})(?:\s*[–\-]\s*(\d{1,2}))?\s*(?:marks?)?\s*\)?\s*(?:marks?)?\s*$/i;
    // NESA-standard band labels — when one of these appears after the range
    // on the band header line, store it as a band label rather than mixing
    // it into the criterion bullets.
    var BAND_LABEL_RE = /^(outstanding|high|sound|basic|elementary|highly\s+developed|well\s+developed|developing|minimal|extensive|sophisticated|substantial|effective|thorough|comprehensive|adequate|clear|limited|simple|inadequate|excellent|good|fair|poor|exemplary|proficient|approaching|emerging|beginning|not\s+demonstrated)$/i;
    var bands = [];
    var currentBand = null;

    function pushBand(letter, low, high) {
      currentBand = {
        range: low + '–' + (high || low),
        criteria: [],
        letter: letter || null,
        label: null,
      };
      bands.push(currentBand);
      return currentBand;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Skip noise headers
      var isNoise = false;
      for (var j = 0; j < headerStrips.length; j++) {
        if (headerStrips[j].test(line)) {
          isNoise = true;
          break;
        }
      }
      // Reset regex state (global flag)
      headerStrips.forEach(function(p) { p.lastIndex = 0; });
      if (isNoise) continue;

      // Check if this line is a band marker
      var bandMatch = line.match(markRangeRegex);
      if (bandMatch) {
        pushBand(bandMatch[1], bandMatch[2], bandMatch[3]);
        continue;
      }

      // Also detect inline band headers like "13-15 marks Description..." or
      // "A (17–20): Highly Developed" or "Grade A (21–25 marks) Description..."
      // followed by content on the same line.
      var inlineBandMatch = line.match(/^(?:(?:Band|Grade)\s+)?([A-G])?\s*\(?\s*(\d{1,2})(?:\s*[–\-]\s*(\d{1,2}))?\s*(?:marks?)?\s*\)?\s*(?:marks?)?\s*[:\-]?\s*(.+)$/i);
      if (inlineBandMatch && !line.match(/^•/)) {
        pushBand(inlineBandMatch[1], inlineBandMatch[2], inlineBandMatch[3]);
        var rest = inlineBandMatch[4].trim().replace(/^[•*\-]\s*/, '');
        if (rest && BAND_LABEL_RE.test(rest)) {
          currentBand.label = rest;
        } else if (rest) {
          currentBand.criteria.push(rest);
        }
        continue;
      }

      // Otherwise, add to current band's criteria (strip leading bullet markers)
      if (currentBand) {
        var criterion = line.replace(/^[•*\-]\s*/, '').trim();
        if (criterion) currentBand.criteria.push(criterion);
      }
    }

    // Only return structured if we found at least 2 bands
    if (bands.length >= 2) {
      // Sort by upper bound descending so highest band is first
      bands.sort(function(a, b) {
        var aHigh = parseInt(a.range.split('–')[1]);
        var bHigh = parseInt(b.range.split('–')[1]);
        return bHigh - aHigh;
      });
      return { bands: bands, format: 'band' };
    }

    // Second try: criterion-list format — lines like
    //   "Criterion 1: Knowledge (3-5 marks)"
    //   "Criteria 1: Use of examples (3-5)"
    //   "1. Analysis 2-4 marks"
    // each followed by an optional bullet-pointed description.
    var criterionHeaderRegex = /^(?:criterion|criteria)?\s*\d+\s*[\.\):\-]\s*(.+)$/i;
    var criteria = [];
    var currentCriterion = null;
    for (var k = 0; k < lines.length; k++) {
      var line2 = lines[k];
      var isHeaderNoise = headerStrips.some(function(p) { var r = p.test(line2); p.lastIndex = 0; return r; });
      if (isHeaderNoise) continue;

      var mCrit = line2.match(criterionHeaderRegex);
      // Need the rest of the line to look like a criterion name (not a mark range line)
      if (mCrit && !markRangeRegex.test(line2)) {
        // Extract mark range if present within the criterion name
        var rest = mCrit[1];
        var rangeMatch = rest.match(/\(?\s*(\d{1,2}\s*[–\-]\s*\d{1,2})\s*\)?\s*marks?\s*\)?/i);
        var range = rangeMatch ? rangeMatch[1].replace(/-/g, '–') : '';
        var name = rest.replace(/\s*\(?\s*\d{1,2}\s*[–\-]\s*\d{1,2}\s*\)?\s*marks?\s*\)?/i, '').trim();
        currentCriterion = { name: name || rest.trim(), range: range, details: [] };
        criteria.push(currentCriterion);
        continue;
      }

      if (currentCriterion) {
        var detail = line2.replace(/^[•*\-]\s*/, '').trim();
        if (detail) currentCriterion.details.push(detail);
      }
    }

    if (criteria.length >= 2) return { criteria: criteria, format: 'criterion' };

    // Third try: multi-part rubric (HSC short-answer-style)
    //   Part (a) - 3 marks: Identifies relevant features...
    //   Part (b) - 5 marks: Considers both usefulness AND limitations...
    //   Part (c) - 12 marks:
    //   - 10 to 12: Sustained evaluation...
    //   - 7 to 9: Some evaluation...
    // Each "Part" becomes a criterion. Sub-bands underneath a part become
    // detail bullets within that part's row.
    var partHeaderRegex = /^part\s*\(?([a-z]|[ivxlcdm]+)\)?\s*[-–:]\s*(\d+)\s*marks?\s*[:\-]?\s*(.*)$/i;
    var subBandRegex = /^(\d{1,2})\s*(?:to|[–\-])\s*(\d{1,2})\s*[:\-]\s*(.+)$/i;
    var parts = [];
    var currentPart = null;
    for (var p = 0; p < lines.length; p++) {
      var pline = lines[p];
      var pIsHeaderNoise = headerStrips.some(function(pat) { var r = pat.test(pline); pat.lastIndex = 0; return r; });
      if (pIsHeaderNoise) continue;

      var pm = pline.match(partHeaderRegex);
      if (pm) {
        if (currentPart) parts.push(currentPart);
        currentPart = {
          letter: pm[1],
          marks: pm[2],
          description: pm[3] ? pm[3].trim() : '',
          subBands: [],
        };
        continue;
      }
      if (!currentPart) continue;

      // Strip leading bullet markers, then test as a sub-band line
      var stripped = pline.replace(/^[\-•*]\s*/, '').trim();
      var sm = stripped.match(subBandRegex);
      if (sm) {
        currentPart.subBands.push({
          range: sm[1] + '-' + sm[2],
          text: sm[3].trim(),
        });
        continue;
      }
      // Otherwise extend the part's description
      if (currentPart.description) {
        currentPart.description += ' ' + stripped;
      } else if (stripped) {
        currentPart.description = stripped;
      }
    }
    if (currentPart) parts.push(currentPart);

    if (parts.length >= 2) {
      var partCriteria = parts.map(function(part) {
        var details = [];
        if (part.description) details.push(part.description);
        part.subBands.forEach(function(b) {
          details.push(b.range + ': ' + b.text);
        });
        return {
          name: 'Part (' + part.letter + ')',
          range: part.marks,
          details: details,
        };
      });
      return { criteria: partCriteria, format: 'criterion' };
    }

    return null;
  }

  /**
   * Render rubric as HTML — either a structured table or a formatted text block.
   */
  // Normalise any range string to "X - Y" format (spaced hyphen).
  // Handles "17 to 20", "17-20", "17–20", "(17-20)", "17 marks", etc.
  function formatRange(s) {
    if (!s) return '';
    var str = String(s)
      .replace(/[()]/g, '')
      .replace(/(\d{1,2})\s*(?:to|[–\-])\s*(\d{1,2})/i, '$1 - $2')
      .replace(/\s+marks?$/i, '')
      .trim();
    // Collapse "5 - 5" → "5" for single-mark bands.
    var dup = str.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (dup && dup[1] === dup[2]) return dup[1];
    return str;
  }

  // Parse a range string like "3-5", "3–5", "(3-5)" into {min, max}.
  function parseRange(rangeStr) {
    if (!rangeStr) return null;
    var s = String(rangeStr).replace(/[–—]/g, '-');
    var m = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
    if (!m) {
      // Single-number "rank" like "5" — treat as min=max
      var n = s.match(/(\d+(?:\.\d+)?)/);
      if (n) { var v = parseFloat(n[1]); return { min: v, max: v }; }
      return null;
    }
    return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  }

  function rangeContains(rangeStr, mark) {
    var b = parseRange(rangeStr);
    if (!b || mark == null || isNaN(mark)) return false;
    return mark >= b.min && mark <= b.max;
  }

  function renderRubric(textOrStructured, escapeFn, structured, opts) {
    var e = escapeFn || function(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
    opts = opts || {};
    var mode = opts.mode || 'display';  // 'display' | 'mark-entry' | 'graded'
    var marks = opts.marks;

    // New signature: renderRubric(rawText, escapeFn, structuredRubric, opts).
    // If a server-parsed structured rubric is supplied, use it directly —
    // skip the regex parser entirely. Falls back to the regex parser when
    // no structured rubric is available (legacy tasks, parse failed).
    var parsed = (structured && (structured.format === 'band' || structured.format === 'criterion'))
      ? structured
      : null;
    var text = textOrStructured;
    if (!parsed) {
      if (!text) return '';
      parsed = parseRubric(text);
    }

    if (parsed && parsed.format === 'band') {
      var awardedBandMark = (marks && typeof marks.mark === 'number') ? marks.mark : null;
      var html = '<div class="rubric-table" data-rubric-format="band" data-rubric-mode="' + mode + '">';
      parsed.bands.forEach(function(band) {
        var isMarked = (mode === 'graded' && rangeContains(band.range, awardedBandMark));
        html += '<div class="rubric-row' + (isMarked ? ' rubric-row--marked' : '') + '" data-band-range="' + e(band.range) + '">';
        html += '<div class="rubric-band">';
        if (band.letter) html += '<div class="rubric-band-letter">' + e(band.letter) + '</div>';
        html += '<div class="rubric-band-range">' + e(formatRange(band.range)) + '</div>';
        if (band.label) html += '<div class="rubric-band-label">' + e(band.label) + '</div>';
        html += '</div>';
        html += '<div class="rubric-criteria">';
        if (band.criteria.length > 0) {
          html += '<ul>';
          band.criteria.forEach(function(c) { html += '<li>' + e(c) + '</li>'; });
          html += '</ul>';
        }
        html += '</div>';
        html += '</div>';
      });
      html += '</div>';
      if (mode === 'mark-entry') {
        html += '<div class="rubric-mark-entry-overall">';
        html += '<label>Overall mark <input type="number" class="rubric-mark-input rubric-mark-overall" data-mode="band" min="0" step="0.5"></label>';
        html += '</div>';
      } else if (mode === 'graded' && awardedBandMark != null) {
        html += '<div class="rubric-graded-summary">Awarded: <strong>' + e(String(awardedBandMark)) + '</strong></div>';
      }
      return html;
    }

    if (parsed && parsed.format === 'criterion') {
      var html2 = '<div class="rubric-table" data-rubric-format="criterion" data-rubric-mode="' + mode + '">';
      parsed.criteria.forEach(function(crit, i) {
        var bounds = parseRange(crit.range);
        var awardedMark = null;
        if (mode === 'graded' && Array.isArray(marks)) {
          var found = marks.find(function(m) { return m.name === crit.name; });
          if (found && typeof found.mark === 'number') awardedMark = found.mark;
        }
        var isMarked = awardedMark != null;
        html2 += '<div class="rubric-row' + (isMarked ? ' rubric-row--marked' : '') + '" data-criterion-index="' + i + '" data-criterion-name="' + e(crit.name) + '">';
        html2 += '<div class="rubric-band"><div class="rubric-band-range">' + (crit.range ? e(formatRange(crit.range)) : String(i + 1)) + '</div></div>';
        html2 += '<div class="rubric-criteria">';
        html2 += '<div style="font-weight:700;color:#1f2937;margin-bottom:' + (crit.details.length > 0 ? '6px' : '0') + '">' + e(crit.name) + '</div>';
        if (crit.details.length > 0) {
          html2 += '<ul>';
          crit.details.forEach(function(d) { html2 += '<li>' + e(d) + '</li>'; });
          html2 += '</ul>';
        }
        html2 += '</div>';
        if (mode === 'mark-entry') {
          var minAttr = bounds ? ' min="' + bounds.min + '"' : '';
          var maxAttr = bounds ? ' max="' + bounds.max + '"' : '';
          var maxLabel = bounds ? ('/' + bounds.max) : '';
          html2 += '<div class="rubric-input-cell"><input type="number" class="rubric-mark-input" data-mode="criterion" data-criterion-name="' + e(crit.name) + '" data-criterion-max="' + (bounds ? bounds.max : '') + '"' + minAttr + maxAttr + ' step="0.5"><span class="rubric-input-max">' + e(maxLabel) + '</span></div>';
        } else if (mode === 'graded' && awardedMark != null) {
          var maxStr = bounds ? ('/' + bounds.max) : '';
          html2 += '<div class="rubric-input-cell rubric-awarded"><strong>' + e(String(awardedMark)) + '</strong>' + e(maxStr) + '</div>';
        }
        html2 += '</div>';
      });
      html2 += '</div>';
      return html2;
    }

    // Fallback: formatted text block, converting * to •
    var normalised = text.replace(/^\*\s/gm, '• ').replace(/\n\*\s/g, '\n• ');
    return '<div class="criteria-block">' + e(normalised) + '</div>';
  }

  global.parseRubric = parseRubric;
  global.renderRubric = renderRubric;
  global.rubricParseRange = parseRange;
  global.rubricRangeContains = rangeContains;
})(typeof window !== 'undefined' ? window : this);
