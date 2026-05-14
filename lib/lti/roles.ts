export type ProofReadyRole = 'teacher' | 'student';

const TEACHER_ROLE_URIS = new Set([
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper',
  'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#TeachingAssistant',
]);

export function roleFromLtiRoles(roles: string[] | undefined): ProofReadyRole {
  if (!roles || roles.length === 0) return 'student';
  for (const r of roles) {
    if (TEACHER_ROLE_URIS.has(r)) return 'teacher';
  }
  return 'student';
}
