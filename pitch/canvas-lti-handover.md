# ProofReady — Canvas LTI 1.3 integration handover

**For:** Canvas **root account admin** at the school (creating an LTI developer key requires root admin access — or sub-account admin if you're scoping ProofReady to a single sub-account)
**From:** ProofReady (Rob Sheahan, rob@proofready.app)
**Time required:** ~15 minutes, plus a short test launch with us afterwards

ProofReady is an AI formative-feedback tool for NSW HSC student drafts. We're integrating it with your Canvas instance via **LTI 1.3** (with NRPS for roster sync and AGS for optional grade passback).

We need you to register ProofReady as a developer key in your Canvas instance, then send a few values back to us. That's it — no servers to install, no firewall changes, no plugins.

---

## Step 0 — One question before you start

Are you on **Canvas Cloud** (Instructure-hosted, e.g. `yourschool.instructure.com`) or a **self-hosted Canvas** instance? This changes which OIDC/auth URLs we configure on our side, so please mention it in your reply.

---

## Step 1 — Register ProofReady as an LTI 1.3 developer key

In Canvas:

1. Go to **Admin → Developer Keys → + Developer Key → + LTI Key**.
2. Under **Method**, choose **Paste JSON**.
3. Paste the JSON block below (verbatim).
4. Save.
5. Set the new key's **State** to **ON**.

```json
{
  "title": "ProofReady",
  "description": "AI formative feedback on student drafts, aligned to the NESA syllabus.",
  "scopes": [
    "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
    "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
    "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly",
    "https://purl.imsglobal.org/spec/lti-ags/scope/score"
  ],
  "extensions": [
    {
      "platform": "canvas.instructure.com",
      "domain": "api.proofready.app",
      "tool_id": "proofready",
      "privacy_level": "public",
      "settings": {
        "text": "ProofReady",
        "icon_url": "https://proofready.app/proofready/favicon-96x96.png",
        "placements": [
          {
            "placement": "course_navigation",
            "message_type": "LtiResourceLinkRequest",
            "target_link_uri": "https://api.proofready.app/lti/launch",
            "text": "ProofReady",
            "default": "enabled"
          },
          {
            "placement": "assignment_selection",
            "message_type": "LtiDeepLinkingRequest",
            "target_link_uri": "https://api.proofready.app/lti/deep-link",
            "text": "Add a ProofReady task"
          },
          {
            "placement": "link_selection",
            "message_type": "LtiDeepLinkingRequest",
            "target_link_uri": "https://api.proofready.app/lti/deep-link",
            "text": "Insert ProofReady"
          }
        ]
      }
    }
  ],
  "public_jwk_url": "https://api.proofready.app/lti/jwks",
  "target_link_uri": "https://api.proofready.app/lti/launch",
  "oidc_initiation_url": "https://api.proofready.app/lti/login",
  "custom_fields": {
    "canvas_user_id": "$Canvas.user.id",
    "canvas_course_id": "$Canvas.course.id",
    "canvas_user_email": "$Person.email.primary"
  }
}
```

---

## Step 2 — Enable the key for the courses you want to use

1. Go to **Admin → Settings → Apps tab → View App Configurations → + App**.
2. Set **Configuration Type** to **By Client ID**.
3. Paste the **Client ID** Canvas just generated for ProofReady (it appears in the Developer Keys list, under the **Details** column — it's a long number like `170000000000123`).
4. Confirm / Submit.

If you want to scope ProofReady to a specific sub-account (e.g. just the HSC English faculty), do step 2 from inside that sub-account's settings instead of the root admin.

To find the **Deployment ID**: in the same Apps list, find the ProofReady row, click the **gear icon** on the right, then choose **Deployment Id**. Copy the value shown.

---

## Step 3 — Send these values back to Rob

Reply with:

| Field | Where to find it | Example |
|---|---|---|
| **Canvas hosting** | Cloud or self-hosted? (from Step 0) | `Canvas Cloud` |
| **Canvas hostname** | Your Canvas URL | `schoolname.instructure.com` |
| **Client ID** | Developer Keys → ProofReady row → Details column | `170000000000123` |
| **Deployment ID** | Admin → Settings → Apps → ProofReady row → ⚙ → Deployment Id | `42:abc123def456...` |

---

## Step 4 — Quick test launch

Once we have those values, we'll configure our side (usually within a business day) and send you back a short test link. We'll ask a teacher (or you) to launch ProofReady from inside a sandbox course so we can confirm:

- The course-navigation link appears and opens ProofReady
- The class roster comes through correctly
- (Optional) A test deep-link assignment can be created

After that, you're done — teachers can launch ProofReady from any enabled course.

---

## What ProofReady will and won't access

| Scope | What it does | Why we need it |
|---|---|---|
| `contextmembership.readonly` (NRPS) | Read the class roster (names + Canvas user IDs only) | So students don't have to enter a join code — they're auto-enrolled when their teacher launches a task |
| `lineitem` / `result.readonly` / `score` (AGS) | Create assignment line-items, write completion scores | Optional — lets a teacher push "draft completed" status back to Canvas SpeedGrader. We do **not** push AI-generated marks. |

We do **not** request access to:
- Submission content stored in Canvas
- Other courses or users outside the launched context
- Calendar, files, or messaging APIs

## A note on privacy level

The configuration above sets `"privacy_level": "public"`, which means each LTI launch sends the student's **name and email** to ProofReady (along with their Canvas user ID and course context). We need this so a student's drafts are correctly attributed to them and so their teacher can see whose work they're reviewing. We do **not** receive date of birth, address, or any other PII from Canvas. If your privacy officer requires `name_only` or `anonymous`, let us know — we can discuss the trade-offs (anonymous launches break the teacher's ability to see student names against drafts).

## Security & data handling

- **Data location:** Australian Supabase region (Sydney).
- **AI processing:** Anthropic (Claude). Anthropic's API policy excludes API inputs and outputs from model training.
- **Encryption:** TLS in transit, encrypted at rest in Supabase.
- **Data retention:** Drafts and feedback retained for the duration of the pilot, then exportable/deletable on request.
- **Privacy compliance:** Privacy Act 1988 / APPs aligned. Full pack at https://proofready.app/compliance.html.

## Questions

Email Rob directly: **rob@proofready.app**
