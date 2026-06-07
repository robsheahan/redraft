#!/usr/bin/env python3
"""Build standalone demo renders of ProofReady pages with prefilled PDHPE
sample data, for pitch screenshots. Reuses each page's real CSS + render code;
only the data-loading bootstrap is swapped for hardcoded sample data.

Outputs into public/_demo/ (served locally for screenshots, then deleted).
Nothing here is committed or deployed.
"""
import json, os, re, pathlib

ROOT = pathlib.Path(__file__).parent
PUB = ROOT / "public"
OUT = PUB / "_demo"
OUT.mkdir(exist_ok=True)

def read(p): return (PUB / p).read_text()

# ───────────────────────── ESSAY FEEDBACK ─────────────────────────
DRAFT = (
"Aboriginal and Torres Strait Islander peoples experience significantly poorer "
"health outcomes than non-Indigenous Australians, and these inequities are "
"produced by the determinants of health rather than by individual choices. "
"Sociocultural determinants such as the ongoing impact of colonisation, "
"dispossession and intergenerational trauma shape the conditions in which "
"people live, learn and work.\n\n"
"Aboriginal people have higher rates of chronic disease. This is because of "
"socioeconomic factors like lower median income, higher unemployment and "
"reduced access to education, which limit a person's ability to afford "
"nutritious food, stable housing and timely healthcare. Environmental "
"determinants compound this, as many communities are in remote areas with "
"limited access to health services and fresh food.\n\n"
"Initiatives such as Close the Gap aim to reduce these inequities by improving "
"access to culturally appropriate healthcare. Overall, the determinants of "
"health interact to create a cycle of disadvantage that explains why health "
"inequities persist for Aboriginal and Torres Strait Islander peoples."
)

essay_fb = {
  "what_youve_done_well": {
    "summary": [
      "You correctly identify all three groups of determinants — sociocultural, socioeconomic and environmental — and tie them to the priority population.",
      "Your opening makes the key analytical move: that inequity is produced by conditions, not individual choices.",
    ],
    "detail": [
      "The link between colonisation, dispossession and intergenerational trauma as sociocultural determinants is accurate and shows genuine engagement with the syllabus content.",
      "Framing health as shaped by 'the conditions in which people live, learn and work' echoes the social model of health — exactly the lens the question is asking for.",
    ],
  },
  "task_verb_check": {
    "summary": "'Analyse' asks you to draw out how the determinants interact to cause inequity. You do this well in the first and last paragraphs, but the middle paragraph slips into describing.",
    "detail": "When the sentence 'Aboriginal people have higher rates of chronic disease' stands alone, it states a fact rather than analysing a cause. Lead with the determinant and show the causal chain to the health outcome, so every claim is doing analytical work.",
  },
  "top_priority": {
    "summary": "Turn your strongest descriptive sentences into analysis by always making the cause-and-effect link explicit — name the determinant, then show how it produces the health outcome.",
    "detail": "Your second paragraph has the right ingredients (income, unemployment, education, access) but presents them as a list. Choose one, e.g. reduced access to education, and trace it through: lower health literacy, later presentation to services, poorer management of chronic conditions. That single sustained chain is worth more than naming four factors.",
  },
  "improvements": {
    "summary": [
      "Anchor at least one claim in specific data rather than 'higher rates'.",
      "Carry the analytical depth of your introduction into the body paragraphs.",
      "Evaluate Close the Gap against the principles of social justice, rather than just naming it.",
    ],
    "detail": [
      "Replace 'higher rates of chronic disease' with a specific, named comparison — for example a life-expectancy gap or a disease-specific rate — so the claim is convincing.",
      "Your middle paragraph lists socioeconomic factors; pick the one with the clearest causal chain and develop it fully rather than mentioning all four.",
      "When you reach Close the Gap, judge its effectiveness: does it address equity and supportive environments? Naming an initiative shows knowledge; evaluating it shows understanding.",
    ],
  },
  "criteria_feedback": [
    {
      "criterion": "Demonstrates knowledge and understanding of health determinants",
      "strengths": "Accurate, well-organised coverage of sociocultural, socioeconomic and environmental determinants, correctly applied to the priority population.",
      "improvements": "Deepen one determinant into a full causal chain rather than briefly naming several.",
    },
    {
      "criterion": "Analyses the relationship between determinants and health inequity",
      "strengths": "The introduction and conclusion make the determinants-produce-inequity argument clearly.",
      "improvements": "Sustain that analysis through the body — the middle paragraph currently describes rather than analyses.",
    },
    {
      "criterion": "Communicates using relevant PDHPE terminology",
      "strengths": "Confident, accurate use of 'determinants', 'health inequity' and 'social model of health'.",
      "improvements": "Bring in the principles of social justice (equity, diversity, supportive environments) when you evaluate initiatives.",
    },
  ],
}

