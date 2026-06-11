# ProofReady — Q1 & Q2 design write-up (signup model + role/identity)

**Status:** ✅ **DECIDED + IMPLEMENTED** (2026-06-11, branch
`security/audit-batch-ab-2026-06-11`). Rob chose the recommended options:
Q2A "ship first", Q2B "B1", Q1 "harden now, verify later". This doc is kept as
the rationale of record. What shipped:
- **Q2A** — authoritative role → `app_metadata`; gates use `authoritativeRole()`;
  backfill script `scripts/backfill-role-to-app-metadata.ts` (run before deploy).
- **Q2B** — B1: identity keyed on `(platform, canvas_user_id)`, no email
  auto-linking, createUser race converges, email collisions → clean 409. The
  self-service "link my Canvas account" UX is now built (lti-link.html + api/lti/link.ts; consent + email-match required).
- **Q1** — phase 1: dropped the body role + global daily signup cap. Phase 2
  (email verification) deferred until self-signup opens beyond invited pilots.

Original proposal follows.

Grounded in the current code (2026-06-11): `api/signup.ts`, `api/set-role.ts`,
`lib/auth.ts`, `lib/lti/user-provision.ts`, `public/auth.html`,
`public/choose-role.html`, `public/student.html`.

---

## TL;DR — the decisions I need from you

1. **Q2A (role storage):** move the authoritative role from `user_metadata`
   (which the user can rewrite from their own browser) to `app_metadata`
   (service-role only). **Recommended: yes — this is a real privilege-escalation
   fix and should ship regardless of the other decisions.** Low user-facing
   impact. The only decision is timing.

2. **Q2B (LTI identity):** stop auto-linking a Canvas launch to a pre-existing
   account by **email**. Key identity strictly on `(platform, canvas_user_id)`;
   offer an explicit opt-in "link my Canvas account" flow for the rare user who
   also self-signed-up. **Decision: accept account-separation as the default, or
   keep email-linking but restrict it?** (Required before school #2.)

3. **Q1 (signup model):** pick one —
   - **(A)** Require email verification (no more instant pre-confirmed accounts), or
   - **(B)** Keep instant signup but rate-limit it, drop the body-supplied role,
     and add a bot check.
   **Recommended: a blend — (B) now (cheap, closes the abuse), move to (A) before
   you open self-signup beyond invited pilots.**

---

## Why these two are coupled, and why they gate school #2

Identity in ProofReady is currently **email-keyed and self-asserted**:

- A user's **role** lives in `user_metadata`, which the user's own browser can
  write (proven: `student.html:757` already calls
  `sb.auth.updateUser({ data: {...} })` for `disclosure_acknowledged`). The same
  call with `{ role: 'teacher' }` self-promotes a student. (Audit **H2**.)
- LTI provisioning **links a Canvas launch to any existing account with the same
  email** (`lib/lti/user-provision.ts:37-38`), and logs the user in by
  **magic-link to that email**. So a second platform that asserts a victim's
  email can attach to the victim's account. (Audit **L1**.)
- Anyone can mint a **pre-confirmed account with any role** at `api/signup.ts`,
  unauthenticated and unthrottled. (Audit **C1**.)

While there's one pilot school these are contained (one trusted Canvas, a small
known user set). The moment a **second** tenant exists, "email = identity" and
"role = self-asserted" become cross-tenant problems. That's why L1 in particular
is the audit's one item flagged *must fix before school #2*.

---

## Q2A — Authoritative role → `app_metadata` (fixes H2)

### How it works today
- `set-role.ts` writes `{ role }` into **`user_metadata`** via the admin API.
- Server-side gates read `user.user_metadata.role` — e.g.
  `attachment.ts:63` (teacher-only task upload),
  `generate-criteria.ts:19`, `generate-marking-guideline.ts:53`.
- Supabase's `user_metadata` (a.k.a. `raw_user_meta_data`) is **writable by the
  user** via `auth.updateUser({ data })` with their own session token.
  `app_metadata` (`raw_app_meta_data`) is **not** — only the service role / admin
  API can write it.

### The exploit
A logged-in student runs, in their browser console:
```js
await supabaseClient.auth.updateUser({ data: { role: 'teacher' } })
```
Their `user_metadata.role` is now `teacher`. Every server gate that reads
`user_metadata.role` now treats them as a teacher — they can upload task
materials, generate marking criteria, and generate marking guidelines. (Insights
admin/leader powers are separately gated by `school_members` grants + global
admin, so those are *not* exposed — but the teacher-only content surfaces are.)

