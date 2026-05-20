import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { isGlobalAdmin } from '../lib/admin.js';

/**
 * CRUD for the schools table. Global-admin only — schools are the unit of
 * billing + leadership scoping for ProofReady. Adding a school here makes
 * email-domain matching kick in: any user whose email domain matches the
 * school's primary_domain or any secondary_domain is treated as a member
 * for synthesis purposes.
 *
 *   POST   /api/admin-schools  body: { name, primary_domain?, secondary_domains? }
 *   PUT    /api/admin-schools  body: { id, name?, primary_domain?, secondary_domains? }
 *   DELETE /api/admin-schools?id=X
 *
 * GET is omitted — admin-stats already returns the schools array. If you
 * need a focused list, hit /api/admin-stats and read `schools`.
 */

function normaliseDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase().replace(/^@+/, '');
  if (!trimmed) return null;
  // Reject obviously malformed values. Real validation happens by usage.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) return null;
  return trimmed;
}

function normaliseDomainList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const out = raw.map(normaliseDomain).filter((x): x is string => !!x);
    return [...new Set(out)];
  }
  if (typeof raw === 'string') {
    const out = raw.split(',').map(normaliseDomain).filter((x): x is string => !!x);
    return [...new Set(out)];
  }
  return [];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!['POST', 'PUT', 'DELETE'].includes(req.method || '')) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user || !isGlobalAdmin(user)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const supabase = getSupabase();

  if (req.method === 'POST') {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'School name is required.' });
    const primary = req.body?.primary_domain ? normaliseDomain(req.body.primary_domain) : null;
    const secondary = normaliseDomainList(req.body?.secondary_domains);
    if (req.body?.primary_domain && !primary) {
      return res.status(400).json({ error: 'Primary domain looks malformed (expected e.g. pcs.nsw.edu.au).' });
    }

    const { data, error } = await supabase
      .from('schools')
      .insert({ name, primary_domain: primary, secondary_domains: secondary })
      .select('id, name, primary_domain, secondary_domains')
      .single();
    if (error) {
      // Most common: unique violation on primary_domain.
      if (error.code === '23505') {
        return res.status(409).json({ error: 'That primary domain is already linked to another school.' });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ school: data });
  }

  if (req.method === 'PUT') {
    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'School id required.' });

    const patch: Record<string, unknown> = {};
    if (typeof req.body?.name === 'string') {
      const n = req.body.name.trim();
      if (!n) return res.status(400).json({ error: 'School name cannot be empty.' });
      patch.name = n;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'primary_domain')) {
      const v = req.body.primary_domain;
      if (v === null || v === '') {
        patch.primary_domain = null;
      } else {
        const d = normaliseDomain(v);
        if (!d) return res.status(400).json({ error: 'Primary domain looks malformed (expected e.g. pcs.nsw.edu.au).' });
        patch.primary_domain = d;
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'secondary_domains')) {
      patch.secondary_domains = normaliseDomainList(req.body.secondary_domains);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { data, error } = await supabase
      .from('schools')
      .update(patch)
      .eq('id', id)
      .select('id, name, primary_domain, secondary_domains')
      .single();
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'That primary domain is already linked to another school.' });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ school: data });
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'School id required.' });
    const { error } = await supabase.from('schools').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