# Annotations — quotes must appear verbatim & in document order, non-overlapping.
essay_annots = [
  ("produced by the determinants of health rather than by individual choices", "strength",
   "Strong analytical framing — this is exactly the 'analyse' move the question wants, right up front."),
  ("the ongoing impact of colonisation, dispossession and intergenerational trauma", "evidence",
   "Accurate sociocultural determinants. You could strengthen this by linking one of them directly to a specific health outcome."),
  ("Aboriginal people have higher rates of chronic disease.", "depth",
   "This sentence describes rather than analyses, and the claim is general. Lead with the determinant and name a specific rate or comparison."),
  ("limited access to health services and fresh food", "task_alignment",
   "Good environmental determinant — to fully 'analyse', add how this access gap translates into the health outcome."),
  ("Initiatives such as Close the Gap aim to reduce these inequities", "clarity",
   "You name the initiative but don't evaluate it. Judge its effectiveness against the principles of social justice."),
]

essay_meta = {
  "taskVerbs": ["analyse"], "taskVerb": "analyse",
  "question": "Analyse how the determinants of health contribute to the health inequities experienced by Aboriginal and Torres Strait Islander peoples.",
  "course": "PDHPE (Stage 6) · Core 1: Health Priorities in Australia",
  "title": "Health Priorities — Extended Response",
  "task_id": None, "draftVersion": 1, "maxDrafts": 3,
}

def build_essay(view):
    html = read("feedback.html")
    for s in [
        '  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>\n',
        '  <script src="/js/app.js"></script>\n',
        '  <script src="/js/rubric.js"></script>\n',
    ]:
        html = html.replace(s, "")
    a = "    const feedbackData = sessionStorage.getItem('proofready_feedback');"
    b = "    function renderFeedback(fb, meta, drafts, currentVersion, draftText) {"
    i, j = html.index(a), html.index(b)
    boot = f"""    const e = s => {{ const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }};
    const container = document.getElementById('content');
    var allDrafts = null, currentMeta = null, currentTask = {{}};
    var CATEGORY_LABELS = {{ strength:'Strength', clarity:'Clarity', evidence:'Evidence', depth:'Depth', structure:'Structure', task_alignment:'Task alignment', mechanics:'Mechanics' }};
    var activeView = {json.dumps(view)};
    var DRAFT = {json.dumps(DRAFT)};
    var FB = {json.dumps(essay_fb)};
    var ANN = {json.dumps(essay_annots)};
    FB.inline_suggestions = ANN.map(function(t){{ var st = DRAFT.indexOf(t[0]); return {{ quote: t[0], category: t[1], comment: t[2], start: st, end: st + t[0].length }}; }});
    var META = {json.dumps(essay_meta)};
    currentMeta = META;
    renderFeedback(FB, META, null, 1, DRAFT);

"""
    html = html[:i] + boot + html[j:]
    (OUT / f"essay-{view}.html").write_text(html)

build_essay("feedback")
build_essay("annotated")

