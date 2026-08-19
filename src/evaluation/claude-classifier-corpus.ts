/**
 * Part A4 — regression comparison corpus for the Claude classifier.
 *
 * Two sources, both real and both already part of this repository:
 *
 *   1. `tests/fixtures/evaluation/agent-eval.synthetic.json` — 60 cases that
 *      carry their own `expectedIntent` and `expectedStatus`, so correctness is
 *      decided by the fixture rather than by assumption.
 *   2. Two focused behaviour groups whose cases are lifted verbatim from the
 *      repository's existing passing regression tests. Every case records the
 *      test file and line it came from, because the external bug-log labels
 *      ("BUG-04", "BUG-06") do not map onto this repository's own numbering.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GraduationIntent } from "../runtime/graduation-demo-agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, "..", "..");

export interface FixtureCase {
  id: string;
  question: string;
  language: "ar-EG" | "ar" | "en";
  category: string;
  /** `primaryIntent` expected by the fixture. */
  expectedPrimaryIntent: string;
  expectedStatus: string;
  source: string;
}

export interface BehaviourCase {
  id: string;
  question: string;
  language: "ar-EG" | "ar" | "en";
  /** The 8-intent label the existing passing test proves is correct. */
  expectedGraduationIntent: GraduationIntent;
  /** Exact provenance of this case inside the repository. */
  source: string;
  note: string;
  /**
   * True when the existing test only reaches the expected label because the
   * message arrives with prior session context. Classified context-free in the
   * report, such a case can legitimately differ, and the report says so rather
   * than presenting it as a defect.
   */
  requiresSessionContext?: boolean;
}

export interface BehaviourGroup {
  key: string;
  title: string;
  description: string;
  cases: BehaviourCase[];
}

interface RawFixture {
  cases: Array<{
    id: string;
    question: string;
    language: string;
    category: string;
    expectedIntent: string;
    expectedStatus: string;
  }>;
}

const FIXTURE_RELATIVE_PATH = path.join("tests", "fixtures", "evaluation", "agent-eval.synthetic.json");

export async function loadFixtureCorpus(): Promise<FixtureCase[]> {
  const raw = JSON.parse(await readFile(path.join(PROJECT_ROOT, FIXTURE_RELATIVE_PATH), "utf8")) as RawFixture;
  return raw.cases.map((entry) => ({
    id: entry.id,
    question: entry.question,
    language: entry.language === "en" ? "en" : entry.language === "ar" ? "ar" : "ar-EG",
    category: entry.category,
    expectedPrimaryIntent: entry.expectedIntent,
    expectedStatus: entry.expectedStatus,
    source: `${FIXTURE_RELATIVE_PATH}#${entry.id}`,
  }));
}

/**
 * Behaviour group 1 — intent-classification consistency for yes/no-phrased
 * health questions versus guideline-recommendation phrasing.
 *
 * Both shapes must land on `general_guideline`: a "هل ... صحية؟" question about
 * a named dish is answered with numeric per-serving context, never an absolute
 * healthy/unhealthy verdict, and a WHO-recommendation question is answered from
 * sourced guidance.
 */
const HEALTH_PHRASING_GROUP: BehaviourGroup = {
  key: "health_question_phrasing_consistency",
  title: "Yes/no-phrased health questions vs guideline-recommendation phrasing",
  description:
    "Verifies that both interrogative shapes classify consistently as general_guideline. "
    + "Covered in this repository by the health-wording and shared-memory regression tests.",
  cases: [
    {
      id: "HEALTH-P1",
      question: "هل الفتة صحية للنظام الغذائي",
      language: "ar-EG",
      expectedGraduationIntent: "general_guideline",
      source: "tests/graduation-bug-log.test.ts:194",
      note: "existing passing test asserts primaryIntent general_guidance and a recipe_reference context",
    },
    {
      id: "HEALTH-P2",
      question: "يعني هي مش صحية؟",
      language: "ar-EG",
      expectedGraduationIntent: "general_guideline",
      source: "tests/graduation-bug-log.test.ts:198",
      note: "follow-up phrasing; existing test asserts status ok and general_guidance",
      requiresSessionContext: true,
    },
    {
      id: "HEALTH-P3",
      question: "طب هل هي في النظام الغذائي",
      language: "ar-EG",
      expectedGraduationIntent: "general_guideline",
      source: "tests/graduation-bug-log.test.ts:205",
      note: "third phrasing variant; existing test asserts status ok and general_guidance. Reaches that label only with the active-recipe context supplied by the previous turn.",
      requiresSessionContext: true,
    },
    {
      id: "HEALTH-P4",
      question: "ما توصيات منظمة الصحة العالمية عن الصوديوم؟",
      language: "ar-EG",
      expectedGraduationIntent: "general_guideline",
      source: "tests/graduation-agent-wide.test.ts:58",
      note: "guideline-recommendation phrasing; existing test asserts data.intent general_guideline",
    },
    {
      id: "HEALTH-P5",
      question: "إرشادات WHO عن السكر",
      language: "ar-EG",
      expectedGraduationIntent: "general_guideline",
      source: "tests/graduation-agent-wide.test.ts:60",
      note: "existing test asserts data.intent general_guideline",
    },
    {
      id: "HEALTH-P6",
      question: "ما توصيات منظمة الصحة عن الدهون؟",
      language: "ar-EG",
      expectedGraduationIntent: "general_guideline",
      source: "tests/graduation-agent-wide.test.ts:61",
      note: "existing test asserts data.intent general_guideline",
    },
    {
      id: "HEALTH-P7",
      question: "ما هي إرشادات منظمة الصحة العالمية للصوديوم؟",
      language: "ar-EG",
      expectedGraduationIntent: "general_guideline",
      source: "tests/graduation-bug-log.test.ts:155",
      note: "existing test asserts status ok, mentions 2000, and never invents a claim about ful",
    },
    {
      id: "HEALTH-P8",
      question: "كم ملح مسموح يوميا بشكل عام؟",
      language: "ar-EG",
      expectedGraduationIntent: "general_guideline",
      source: "tests/graduation-agent-wide.test.ts:59",
      note: "colloquial daily-limit phrasing; existing test asserts data.intent general_guideline",
    },
  ],
};

