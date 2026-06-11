import { withHandler } from '../lib/with-handler.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';

export default withHandler(
  { methods: ['POST'], auth: 'none', label: 'signup' },
  async (req, res, { supabase }) => {
    const { email, password, display_name } = req.body;

    if (!email || !password || !display_name) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }

    // Spend/abuse cap. This endpoint is unauthenticated, so there's no per-user
    // identity to throttle — bound the TOTAL number of accounts created per day
    // (userId=null → pure global check). Stops scripted mass account creation.
    // (Per-IP throttling + a bot check are a follow-up — api_call_log.user_id is
    // a uuid column, so per-IP needs a separate store.)
    const rateLimit = await checkAndLogRateLimit(supabase, null, {
      endpoint: 'signup',
      perUserPerHour: 0, // unused when userId is null
      globalPerDay: 300,
    });
    if (!rateLimit.ok) {
      if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      return res.status(429).json({ error: 'Sign-ups are temporarily rate-limited. Please try again later.' });
    }

    // No role is set here. A new account is unroled; role is assigned only by
    // the authenticated /api/set-role flow (choose-role.html), which writes the
    // authoritative role to app_metadata. Accepting a body-supplied role here
    // would let anyone self-provision a teacher account.
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name },
    });

    if (error) {
      // createUser surfaces user-actionable validation (bad email, weak
      // password, already registered), so pass its message through with a 400.
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({ user: { id: data.user.id, email: data.user.email } });
  },
);
