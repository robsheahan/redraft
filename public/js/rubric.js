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

    // Skip common header noise
    var headerPatterns = [
      /marking\s*(rubric|criteria|guidelines?)\s*(\(\s*\d+\s*marks?\s*\))?/gi,
      /range\s*criteria/gi,
      /criterion\s*(range|marks?)/gi,
    ];

    // Split by newlines first
    var lines = cleaned.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });

    // If we have fewer than 3 lines, try to split the blob by mark range patterns
    if (lines.length < 3) {
      var blob = lines.join(' ') || cleaned;
      // Insert line breaks before mark ranges followed by bullet markers or capitalised text
      // This catches patterns like "Criteria13–15*" or ")13-15 Examines"
      blob = blob.replace(/(\S)(\d{1,2}\s*[–\-]\s*\d{1,2})(\s*[•*\-])/g, '$1\n$2$3');
      blob = blob.replace(/(\S)(\d{1,2}\s*[–\-]\s*\d{1,2})(\s+[A-Z])/g, '$1\n$2$3');
      // Also handle mark ranges at the start of the remaining text
      blob = blob.replace(/(\S)(\d{1,2}\s*[–\-]\s*\d{1,2}\s*marks?)/gi, '$1\n$2');
      // Insert line breaks before bullet markers
      blob = blob.replace(/([^\n])(\s*•\s)/g, '$1\n$2');
      blob = blob.replace(/([^\n])(\s*\*\s)/g, '$1\n• ');
      lines = blob.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
    }

    // Detect band-based rubric: lines that look like mark ranges
    var markRangeRegex = /^\(?\s*(\d{1,2})\s*[–\-]\s*(\d{1,2})\s*\)?\s*(marks?)?\s*$/i;
    var bands = [];
    var currentBand = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Skip noise headers
      var isNoise = false;
      for (var j = 0; j < headerPatterns.length; j++) {
        if (headerPatterns[j].test(line)) {
          isNoise = true;
          break;
        }
      }
      // Reset regex state (global flag)
      headerPatterns.forEach(function(p) { p.lastIndex = 0; });
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

      // Also detect inline band headers like "13-15 marks" followed by content on same line
      var inlineBandMatch = line.match(/^\(?\s*(\d{1,2})\s*[–\-]\s*(\d{1,2})\s*\)?\s*(marks?)?\s*[:\-]?\s*(.+)$/i);
      if (inlineBandMatch && !line.match(/^•/)) {
        currentBand = {
          range: inlineBandMatch[1] + '–' + inlineBandMatch[2],
          criteria: [],
        };
        bands.push(currentBand);
        // If there's content after the band marker, add it as a criterion
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
      var isHeaderNoise = headerPatterns.some(function(p) { var r = p.test(line2); p.lastIndex = 0; return r; });
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
  function renderRubric(text, escapeFn) {
    var e = escapeFn || function(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
    if (!text) return '';

    var parsed = parseRubric(text);
    if (parsed && parsed.format === 'band') {
      var html = '<div class="rubric-table">';
      parsed.bands.forEach(function(band) {
        html += '<div class="rubric-row">';
        html += '<div class="rubric-band">' + e(band.range) + '</div>';
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
        html2 += '<div class="rubric-band">' + (crit.range ? e(crit.range) : (i + 1)) + '</div>';
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