/**
 * Behaviour group 2 — colloquial letter elongation and related Arabic
 * normalization, e.g. "فووول" resolving to the recorded "فول مدمس".
 */
const ELONGATION_GROUP: BehaviourGroup = {
  key: "arabic_elongation_normalization",
  title: "Colloquial letter elongation and Arabic orthography normalization",
  description:
    "Verifies that elongated and variant Arabic spellings still resolve to the intended recorded dish "
    + "without corrupting meaningful prefixes such as \"للكشري\".",
  cases: [
    {
      id: "ELONG-P1",
      question: "عايز وصفة فووول",
      language: "ar-EG",
      expectedGraduationIntent: "find_recipe",
      source: "tests/graduation-bug-log.test.ts:162",
      note: "existing passing test asserts the response resolves to EGY-RCP-002",
    },
    {
      id: "ELONG-P2",
      question: "عايز وصفة فول",
      language: "ar-EG",
      expectedGraduationIntent: "find_recipe",
      source: "tests/graduation-agent-wide.test.ts:26",
      note: "non-elongated control; existing test asserts EGY-RCP-002",
    },
    {
      id: "ELONG-P3",
      question: "ازاي اعمل كشرى؟",
      language: "ar-EG",
      expectedGraduationIntent: "find_recipe",
      source: "tests/graduation-agent-wide.test.ts:23",
      note: "alef-maqsura variant; existing test asserts EGY-RCP-001",
    },
    {
      id: "ELONG-P4",
      question: "مكونات الكُشري",
      language: "ar-EG",
      expectedGraduationIntent: "find_recipe",
      source: "tests/graduation-agent-wide.test.ts:24",
      note: "diacritics variant; existing test asserts EGY-RCP-001",
    },
    {
      id: "ELONG-P5",
      question: "القيمة الغذائية الكاملة للكشري",
      language: "ar-EG",
      expectedGraduationIntent: "recipe_nutrition",
      source: "tests/graduation-agent-wide.test.ts:35",
      note: "prefix-preservation case: \"للكشري\" must not be corrupted by elongation collapsing",
    },
    {
      id: "ELONG-P6",
      question: "طريقة عمل الكشري المصري",
      language: "ar-EG",
      expectedGraduationIntent: "find_recipe",
      source: "tests/graduation-agent-wide.test.ts:22",
      note: "exact-name control; existing test asserts EGY-RCP-001",
    },
  ],
};

export const BEHAVIOUR_GROUPS: readonly BehaviourGroup[] = [HEALTH_PHRASING_GROUP, ELONGATION_GROUP];

/**
 * Deterministic projection from the 8 graduation intents onto the coarser
 * `primaryIntent` space used by the evaluation fixture.
 *
 * The projection is many-to-one and is only ever applied in this direction, so
 * a fixture expectation can grade a graduation-intent label without guessing.
 */
export function graduationIntentToPrimaryIntent(intent: GraduationIntent): string {
  switch (intent) {
    case "recipe_nutrition":
    case "ingredient_nutrition":
      return "recipe_nutrition";
    case "compare_recipes":
      return "compare_recipes";
    case "lighter_modification":
      return "lighter_recipe";
    case "find_recipe":
    case "general_guideline":
      return "general_guidance";
    case "medical_safety":
      return "medical_safety_request";
    case "unsupported":
      return "unsupported_request";
  }
}
