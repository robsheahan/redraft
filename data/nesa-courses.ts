/**
 * NESA Board Developed Courses — Stage 6 (Years 11-12)
 * Source: curriculum.nsw.edu.au
 *
 * Discipline categories align with NESA Key Learning Areas.
 */

export type DisciplineCategory =
  | "English"
  | "Mathematics"
  | "Science"
  | "HSIE"
  | "Creative Arts"
  | "PDHPE"
  | "TAS"
  | "Languages"
  | "VET";

export interface NesaCourse {
  name: string;
  discipline: DisciplineCategory;
}

export const NESA_COURSES: NesaCourse[] = [
  // ── English ──
  { name: "English Advanced", discipline: "English" },
  { name: "English Standard", discipline: "English" },
  { name: "English Studies", discipline: "English" },
  { name: "English EAL/D", discipline: "English" },
  { name: "English Extension 1", discipline: "English" },
  { name: "English Extension 2", discipline: "English" },

  // ── Mathematics ──
  { name: "Mathematics Advanced", discipline: "Mathematics" },
  { name: "Mathematics Standard 2", discipline: "Mathematics" },
  { name: "Mathematics Standard 1", discipline: "Mathematics" },
  { name: "Mathematics Extension 1", discipline: "Mathematics" },
  { name: "Mathematics Extension 2", discipline: "Mathematics" },

  // ── Science ──
  { name: "Biology", discipline: "Science" },
  { name: "Chemistry", discipline: "Science" },
  { name: "Physics", discipline: "Science" },
  { name: "Earth and Environmental Science", discipline: "Science" },
  { name: "Investigating Science", discipline: "Science" },
  { name: "Science Extension", discipline: "Science" },

  // ── HSIE ──
  { name: "Ancient History", discipline: "HSIE" },
  { name: "Modern History", discipline: "HSIE" },
  { name: "History Extension", discipline: "HSIE" },
  { name: "Geography", discipline: "HSIE" },
  { name: "Economics", discipline: "HSIE" },
  { name: "Business Studies", discipline: "HSIE" },
  { name: "Legal Studies", discipline: "HSIE" },
  { name: "Society and Culture", discipline: "HSIE" },
  { name: "Studies of Religion I", discipline: "HSIE" },
  { name: "Studies of Religion II", discipline: "HSIE" },
  { name: "Aboriginal Studies", discipline: "HSIE" },

  // ── Creative Arts ──
  { name: "Visual Arts", discipline: "Creative Arts" },
  { name: "Music 1", discipline: "Creative Arts" },
  { name: "Music 2", discipline: "Creative Arts" },
  { name: "Music Extension", discipline: "Creative Arts" },
  { name: "Drama", discipline: "Creative Arts" },
  { name: "Dance", discipline: "Creative Arts" },

  // ── PDHPE ──
  { name: "Health and Movement Science", discipline: "PDHPE" },
  { name: "Community and Family Studies", discipline: "PDHPE" },

  // ── TAS ──
  { name: "Agriculture", discipline: "TAS" },
  { name: "Design and Technology", discipline: "TAS" },
  { name: "Engineering Studies", discipline: "TAS" },
  { name: "Enterprise Computing", discipline: "TAS" },
  { name: "Food Technology", discipline: "TAS" },
  { name: "Industrial Technology", discipline: "TAS" },
  { name: "Software Engineering", discipline: "TAS" },
  { name: "Textiles and Design", discipline: "TAS" },

  // ── Languages ──
  { name: "Arabic Continuers", discipline: "Languages" },
  { name: "Chinese Beginners", discipline: "Languages" },
  { name: "Chinese Continuers", discipline: "Languages" },
  { name: "Chinese and Literature", discipline: "Languages" },
  { name: "Chinese in Context", discipline: "Languages" },
  { name: "French Beginners", discipline: "Languages" },
  { name: "French Continuers", discipline: "Languages" },
  { name: "French Extension", discipline: "Languages" },
  { name: "German Beginners", discipline: "Languages" },
  { name: "German Continuers", discipline: "Languages" },
  { name: "German Extension", discipline: "Languages" },
  { name: "Indonesian Beginners", discipline: "Languages" },
  { name: "Indonesian Continuers", discipline: "Languages" },
  { name: "Italian Beginners", discipline: "Languages" },
  { name: "Italian Continuers", discipline: "Languages" },
  { name: "Italian Extension", discipline: "Languages" },
  { name: "Japanese Beginners", discipline: "Languages" },
  { name: "Japanese Continuers", discipline: "Languages" },
  { name: "Japanese Extension", discipline: "Languages" },
  { name: "Korean Beginners", discipline: "Languages" },
  { name: "Korean Continuers", discipline: "Languages" },
  { name: "Latin Continuers", discipline: "Languages" },
  { name: "Latin Extension", discipline: "Languages" },
  { name: "Modern Greek Beginners", discipline: "Languages" },
  { name: "Modern Greek Continuers", discipline: "Languages" },
  { name: "Spanish Beginners", discipline: "Languages" },
  { name: "Spanish Continuers", discipline: "Languages" },
  { name: "Spanish Extension", discipline: "Languages" },

  // ── VET ──
  { name: "Business Services (VET)", discipline: "VET" },
  { name: "Construction (VET)", discipline: "VET" },
  { name: "Entertainment Industry (VET)", discipline: "VET" },
  { name: "Hospitality (VET)", discipline: "VET" },
  { name: "Information and Digital Technology (VET)", discipline: "VET" },
  { name: "Primary Industries (VET)", discipline: "VET" },
  { name: "Retail Services (VET)", discipline: "VET" },
  { name: "Tourism, Travel and Events (VET)", discipline: "VET" },
];

/**
 * Look up the discipline category for a course name.
 * Handles case-insensitive matching and common prefixes like "HSC", "Preliminary".
 */
export function getDisciplineForCourse(courseName: string): DisciplineCategory | null {
  const normalised = courseName
    .toLowerCase()
    .replace(/^(hsc|preliminary|year\s*1[12])\s+/i, "")
    .trim();

  for (const course of NESA_COURSES) {
    if (course.name.toLowerCase() === normalised) {
      return course.discipline;
    }
  }

  // Partial match fallback
  for (const course of NESA_COURSES) {
    if (normalised.includes(course.name.toLowerCase()) || course.name.toLowerCase().includes(normalised)) {
      return course.discipline;
    }
  }

  return null;
}