# ───────────────────────── MATHS FEEDBACK ─────────────────────────
maths_lines = [
  {"math": r"\int_{1}^{2} (6x^2 - 2x)\,dx", "reason": "Set up the definite integral"},
  {"math": r"= \left[ 2x^3 - x^2 \right]_{1}^{2}", "reason": "Integrate"},
  {"math": r"= (2(2)^3 - (2)^2) - (2(1)^3 - (1)^2)", "reason": "Substitute the upper and lower limits"},
  {"math": r"= (16 - 4) - (2 - 1)", "reason": "Evaluate each bracket"},
  {"math": r"= 12 + 1 = 13", "reason": "Subtract"},
]
maths_fb = {
  "kind": "maths",
  "what_youve_done_well": [
    "You set the definite integral up correctly and integrated each term accurately using the power rule.",
    "Both limits were substituted in the right order — upper bracket minus lower bracket.",
  ],
  "top_priority": "Watch the sign on the very last line. The bracket structure was right; subtracting the lower-limit value gives 12 - 1 = 11, not 13. Re-run just that final subtraction carefully.",
  "improvements": [
    "On the final line, subtract the lower-limit result: (16 - 4) - (2 - 1) = 12 - 1 = 11.",
    "Name the rule you are using when you integrate, so your reasoning is visible to the marker.",
  ],
  "line_annotations": [
    {"line_index": 0, "math_status": "ok", "reason_status": "ok", "category": "ok", "comment": "Clear, correct setup."},
    {"line_index": 1, "math_status": "ok", "reason_status": "thin", "category": "justification_missing",
     "comment": "Your integration is correct, but 'Integrate' doesn't show your reasoning. Name the rule, e.g. 'increase each index by one and divide by the new index'."},
    {"line_index": 2, "math_status": "ok", "reason_status": "ok", "category": "ok", "comment": "Correct substitution of both limits."},
    {"line_index": 3, "math_status": "ok", "reason_status": "ok", "category": "ok", "comment": "Arithmetic inside each bracket is right: 12 and 1."},
    {"line_index": 4, "math_status": "error", "reason_status": "ok", "category": "algebra_sign",
     "comment": "Sign slip. You're subtracting the lower-limit value, so it should be 12 - 1 = 11, not 12 + 1. The minus in front of the second bracket flips the sign."},
  ],
  "step_gaps": [
    {"after_line_index": 3, "comment": "You've combined the final subtraction and the answer on one line. Isolating 12 - 1 first makes the sign easier to get right."},
  ],
}
maths_task = {
  "title": "Definite Integration — Practice",
  "course": "Mathematics Advanced (Stage 6)",
  "teacher_name": "Mr Sheahan",
  "question": r"Evaluate $\int_{1}^{2} (6x^2 - 2x)\,dx$.",
  "total_marks": None,
}
maths_meta = {"question": maths_task["question"], "course": maths_task["course"],
              "title": maths_task["title"], "task_id": None, "draftVersion": 1}

def build_maths():
    html = read("feedback-maths.html")
    for s in [
        '  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>\n',
        '  <script src="/js/app.js"></script>\n',
    ]:
        html = html.replace(s, "")
    a = "    (async () => {"
    b = "    })();"
    i = html.index(a)
    j = html.index(b) + len(b)
    boot = f"""    var SAMPLE_FB = {json.dumps(maths_fb)};
    var SAMPLE_LINES = {json.dumps(maths_lines)};
    var SAMPLE_TASK = {json.dumps(maths_task)};
    var SAMPLE_META = {json.dumps(maths_meta)};
    render(SAMPLE_FB, SAMPLE_LINES, SAMPLE_TASK, SAMPLE_META, null);"""
    # Re-render math on load (the per-line setTimeout(0) can run before the
    # deferred KaTeX CDN is ready on a cold load). Plain string — no f-string
    # brace escaping needed.
    boot += """
    window.addEventListener('load', function reTeX(){
      if (!window.katex) return setTimeout(reTeX, 30);
      document.querySelectorAll('.line-math').forEach(function(el){
        try { window.katex.render(el.getAttribute('data-math') || '', el, { throwOnError: false, displayMode: false }); } catch (e) {}
      });
    });"""
    html = html[:i] + boot + html[j:]
    (OUT / "maths.html").write_text(html)

