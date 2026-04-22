import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';

/**
 * Contact form endpoint — sends an email to help@proofready.app via Resend.
 *
 * Rate-limited to prevent abuse. Anonymous senders only count toward the
 * global daily limit; authenticated users also hit a per-user hourly cap.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TO_ADDRESS = 'help@proofready.app';
const FROM_ADDRESS = 'help@proofready.app';

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[contact] RESEND_API_KEY is not set');
    return res.status(500).json({ error: 'Contact form is not currently configured. Please email help@proofready.app directly.' });
  }

  const { name, email, subject, message } = req.body || {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid reply-to email address is required.' });
  }
  if (!message || typeof message !== 'string' || message.trim().length < 10) {
    return res.status(400).json({ error: 'Please write at least a short message (10 characters or more).' });
  }
  if (message.length > 5000) {
    return res.status(400).json({ error: 'Message is too long. Please keep it under 5,000 characters.' });
  }

  // Rate limit — fail-closed for signed-in users, global cap for anon.
  const user = await verifyAuth(req);
  const rate = await checkAndLogRateLimit(getSupabase(), user?.id || null, {
    endpoint: 'contact',
    perUserPerHour: 5,
    globalPerDay: 200,
  });
  if (!rate.ok) {
    if (rate.retryAfterSeconds) res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    return res.status(429).json({ error: rate.reason || 'Rate limit exceeded. Please try again later.' });
  }

  const cleanName = stripTags(String(name || '')).trim().slice(0, 100) || 'ProofReady user';
  const cleanSubject = stripTags(String(subject || '')).trim().slice(0, 200) || 'Contact form message';
  const cleanMessage = stripTags(String(message)).trim();
  const senderLabel = user?.email ? `${cleanName} <${user.email}> (signed-in)` : `${cleanName} <${email}> (not signed-in)`;

  const plainBody =
`From: ${senderLabel}
Reply-to: ${email}
Subject: ${cleanSubject}

${cleanMessage}

---
Sent from the ProofReady contact form.`;

  const htmlBody =
`<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;line-height:1.6">
  <p><strong>From:</strong> ${escapeHtml(senderLabel)}</p>
  <p><strong>Reply-to:</strong> ${escapeHtml(email)}</p>
  <p><strong>Subject:</strong> ${escapeHtml(cleanSubject)}</p>
  <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
  <p style="white-space:pre-wrap">${escapeHtml(cleanMessage)}</p>
  <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
  <p style="color:#888;font-size:12px">Sent from the ProofReady contact form.</p>
</div>`;

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `ProofReady Contact <${FROM_ADDRESS}>`,
        to: [TO_ADDRESS],
        reply_to: email,
        subject: `[Contact] ${cleanSubject}`,
        text: plainBody,
        html: htmlBody,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('[contact] Resend error:', response.status, errorBody);
      return res.status(502).json({ error: 'Could not send your message right now. Please try again in a minute.' });
    }
  } catch (e: any) {
    console.error('[contact] unexpected error:', e?.message || e);
    return res.status(500).json({ error: 'Could not send your message right now. Please try again in a minute.' });
  }

  return res.status(200).json({ ok: true });
}
