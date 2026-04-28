/**
 * Contact modal — intercepts clicks on mailto:help@proofready.app links and
 * opens an in-page form instead of relying on the user's mail client.
 *
 * Include on any page and it will auto-inject both the modal HTML and its
 * click listener. Pre-fills the email field if the user is logged in (when
 * the /js/app.js `sb` client is present).
 */

(function() {
  var TO_ADDRESS = 'help@proofready.app';
  var mountPoint = null;

  // Local apiUrl helper — contact-modal is loaded on legal/marketing pages
  // that don't include app.js, so we can't rely on the global apiUrl().
  function localApiUrl(path) {
    var host = window.location.hostname;
    if (host === 'proofready.app' || host === 'www.proofready.app') return 'https://api.proofready.app' + path;
    return path;
  }

  function injectStyles() {
    if (document.getElementById('contact-modal-styles')) return;
    var style = document.createElement('style');
    style.id = 'contact-modal-styles';
    style.textContent = ''
      + '.cm-overlay { position: fixed; inset: 0; background: rgba(15,23,42,0.55); z-index: 10000; display: none; align-items: center; justify-content: center; padding: 20px; font-family: "Inter", -apple-system, sans-serif; }'
      + '.cm-overlay.visible { display: flex; }'
      + '.cm-card { background: #fff; border-radius: 14px; max-width: 480px; width: 100%; padding: 28px 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.25); max-height: 90vh; overflow-y: auto; }'
      + '.cm-card h2 { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; margin: 0 0 4px; color: #111827; }'
      + '.cm-card p.cm-sub { font-size: 14px; color: #6b7280; margin: 0 0 20px; }'
      + '.cm-field { margin-bottom: 14px; }'
      + '.cm-field label { display: block; font-size: 13px; font-weight: 600; color: #4b5563; margin-bottom: 5px; }'
      + '.cm-field input, .cm-field textarea { width: 100%; padding: 10px 14px; border: 1px solid #e8e0d4; border-radius: 8px; font-size: 14px; font-family: inherit; outline: none; background: #fff; color: #111827; }'
      + '.cm-field input:focus, .cm-field textarea:focus { border-color: #ed7615; box-shadow: 0 0 0 3px rgba(237,118,21,0.1); }'
      + '.cm-field textarea { min-height: 120px; resize: vertical; line-height: 1.6; }'
      + '.cm-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }'
      + '.cm-btn { padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; border: 1px solid transparent; }'
      + '.cm-btn-primary { background: #ed7615; color: #fff; box-shadow: 0 2px 6px rgba(237,118,21,0.3); }'
      + '.cm-btn-primary:hover { background: #d4690f; }'
      + '.cm-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }'
      + '.cm-btn-cancel { background: #fff; color: #374151; border-color: #e8e0d4; }'
      + '.cm-btn-cancel:hover { background: #f9fafb; }'
      + '.cm-message { font-size: 13px; padding: 10px 14px; border-radius: 8px; margin-bottom: 14px; display: none; }'
      + '.cm-message.visible { display: block; }'
      + '.cm-error { background: #fef2f2; border: 1px solid #fecaca; color: #dc2626; }'
      + '.cm-success { background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; }'
      + '.cm-fine { font-size: 12px; color: #9ca3af; text-align: center; margin-top: 12px; }';
    document.head.appendChild(style);
  }

  function injectMarkup() {
    if (document.getElementById('cm-overlay')) return;
    var overlay = document.createElement('div');
    overlay.className = 'cm-overlay';
    overlay.id = 'cm-overlay';
    overlay.innerHTML = ''
      + '<div class="cm-card" role="dialog" aria-labelledby="cm-title" aria-modal="true">'
      + '  <h2 id="cm-title">Send us a message</h2>'
      + '  <p class="cm-sub">We aim to reply within two business days.</p>'
      + '  <div class="cm-message cm-error" id="cm-error"></div>'
      + '  <div class="cm-message cm-success" id="cm-success"></div>'
      + '  <div id="cm-form">'
      + '    <div class="cm-field"><label>Your name</label><input type="text" id="cm-name" maxlength="100" autocomplete="name"></div>'
      + '    <div class="cm-field"><label>Reply-to email</label><input type="email" id="cm-email" maxlength="200" autocomplete="email" required></div>'
      + '    <div class="cm-field"><label>Subject</label><input type="text" id="cm-subject" maxlength="200" placeholder="e.g. Feedback, account issue, pilot enquiry"></div>'
      + '    <div class="cm-field"><label>Message</label><textarea id="cm-message-body" maxlength="5000" required></textarea></div>'
      + '    <div class="cm-actions">'
      + '      <button type="button" class="cm-btn cm-btn-cancel" onclick="window.closeContactModal()">Cancel</button>'
      + '      <button type="button" class="cm-btn cm-btn-primary" id="cm-send" onclick="window.submitContactModal()">Send message</button>'
      + '    </div>'
      + '    <p class="cm-fine">This goes to ' + TO_ADDRESS + '. We never share your message.</p>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(overlay);
    mountPoint = overlay;

    // Close on overlay click (outside the card)
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) window.closeContactModal();
    });
    // Close on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && overlay.classList.contains('visible')) window.closeContactModal();
    });
  }

  async function prefillFromSession() {
    try {
      if (typeof sb === 'undefined' || !sb) return;
      var r = await sb.auth.getSession();
      var user = r && r.data && r.data.session && r.data.session.user;
      if (!user) return;
      var emailInput = document.getElementById('cm-email');
      var nameInput = document.getElementById('cm-name');
      if (emailInput && !emailInput.value) emailInput.value = user.email || '';
      var displayName = user.user_metadata && user.user_metadata.display_name;
      if (nameInput && !nameInput.value && displayName) nameInput.value = displayName;
    } catch {
      // ignore — prefill is optional
    }
  }

  window.openContactModal = function(opts) {
    injectStyles();
    injectMarkup();
    var overlay = document.getElementById('cm-overlay');
    overlay.classList.add('visible');
    // Reset messages and the form UI
    document.getElementById('cm-error').classList.remove('visible');
    document.getElementById('cm-success').classList.remove('visible');
    document.getElementById('cm-form').style.display = 'block';
    var sendBtn = document.getElementById('cm-send');
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send message';
    prefillFromSession();
    if (opts && opts.subject) document.getElementById('cm-subject').value = opts.subject;
    setTimeout(function() {
      var el = document.getElementById(document.getElementById('cm-email').value ? 'cm-subject' : 'cm-email');
      if (el) el.focus();
    }, 50);
  };

  window.closeContactModal = function() {
    var overlay = document.getElementById('cm-overlay');
    if (overlay) overlay.classList.remove('visible');
  };

  window.submitContactModal = async function() {
    var email = (document.getElementById('cm-email').value || '').trim();
    var name = (document.getElementById('cm-name').value || '').trim();
    var subject = (document.getElementById('cm-subject').value || '').trim();
    var message = (document.getElementById('cm-message-body').value || '').trim();

    var errEl = document.getElementById('cm-error');
    var okEl = document.getElementById('cm-success');
    errEl.classList.remove('visible');
    okEl.classList.remove('visible');

    if (!email || !email.includes('@')) { errEl.textContent = 'Please enter a valid reply-to email address.'; errEl.classList.add('visible'); return; }
    if (!message || message.length < 10) { errEl.textContent = 'Please write at least a short message (10+ characters).'; errEl.classList.add('visible'); return; }

    var btn = document.getElementById('cm-send');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
      var res = await fetch(localApiUrl('/api/contact'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, email: email, subject: subject, message: message }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send your message.');
      document.getElementById('cm-form').style.display = 'none';
      okEl.textContent = 'Thanks — your message is on its way. We aim to reply within two business days.';
      okEl.classList.add('visible');
    } catch (err) {
      errEl.textContent = err.message || 'Could not send your message.';
      errEl.classList.add('visible');
      btn.disabled = false;
      btn.textContent = 'Send message';
    }
  };

  // Intercept clicks on any mailto:help@proofready.app link anywhere on the page
  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest && e.target.closest('a[href^="mailto:"]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.toLowerCase().indexOf('mailto:' + TO_ADDRESS.toLowerCase()) !== 0) return;
    e.preventDefault();
    // Parse subject from mailto if present
    var subjectMatch = href.match(/[?&]subject=([^&]*)/i);
    var subject = subjectMatch ? decodeURIComponent(subjectMatch[1].replace(/\+/g, ' ')) : '';
    window.openContactModal({ subject: subject });
  });
})();