### The change
1. **Write** role to `app_metadata` instead of `user_metadata`:
   `updateUserById(id, { app_metadata: { role } })` in `set-role.ts`, `signup.ts`,
   and `lib/lti/user-provision.ts`.
2. **Read** the authoritative role from `app_metadata.role` everywhere a gate
   makes a trust decision (the three endpoints above, plus any future gate). Add a
   tiny helper, e.g. `authoritativeRole(user)` in `lib/auth.ts`, so there's one
   place to read it.
3. **Backfill** existing users once: copy `user_metadata.role` →
   `app_metadata.role` for every account (admin API loop, or a SQL update on
   `auth.users.raw_app_meta_data`). Script lives in `scripts/`.
4. **Client UI** (`app.js`, `auth.html`, `choose-role.html`, `profile.html`,
   `teacher.html`, `index.html`) currently reads `user_metadata.role` for
   navigation. `app_metadata` **is** included in the JWT, so the client can read
   `user.app_metadata.role` — switch these reads over. UI gating isn't a security
   boundary (the server is), but keeping one source of truth avoids drift.

### Migration / rollout notes
- `app_metadata` lands in the JWT at **token issue/refresh**. Existing sessions
  won't carry it until their next refresh. Two safe options: (a) backfill, then
  let the ~1h access-token refresh roll it out; or (b) during a short transition,
  have the server gate accept `app_metadata.role ?? user_metadata.role` and read
  *only* `app_metadata` once the backfill + a refresh window have passed. I'd do
  the transition read for one release, then drop the `user_metadata` fallback.
