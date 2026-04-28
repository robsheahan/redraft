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
      /range\s*\/?\s*criteria/gi,
      /criterion\s*\/?\s*(range|marks?)/gi,
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

      // 1. Letter-band headers: "A (17–20)", "B (13-16)", "Band A (17-20)", etc.
      //    Insert a newline before each occurrence so the header lands on its own line.
      blob = blob.replace(/\s*(?:Band\s+)?([A-F])\s*\(\s*(\d{1,2})\s*[–\-]\s*(\d{1,2})\s*\)\s*/g, '\n$1 ($2–$3) ');

      // 2. Mark-range headers followed by a bullet or capitalised word
      blob = blob.replace(/(\S)(\d{1,2}\s*[–\-]\s*\d{1,2})(\s*[•*\-])/g, '$1\n$2$3');
      blob = blob.replace(/(\S)(\d{1,2}\s*[–\-]\s*\d{1,2})(\s+[A-Z])/g, '$1\n$2$3');
      blob = blob.replace(/(\S)(\d{1,2}\s*[–\-]\s*\d{1,2}\s*marks?)/gi, '$1\n$2');

      // 3. Bullet markers inline
      blob = blob.replace(/([^\n])(\s*•\s)/g, '$1\n$2');
      blob = blob.replace(/([^\n])(\s*\*\s)/g, '$1\n• ');

      // 4. "Criterion N:" / "Criteria N:" / "N." inline
      blob = blob.replace(/([^\n])\s*((?:Criteri[ao]\s+)\d+[\.\):]\s*)/gi, '$1\n$2');

      lines = blob.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
    }

    // Detect band-based rubric: lines that look like mark ranges,
    // optionally prefixed with a band letter ("A", "Band A") or label.
    var markRangeRegex = /^(?:Band\s+)?(?:[A-F]\s*)?\(?\s*(\d{1,2})\s*[–\-]\s*(\d{1,2})\s*\)?\s*(marks?)?\s*$/i;
    var bands = [];
    var currentBand = null;

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
        currentBand = {
          range: bandMatch[1] + '–' + bandMatch[2],
          criteria: [],
        };
        bands.push(currentBand);
        continue;
      }

      // Also detect inline band headers like "13-15 marks Description..." or
      // "A (17–20) Description..." followed by content on the same line.
      var inlineBandMatch = line.match(/^(?:Band\s+)?(?:[A-F]\s*)?\(?\s*(\d{1,2})\s*[–\-]\s*(\d{1,2})\s*\)?\s*(marks?)?\s*[:\-]?\s*(.+)$/i);
      if (inlineBandMatch && !line.match(/^•/)) {
        currentBand = {
          range: inlineBandMatch[1] + '–' + inlineBandMatch[2],
          criteria: [],
        };
        bands.push(currentBand);
        var rest = inlineBandMatch[4].trim().replace(/^[•*\-]\s*/, '');
        if (rest) currentBand.criteria.push(rest);
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

    return null;
  }

  /**
   * Render rubric as HTML — either a structured table or a formatted text block.
   */
  // Normalise any range string to "X - Y" format (spaced hyphen).
  // Handles "17 to 20", "17-20", "17–20", "(17-20)", "17 marks", etc.
  function formatRange(s) {
    if (!s) return '';
    return String(s)
      .replace(/[()]/g, '')
      .replace(/(\d{1,2})\s*(?:to|[–\-])\s*(\d{1,2})/i, '$1 - $2')
      .replace(/\s+marks?$/i, '')
      .trim();
  }

  function renderRubric(text, escapeFn) {
    var e = escapeFn || function(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
    if (!text) return '';

    var parsed = parseRubric(text);
    if (parsed && parsed.format === 'band') {
      var html = '<div class="rubric-table">';
      parsed.bands.forEach(function(band) {
        html += '<div class="rubric-row">';
        html += '<div class="rubric-band">' + e(formatRange(band.range)) + '</div>';
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
      return html;
    }

    if (parsed && parsed.format === 'criterion') {
      var html2 = '<div class="rubric-table">';
      parsed.criteria.forEach(function(crit, i) {
        html2 += '<div class="rubric-row">';
        html2 += '<div class="rubric-band">' + (crit.range ? e(formatRange(crit.range)) : (i + 1)) + '</div>';
        html2 += '<div class="rubric-criteria">';
        html2 += '<div style="font-weight:700;color:#1f2937;margin-bottom:' + (crit.details.length > 0 ? '6px' : '0') + '">' + e(crit.name) + '</div>';
        if (crit.details.length > 0) {
          html2 += '<ul>';
          crit.details.forEach(function(d) { html2 += '<li>' + e(d) + '</li>'; });
          html2 += '</ul>';
        }
        html2 += '</div>';
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
})(typeof window !== 'undefined' ? window : this);
