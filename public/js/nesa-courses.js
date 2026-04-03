/**
 * NESA Board Developed Courses — client-side search
 * Used by new-task.html and student.html for course autocomplete
 */
var NESA_COURSES = [
  "English Advanced", "English Standard", "English Studies", "English EAL/D",
  "English Extension 1", "English Extension 2",
  "Mathematics Advanced", "Mathematics Standard 2", "Mathematics Standard 1",
  "Mathematics Extension 1", "Mathematics Extension 2",
  "Biology", "Chemistry", "Physics", "Earth and Environmental Science",
  "Investigating Science", "Science Extension",
  "Ancient History", "Modern History", "History Extension",
  "Geography", "Economics", "Business Studies", "Legal Studies",
  "Society and Culture", "Studies of Religion I", "Studies of Religion II",
  "Aboriginal Studies",
  "Visual Arts", "Music 1", "Music 2", "Music Extension", "Drama", "Dance",
  "Health and Movement Science", "Community and Family Studies",
  "Agriculture", "Design and Technology", "Engineering Studies",
  "Enterprise Computing", "Food Technology", "Industrial Technology",
  "Software Engineering", "Textiles and Design",
  "Arabic Continuers", "Chinese Beginners", "Chinese Continuers",
  "Chinese and Literature", "Chinese in Context",
  "French Beginners", "French Continuers", "French Extension",
  "German Beginners", "German Continuers", "German Extension",
  "Indonesian Beginners", "Indonesian Continuers",
  "Italian Beginners", "Italian Continuers", "Italian Extension",
  "Japanese Beginners", "Japanese Continuers", "Japanese Extension",
  "Korean Beginners", "Korean Continuers",
  "Latin Continuers", "Latin Extension",
  "Modern Greek Beginners", "Modern Greek Continuers",
  "Spanish Beginners", "Spanish Continuers", "Spanish Extension",
  "Business Services (VET)", "Construction (VET)", "Entertainment Industry (VET)",
  "Hospitality (VET)", "Information and Digital Technology (VET)",
  "Primary Industries (VET)", "Retail Services (VET)",
  "Tourism, Travel and Events (VET)"
];

function searchCourses(query) {
  if (!query || query.length < 2) return [];
  var q = query.toLowerCase();
  return NESA_COURSES.filter(function(c) {
    return c.toLowerCase().indexOf(q) !== -1;
  }).slice(0, 10);
}

/**
 * Wire up a course search input with dropdown suggestions.
 * @param {string} inputId - ID of the text input
 * @param {string} suggestionsId - ID of the suggestions dropdown div
 */
function initCourseSearch(inputId, suggestionsId) {
  var input = document.getElementById(inputId);
  var suggestions = document.getElementById(suggestionsId);
  if (!input || !suggestions) return;

  input.addEventListener('input', function() {
    var results = searchCourses(input.value);
    if (results.length === 0) {
      suggestions.style.display = 'none';
      return;
    }
    suggestions.innerHTML = results.map(function(c) {
      return '<div class="course-suggestion">' + c + '</div>';
    }).join('');
    suggestions.style.display = 'block';
  });

  suggestions.addEventListener('click', function(e) {
    if (e.target.classList.contains('course-suggestion')) {
      input.value = e.target.textContent;
      suggestions.style.display = 'none';
    }
  });

  document.addEventListener('click', function(e) {
    if (e.target !== input && !suggestions.contains(e.target)) {
      suggestions.style.display = 'none';
    }
  });

  input.addEventListener('focus', function() {
    if (input.value.length >= 2) {
      input.dispatchEvent(new Event('input'));
    }
  });
}
