// Exam profiles — per-exam settings consumed by the universal learning engine.
// Loaded as a classic script before src/app.js. Exposes window.EXAM_PROFILES and
// window.getExamProfile(examCode). Section keys must match data/questions.json.

(function (global) {
  const EXAM_PROFILES = {
    'NARUTO': {
      label: 'Naruto Quiz',
      supportsCaseStudy: false,
      supportsMock: false,
      pacingSecondsPerQuestion: 30,
      passingScore: 700,
      sectionWeights: {
        easy:   0.34,
        medium: 0.33,
        hard:   0.33,
      },
      sectionLabels: {
        easy:   'Лёгкие',
        medium: 'Средние',
        hard:   'Эксперт',
      },
    },
  };

  const DEFAULT_PROFILE = {
    label: '',
    supportsCaseStudy: false,
    supportsMock: false,
    pacingSecondsPerQuestion: 30,
    passingScore: 700,
    sectionWeights: {},
    sectionLabels: {},
  };

  function getExamProfile(examCode) {
    return EXAM_PROFILES[examCode] || DEFAULT_PROFILE;
  }

  function getSectionWeight(examCode, sectionKey) {
    const w = getExamProfile(examCode).sectionWeights[sectionKey];
    return typeof w === 'number' ? w : 0;
  }

  global.EXAM_PROFILES = EXAM_PROFILES;
  global.getExamProfile = getExamProfile;
  global.getSectionWeight = getSectionWeight;
})(typeof window !== 'undefined' ? window : globalThis);