build_maths()

# ───────────────────────── INSIGHTS (static, real CSS) ─────────────────────────
ins = read("insights.html")
STYLE = ins[ins.index("<style>"): ins.index("</style>") + len("</style>")]

NAV = '<nav class="nav"><a href="/" class="nav-brand"><img src="/proofreadybanner.png" alt="ProofReady"></a><div class="nav-right"><span>Mr Sheahan</span><button class="nav-logout">Log out</button></div></nav>'
FOOT = '<div class="site-footer"><a href="/contact.html">Contact</a><a href="/privacy.html">Privacy Policy</a><a href="/terms.html">Terms &amp; Conditions</a><a href="/compliance.html">Compliance</a></div>'

def pts(items):
    h = '<ul class="pts">'
    for it in items:
        h += '<li><div><div class="pt-head">' + it[0] + '</div><div class="pt-detail">' + it[1] + '</div></div></li>'
    h += '</ul>'
    return h

def llm_card(span, title, sub, meta, items):
    return (f'<div class="card card-span-{span}">'
            '<div class="synthesis-head"><div>'
            f'<h3 style="font-size:14.5px">{title}</h3>'
            f'<div class="meta" style="font-size:11.5px;color:#9ca3af;margin-top:2px">{sub}</div>'
            f'<div class="meta" style="margin-top:4px">{meta}</div>'
            '</div></div>'
            f'<div style="font-size:13.5px;color:#374151;line-height:1.55">{pts(items)}</div></div>')

def card_header(title, sub):
    return f'<div class="card-h"><h3>{title}</h3><span class="card-h-sub">{sub}</span></div>'

def band_list(counts, labels):
    total = sum(counts.values())
    h = '<div class="band-list">'
    for code in ["A","B","C","D","E"]:
        n = counts.get(code, 0); pct = (n/total*100) if total else 0
        h += (f'<div class="band-row band-{code}">'
              f'<div class="band-letter">{code}</div>'
              f'<div class="band-label">{labels[code]}</div>'
              f'<div class="band-track"><div class="band-fill" style="width:{max(pct,1.5 if n else 0):.1f}%"></div></div>'
              f'<div class="band-value">{n} <span style="color:#9ca3af;font-weight:500;font-size:11px">({pct:.0f}%)</span></div>'
              '</div>')
    h += '</div>'
    return h

BAND_LABELS = {"A":"Outstanding","B":"High","C":"Sound","D":"Basic","E":"Limited"}

action_bar = ('<div class="insights-action-bar">'
  '<button class="btn-generate-insights">Regenerate Insights</button>'
  '<span class="gen-status">Last generated 3 Jun 2026, 8:42 am</span></div>')

# ---- Cohort (teacher tier) ----
cohort_cards = '<div class="cards-grid">'
cohort_cards += ('<div class="card card-span-12">'
  + card_header("Mark distribution", "NESA Common Grade Scale")
  + band_list({"A":3,"B":7,"C":9,"D":4,"E":1}, BAND_LABELS) + '</div>')