- Leave **non-security** `user_metadata` fields where they are
  (`display_name`, `graduation_year`, `faculties`, `disclosure_acknowledged`) —
  the client legitimately writes some of these. Only **role** needs to move. (If
  you later decide `graduation_year` shouldn't be self-editable either — it
  drives stage calibration — that's a separate, smaller follow-up.)

### Risk / impact
- **User-facing impact: ~none.** Roles keep working; the difference is the user
  can no longer rewrite their own.
- **Main risk:** missing a read site, so a gate still trusts `user_metadata`.
  Mitigated by the single `authoritativeRole()` helper + grepping every `.role`
  gate. Low overall. **This one is safe to ship independently of Q1/Q2B.**

---

## Q2B — Namespace LTI identity by platform (fixes L1)

### How it works today (`lib/lti/user-provision.ts`)
On launch, in order:
1. Look up `lti_user_mappings` by **`(platform_id, canvas_user_id)`** — correctly
   tenant-scoped. If found, use that account. ✅
2. **If not found, call `lti_find_user_by_email(email)`** and link the Canvas
   user to *any* existing ProofReady account with that email — **regardless of
   which platform/tenant that account belongs to.**
3. Log the user in via **magic-link to that email** (`generateLoginUrl`).

### The threat
Step 2 trusts a **platform-asserted email** as a global identity key. A
second/compromised/misconfigured Canvas instance that launches a user whose
asserted email equals a victim's ProofReady email gets **linked into the
victim's account**, and step 3 issues a **session** for it. Cross-tenant account
takeover, gated only by "can this platform put an arbitrary string in the email
claim" — which, for a self-hosted or attacker-influenced LMS, it can.

It also causes benign-but-confusing collisions: a teacher who works at two
schools, or who self-signed-up and then launches via Canvas, silently shares one
account across contexts.

### Options
| Option | What it does | Cost |
|---|---|---|
| **B1 — No email linking (recommended)** | Identity is strictly `(platform, canvas_user_id)`. A launch never auto-attaches to a pre-existing email account; if no mapping exists, provision a fresh account for that platform identity. | A user who *also* self-signed-up (or is at two schools) gets a separate account per context unless they explicitly link. Needs a deliberate **opt-in link flow**. |
| **B2 — Same-tenant email linking only** | Only link by email if the existing account is already associated with the same platform/school. | A self-signup account has no platform, so it never matches → in practice this collapses to B1 for the case that matters, with more code. |
| **B3 — Verified-email linking** | Only link if the email is verified on both sides. | Still trusts the platform's asserted email; a compromised LMS can assert a verified-looking address. Doesn't actually close the cross-tenant hole. |

### Recommendation
**B1.** Make `(platform, canvas_user_id)` the only automatic identity key; remove
the email fallback link. For the genuinely-useful "I self-signed-up AND I launch
from Canvas" case, add an **explicit, user-initiated link**: while logged into
their existing ProofReady account, the user clicks "Link my Canvas account",
which stores the `(platform, canvas_user_id)` mapping against *their* account —
consent-based, not email-inferred. This is the "namespace identity by platform"
fix the audit calls for. (The already-applied LTI-9 fix — revoking public execute
on `lti_find_user_by_email` — closed the *enumeration* leak; B1 closes the
*linking/takeover* path that the same RPC enabled.)

### Migration notes
- Existing `lti_user_mappings` rows are already platform-scoped — no data change
  needed; this is a code-path change in `provisionUser` (drop the email branch,
  always create-or-use the platform mapping).
- The first-launch `createUser` race (audit **LTI-12**) should be fixed in the
  same edit — on a `23505` from `createUser`, re-read the mapping and converge,
  the way the mapping-insert already does.

---

## Q1 — Signup model (fixes C1)

### How it works today
- `public/auth.html` `signup()` POSTs `{ email, password, display_name }` (no
  role) to `api/signup.ts`, then signs in and sends the user to
  `choose-role.html` → `set-role`.
- `api/signup.ts` is **unauthenticated, unthrottled**, and calls
  `admin.createUser({ email_confirm: true, user_metadata: { role } })` — i.e. it
  **accepts a body-supplied role** and creates a **pre-confirmed** account (no
  email ownership check).

### The risks
- **Body role:** the official UI doesn't send one, but any caller can POST
  `role: 'teacher'`. (Q2A makes role authoritative-in-`app_metadata`, so this
  endpoint must stop writing role from the body regardless.)
- **No email verification:** accounts exist for emails the signer may not own.
  This compounds L1 (magic-link login is by email) and lets someone pre-create an
  account on a colleague's email.
- **Unthrottled mass creation:** a script can mint thousands of accounts; each is
  a foothold for later LLM-spend abuse and pollutes admin stats / school
  inference.

### Options
| Option | What it does | Trade-off |
|---|---|---|
| **A — Email verification** | Use Supabase's native signup (or `email_confirm: false`) so the account is unverified until the user clicks a confirmation link. | Adds an email round-trip to onboarding; needs the confirmation email wired (Resend is already in the stack). Strongest identity guarantee. |
| **B — Instant + harden** | Keep instant accounts but: rate-limit `signup` (per-IP + global/day via the existing `checkAndLogRateLimit`), **stop reading `role` from the body** (default everyone to `student`; role is only ever set by authenticated `set-role`/`app_metadata`), and add a bot check (Turnstile/hCaptcha) on the form. | Keeps onboarding frictionless; doesn't prove email ownership. |
| **C — Invite-only for staff** | Teachers/leaders are created by an admin or via LTI; public self-signup is student-only (and either A or B). | Best fit if pilots are school-driven; more admin overhead. |

### Recommendation
- **Now (cheap, do with Q2A):** apply **B**'s two server-side pieces — rate-limit
  the endpoint and **remove the body-supplied role** (it must not write role at
  all once role lives in `app_metadata`). This closes the "mint teacher accounts"
  and "mass-create" abuse immediately with no UX change.
- **Before opening self-signup beyond invited pilots:** move to **A** (email
  verification), since pre-confirmed accounts + email-keyed magic links are a
  weak base for a multi-tenant product. Pair with **C** if onboarding stays
  school-driven (which suits the LTI-first model — teachers arrive via Canvas, so
  public self-signup can be student-only or off entirely).

---

## Suggested sequencing

1. **Q2A (role → app_metadata)** + the **Q1-B server pieces** (rate-limit signup,
   drop body role) — one PR. These are pure hardening, low user-facing risk, and
   should land first. *Decision needed: timing only.*
2. **Q2B (LTI identity B1 + the LTI-12 race fix)** — the school-#2 gating item.
   *Decision needed: confirm B1 (account-separation default + opt-in link), or
   tell me you want email-linking kept under some constraint.*
3. **Q1-A (email verification)** — when you decide to open signup more widely.
   *Decision needed: do this now, or defer until past the invited-pilot phase?*

Tell me your calls on the three decisions in the TL;DR and I'll implement in that
order. None of this is built yet — this doc is the proposal.
