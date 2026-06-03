/**
 * Attachments — shared client helper for task & submission file uploads.
 *
 * Nothing is done with the files; they are uploaded to a private Storage bucket
 * and shown as a downloadable list. Reuses the globals from /js/app.js:
 *   - `sb`        Supabase client (for the direct signed-URL upload)
 *   - `authFetch` authed fetch wrapper (for /api/attachment)
 *
 * Exposes window.Attachments:
 *   createAttachmentUploader({ scope, initial, onChange, max }) -> DOM node
 *       An "+ Attach file" control + an editable chip list. Calls onChange(arr)
 *       with the current metadata array whenever it changes.
 *   renderAttachmentList(container, { attachments, taskId|submissionId, heading })
 *       A read-only list; clicking a chip opens a short-lived signed URL.
 */
(function () {
  var MAX_SIZE = 10 * 1024 * 1024; // 10MB
  var MAX_FILES = 5;
  var ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf'];
  var ACCEPT = 'image/*,application/pdf';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(b) {
    b = b || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  // Inject a small stylesheet once so the widget looks consistent on every page
  // without each page needing its own attachment CSS.
  function injectStyles() {
    if (document.getElementById('attach-styles')) return;
    var css = ''
      + '.attach-list{display:flex;flex-direction:column;gap:6px;margin:6px 0}'
      + '.attach-chip{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #e2ded5;border-radius:8px;background:#fbf9f4;font-size:14px}'
      + '.attach-chip.view{cursor:pointer;width:100%;text-align:left;font:inherit;color:inherit}'
      + '.attach-chip.view:hover{border-color:#ed7615;background:#fff}'
      + '.attach-chip .attach-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.attach-chip .attach-size{color:#8a857a;font-size:12px}'
      + '.attach-remove{border:none;background:none;color:#8a857a;font-size:18px;line-height:1;cursor:pointer;padding:0 2px}'
      + '.attach-remove:hover{color:#c0392b}'
      + '.attach-add-btn{border:1px solid #d9d4c8;background:#fff;color:#2b2b2b;border-radius:8px;padding:7px 12px;font-size:14px;cursor:pointer}'
      + '.attach-add-btn:hover{border-color:#ed7615}'
      + '.attach-add-btn:disabled{opacity:.6;cursor:default}'
      + '.attach-hint{color:#8a857a;font-size:12px;margin-top:4px}'
      + '.attach-err{color:#c0392b;font-size:13px;margin-top:6px}'
      + '.attach-heading{margin:14px 0 4px;font-size:14px;font-weight:600}';
    var st = document.createElement('style');
    st.id = 'attach-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function createAttachmentUploader(opts) {
    opts = opts || {};
    injectStyles();
    var scope = opts.scope; // 'task' | 'submission'
    var items = (opts.initial || []).slice();
    var onChange = opts.onChange || function () {};
    var max = opts.max || MAX_FILES;

    var wrap = document.createElement('div');
    wrap.className = 'attach-uploader';
    var list = document.createElement('div');
    list.className = 'attach-list';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'attach-add-btn';
    btn.textContent = '+ Attach file';
    var err = document.createElement('div');
    err.className = 'attach-err';
    err.style.display = 'none';
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.multiple = true;
    input.style.display = 'none';

    function setErr(msg) {
      if (msg) { err.textContent = msg; err.style.display = ''; }
      else { err.textContent = ''; err.style.display = 'none'; }
    }

    function renderList() {
      list.innerHTML = '';
      items.forEach(function (meta, idx) {
        var row = document.createElement('div');
        row.className = 'attach-chip';
        var nm = document.createElement('span');
        nm.className = 'attach-name';
        nm.textContent = meta.name;
        var sz = document.createElement('span');
        sz.className = 'attach-size';
        sz.textContent = fmtSize(meta.size);
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'attach-remove';
        rm.setAttribute('aria-label', 'Remove ' + meta.name);
        rm.textContent = '×';
        rm.addEventListener('click', function () {
          items.splice(idx, 1);
          renderList();
          onChange(items.slice());
        });
        row.appendChild(nm);
        row.appendChild(sz);
        row.appendChild(rm);
        list.appendChild(row);
      });
    }

    function uploadOne(file) {
      return authFetch('/api/attachment', {
        method: 'POST',
        body: JSON.stringify({ scope: scope, filename: file.name, content_type: file.type, size: file.size }),
      })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Upload failed'); return j; }); })
        .then(function (j) {
          return sb.storage.from('attachments').uploadToSignedUrl(j.path, j.token, file, { contentType: file.type })
            .then(function (up) {
              if (up.error) throw up.error;
              items.push(j.meta);
              renderList();
              onChange(items.slice());
            });
        })
        .catch(function (e) { setErr('Could not upload "' + file.name + '": ' + (e.message || e)); });
    }

    function handleFiles(fileList) {
      setErr('');
      var files = Array.prototype.slice.call(fileList || []);
      btn.disabled = true;
      btn.textContent = 'Uploading…';
      var run = files.reduce(function (p, file) {
        return p.then(function () {
          if (items.length >= max) { setErr('You can attach up to ' + max + ' files.'); return; }
          if (ALLOWED.indexOf(file.type) < 0) { setErr('"' + file.name + '" is not an image or PDF.'); return; }
          if (file.size > MAX_SIZE) { setErr('"' + file.name + '" is too large.'); return; }
          return uploadOne(file);
        });
      }, Promise.resolve());
      run.then(function () { btn.disabled = false; btn.textContent = '+ Attach file'; });
    }

    btn.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { handleFiles(input.files); input.value = ''; });

    wrap.appendChild(list);
    wrap.appendChild(btn);
    wrap.appendChild(err);
    wrap.appendChild(input);
    renderList();
    return wrap;
  }

  function renderAttachmentList(container, opts) {
    if (!container) return;
    injectStyles();
    opts = opts || {};
    var atts = opts.attachments || [];
    if (!atts.length) { container.innerHTML = ''; return; }
    var q = opts.taskId
      ? 'task_id=' + encodeURIComponent(opts.taskId)
      : 'submission_id=' + encodeURIComponent(opts.submissionId);

    var html = '';
    if (opts.heading) html += '<h4 class="attach-heading">' + esc(opts.heading) + '</h4>';
    html += '<div class="attach-list view">';
    atts.forEach(function (a, i) {
      html += '<button type="button" class="attach-chip view" data-i="' + i + '">'
        + '<span class="attach-name">' + esc(a.name) + '</span>'
        + '<span class="attach-size">' + fmtSize(a.size) + '</span></button>';
    });
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.attach-chip.view').forEach(function (el) {
      el.addEventListener('click', function () {
        var a = atts[parseInt(el.getAttribute('data-i'), 10)];
        if (!a) return;
        el.disabled = true;
        authFetch('/api/attachment?path=' + encodeURIComponent(a.path) + '&' + q)
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j.url) window.open(j.url, '_blank', 'noopener'); else throw new Error(j.error || 'Could not open file'); })
          .catch(function (e) { alert('Could not open file: ' + (e.message || e)); })
          .then(function () { el.disabled = false; });
      });
    });
  }

  window.Attachments = { createAttachmentUploader: createAttachmentUploader, renderAttachmentList: renderAttachmentList };
})();
