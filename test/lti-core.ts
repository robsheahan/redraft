import assert from 'node:assert/strict';
import { buildAgsScorePayload, buildScoresUrl } from '../lib/lti/ags.js';
import { buildDeepLinkContentItem } from '../lib/lti/deep-link-content.js';
import { roleFromLtiRoles } from '../lib/lti/roles.js';

const timestamp = '2026-07-17T00:00:00.000Z';

const draft = buildAgsScorePayload({ canvasUserId: 'student-1', timestamp });
assert.deepEqual(draft, {
  userId: 'student-1',
  activityProgress: 'Submitted',
  gradingProgress: 'Pending',
  timestamp,
});
assert.equal('scoreGiven' in draft, false, 'draft feedback must never send a numeric grade');
assert.equal('scoreMaximum' in draft, false, 'draft feedback must never send a score maximum');

const grade = buildAgsScorePayload({
  canvasUserId: 'student-1', scoreGiven: 15, scoreMaximum: 20, timestamp,
});
assert.equal(grade.scoreGiven, 15);
assert.equal(grade.scoreMaximum, 20);
assert.equal(grade.activityProgress, 'Completed');
assert.equal(grade.gradingProgress, 'FullyGraded');
assert.throws(
  () => buildAgsScorePayload({ canvasUserId: 'student-1', scoreGiven: 15 }),
  /without scoreMaximum/,
);

assert.equal(buildScoresUrl('https://canvas.test/lineitems/1'), 'https://canvas.test/lineitems/1/scores');
assert.equal(
  buildScoresUrl('https://moodle.test/lineitem?type_id=123'),
  'https://moodle.test/lineitem/scores?type_id=123',
);

const linked = buildDeepLinkContentItem({ id: 'task-1', title: 'Essay', total_marks: 20 }, true);
assert.deepEqual(linked.custom, { proofready_task_id: 'task-1' });
assert.deepEqual(linked.lineItem, { scoreMaximum: 20, label: 'Essay', resourceId: 'task-1' });
const ungraded = buildDeepLinkContentItem({ id: 'task-2', title: 'Practice', total_marks: null }, false);
assert.equal('lineItem' in ungraded, false);

assert.equal(roleFromLtiRoles([
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
]), 'teacher');
assert.equal(roleFromLtiRoles([
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
]), 'student');
assert.equal(roleFromLtiRoles(undefined), 'student');

console.log('LTI core checks passed.');