cohort_cards += llm_card(6, "Top 3 mistakes", "Recurring improvement themes across the class",
  "24 submissions · updated 3 Jun · scope: PDHPE · Last 30 days", [
  ("Describing rather than analysing determinants", "Responses list the determinants of health but stop short of showing how they interact to produce inequity. The verb 'analyse' needs sustained cause-and-effect links, not identification."),
  ("Claims not anchored in specific data", "Many students write 'higher rates of chronic disease' without a named figure or group. Specific epidemiological data lifts a response from general to convincing."),
  ("Initiatives stated, not evaluated", "Students name programs such as Close the Gap but rarely judge their effectiveness against the principles of social justice."),
])
cohort_cards += llm_card(6, "Stretch goals", "Highest-impact next steps for the strongest students",
  "24 submissions · updated 3 Jun · scope: PDHPE · Last 30 days", [
  ("Sustain analysis across every determinant", "The strongest responses analyse one or two determinants deeply — push that same depth across sociocultural, socioeconomic and environmental factors."),
  ("Make the social-justice link explicit", "Name equity, diversity and supportive environments when evaluating initiatives rather than leaving the link implied."),
  ("Use comparative data over time", "Bring in trend data to evidence whether an inequity is widening or narrowing."),
])
cohort_cards += llm_card(12, "3 things done well", "Strengths showing up consistently across the class",
  "24 submissions · updated 3 Jun · scope: PDHPE · Last 30 days", [
  ("Confident use of PDHPE terminology", "Students across the class use 'health inequity', 'determinants' and 'social justice' accurately and in context."),
  ("Clear structure with sustained arguments", "Most responses follow a logical structure, with topic sentences that signal the determinant under discussion."),
  ("Respectful, informed engagement with priority populations", "Responses engage with Aboriginal and Torres Strait Islander health specifically and avoid generalisation."),
])
cohort_cards += '</div>'

cohort_header = ('<div class="page-header"><h1>Class Insights<span class="role-pill">CLASS VIEW</span></h1>'
  '<div class="school-name">Year 12 PDHPE · 24 students · Mr Sheahan</div></div>')

