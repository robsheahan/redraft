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
      return { bands: bands };
    }

    return null;
  }

  /**
   * Render rubric as HTML — either a structured table or a formatted text block.
   */
  function renderRubric(text, escapeFn) {
    var e = escapeFn || function(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
    if (!text) return '';

    var parsed = parseRubric(text);
    if (parsed && parsed.bands.length >= 2) {
      var html = '<div class="rubric-table">';
      parsed.bands.forEach(function(band) {
        html += '<div class="rubric-row">';
        html += '<div class="rubric-band">' + e(band.range) + '</div>';
        html += '<div class="rubric-criteria">';
        if (band.criteria.length > 0) {
          html += '<ul>';
          band.criteria.forEach(function(c) {
            html += '<li>' + e(c) + '</li>';
          });
          html += '</ul>';
        }
        html += '</div>';
        html += '</div>';
      });
      html += '</div>';
      return html;
    }

    // Fallback: formatted text block, converting * to •
    var normalised = text.replace(/^\*\s/gm, '• ').replace(/\n\*\s/g, '\n• ');
    return '<div class="criteria-block">' + e(normalised) + '</div>';
  }

  global.parseRubric = parseRubric;
  global.renderRubric = renderRubric;
})(typeof window !== 'undefined' ? window : this);
