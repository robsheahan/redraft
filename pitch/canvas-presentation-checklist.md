# ProofReady Canvas presentation checklist

## Before the call

- Use a Canvas sandbox course with one teacher and one test student.
- Have the owning teacher launch ProofReady from course navigation once.
- Confirm the ProofReady class exists and the test student appears in its roster.
- Create and publish a small one-question ProofReady task in that class.
- Keep both the teacher account and Canvas Student View ready.

## End-to-end demonstration

1. In Canvas, create an assignment and select ProofReady as the external tool.
2. Pick the prepared ProofReady task and save/publish the Canvas assignment.
3. Launch the assignment as the teacher and confirm it opens the task detail page.
4. Launch it in Student View and submit a draft for feedback.
5. Confirm Canvas records submission/pending status, not an AI-generated numeric mark.
6. Submit the work for teacher marking in ProofReady.
7. Enter a teacher mark and confirm the numeric grade appears in Canvas.

## Expected fallback screens

- Student launches before teacher setup: “Your teacher hasn't set this up yet.”
- A second teacher launches a course already owned by a colleague: “This course is already linked to a colleague.”
- Existing ProofReady email: sign in and explicitly confirm the Canvas account link.

## Current pilot limitations

- The first teacher to launch a Canvas course owns its ProofReady class; co-teaching is not yet supported.
- Do not demonstrate clearing an already-posted Canvas grade until that behaviour has been verified in a real Canvas tenant.
- A genuine Canvas tenant is required to verify the final deep-link return and AGS gradebook behaviour; local tests cannot mint Canvas resource-link or line-item IDs.

## If something fails

Record the time, Canvas course, teacher/student role, and the visible message. Avoid refreshing repeatedly during the OIDC handshake because launch state is intentionally single-use.