cohort = f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Class Insights — ProofReady</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
{STYLE}</head><body>{NAV}
<div class="container">{cohort_header}{action_bar}{cohort_cards}</div>{FOOT}</body></html>"""
(OUT / "insights-cohort.html").write_text(cohort)

# ---- Student longitudinal profile view ----
stu_header = ('<div class="page-header"><h1>Class Insights<span class="role-pill">CLASS VIEW</span></h1>'
  '<div class="school-name" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">Year 12 PDHPE'
  '<span class="student-mode-chip"><strong style="color:#111827">Mia Thompson</strong>'
  '<button class="student-mode-x">×</button></span></div></div>')

student_strip = ('<div class="student-header">'
  '<div class="who"><div class="name">Mia Thompson</div>'
  '<div class="sub">Year 12 · Year 12 PDHPE · mia.thompson@school.nsw.edu.au</div></div>'
  '<div class="stats">'
  '<div><div class="stat-label">Submissions</div><div class="stat-value">14</div></div>'
  '<div><div class="stat-label">With feedback</div><div class="stat-value">11</div></div>'
  '<div><div class="stat-label">Last active</div><div class="stat-value" style="font-size:14px;font-weight:600">2 Jun 2026</div></div>'
  '</div></div>')

profile_panel = ('<div class="student-profile-panel">'
  '<div class="ribbon">Longitudinal profile <span class="status-pill established">Established profile</span></div>'
  '<div class="narrative">Mia has submitted consistently across Core 1 and Core 2 this year, and her writing shows a clear upward trajectory in analytical depth. Early drafts tended to describe the determinants of health; her more recent responses link them causally and bring in specific data. Her strongest work integrates the principles of social justice without prompting. The next lift is sustaining that analytical depth across a full extended response rather than front-loading it in the opening paragraphs.</div>'
  '<div class="twocol">'
  '<div><div class="key">Most consistent strength</div><div class="val">Accurate, confident use of PDHPE terminology and health frameworks.</div></div>'
  '<div><div class="key">Most useful next step</div><div class="val">Sustaining cause-and-effect analysis through to the conclusion.</div></div>'
  '</div></div>')

hero = ('<div class="student-summary-hero">'
  '<div class="hero-label">Student summary</div>'
  '<div class="hero-paragraph">Mia is a capable and improving PDHPE student whose recent work consistently reaches genuine analysis. She handles the determinants of health and the priority populations with confidence and is beginning to evaluate health-promotion initiatives rather than simply describe them. With more sustained depth in her concluding paragraphs and a little more specific data, she is well placed to produce consistently high-band extended responses.</div>'
  '<div class="hero-tone">Ready to drop into a report comment or parent-meeting note.</div>'
  '<div class="hero-meta">'
  '<div><div class="label">Key strength</div><div class="value">Analytical use of health frameworks and terminology.</div></div>'
  '<div><div class="label">Top priority</div><div class="value">Carrying analytical depth through the whole response.</div></div>'
  '</div>'
  '<div style="margin-top:12px;font-size:11.5px;color:#9ca3af">updated 2 Jun, 9:14 am</div></div>')

# student mark distribution + by-task
stu_band = band_list({"A":4,"B":5,"C":2,"D":0,"E":0}, BAND_LABELS)
by_task = ('<div style="margin-top:12px;border-top:1px solid #f0e6d6;padding-top:10px">'
  '<div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:6px">By task</div>')
for t in [("Health Priorities — extended response","18","25","B"),
          ("Core 2: Factors Affecting Performance","21","25","A"),
          ("Health promotion — evaluation task","15","20","B"),
          ("First Aid scenario response","17","20","A")]:
    by_task += ('<div style="display:flex;justify-content:space-between;align-items:center;font-size:12.5px;padding:4px 0;border-bottom:1px solid #f5f0e8">'
      f'<div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#374151">{t[0]}</div>'
      f'<div style="font-weight:700;color:#111827;margin-left:10px">{t[1]}/{t[2]}</div>'
      f'<div style="font-size:11px;font-weight:700;padding:1px 7px;border-radius:100px;margin-left:8px;background:#fdf6ee;color:#ed7615">{t[3]}</div></div>')
by_task += '</div>'

stu_cards = '<div class="cards-grid">'
stu_cards += hero
stu_cards += ('<div class="card card-span-12">'
  + card_header("Mark distribution", "This student's graded submissions")
  + stu_band + by_task + '</div>')
stu_cards += llm_card(6, "Top 3 mistakes", "Recurring patterns across Mia's feedback",
  "11 submissions · updated 2 Jun, 9:14 am", [
  ("Conclusions lose analytical depth", "Mia's final paragraphs often revert to summary. Several responses would gain a band by sustaining cause-and-effect reasoning to the end."),
  ("Data referenced generally", "Claims like 'higher rates of chronic disease' recur without specific figures — naming the data point would strengthen them."),
  ("'Evaluate' treated as 'describe'", "When a question asks her to evaluate, she sometimes explains without making a judgement against criteria."),
])
stu_cards += llm_card(6, "Stretch goals", "Personalised next steps to lift this student's work",
  "11 submissions · updated 2 Jun, 9:14 am", [
  ("Plan a sustained analytical thread", "Before writing, note the cause-and-effect link she'll carry through every paragraph, including the conclusion."),
  ("Build a small data bank", "Memorise three or four specific statistics per priority area to anchor claims."),
  ("Practise judgement language", "Rehearse sentence stems that make an explicit evaluative judgement against the principles of social justice."),
])
stu_cards += llm_card(12, "3 things done well", "Strengths showing up consistently in this student's writing",
  "11 submissions · updated 2 Jun, 9:14 am", [
  ("Strong command of PDHPE frameworks", "Uses the determinants of health and social-justice principles accurately and in context."),
  ("Clear, well-structured argument", "Topic sentences reliably signal the focus of each paragraph."),
  ("Genuine, respectful engagement", "Writes about priority populations with care and specificity."),
])
stu_cards += '</div>'

student = f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Student Profile — ProofReady</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
{STYLE}</head><body>{NAV}
<div class="container">{stu_header}{student_strip}{profile_panel}{action_bar}{stu_cards}</div>{FOOT}</body></html>"""
(OUT / "insights-student.html").write_text(student)

print("Built:", ", ".join(sorted(p.name for p in OUT.glob("*.html"))))
