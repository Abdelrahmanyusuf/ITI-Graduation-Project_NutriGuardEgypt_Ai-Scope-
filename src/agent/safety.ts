export type BlockingSafetyFlag =
  | "emergency"
  | "medical_advice_request"
  | "vulnerable_population_personalization"
  | "allergen_safety_guarantee";

export type SafetyFlag = BlockingSafetyFlag | "religious_compliance_guarantee";

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ar")
    .replace(/[إأآٱ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/[ًٌٍَُِّْـ]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

const EMERGENCY_PATTERNS = [
  /مش قادر (?:ا|أ)تنفس/u,
  /اختناق|نزيف شديد|اغماء|فاقد الوعي|الم شديد في الصدر|طوارئ|ابتلع.{0,16}(?:سم|مادة سامه)|تسمم/u,
  /can(?:not|'t) breathe|not breathing|stopped breathing|severe bleeding|unconscious|chest pain|emergency|choking|anaphylaxis|swallow(?:ed)?(?:.{0,20})poison|poisoning/u,
] as const;

const MEDICAL_PATTERNS = [
  /(?:عندي|مصاب|مريض).{0,24}(?:(?:ال)?سكري(?![\p{L}\p{N}])|مرض\s+السكر|سكر(?!يات)|ضغط|كلي|كبد|قلب|سرطان|مرض)/u,
  /(?:اعالج|علاج|اشخص|شخص(?:لي| لي)|تشخص|تشخيص|دواء|جرعه|جرعة|وصفه طبيه|وصفة طبية)/u,
  /(?:what should i eat|diet).{0,30}(?:diabetes|hypertension|kidney|disease|condition)/u,
  /\b(?:diagnose|treat me|medication dose|drug dose)\b/u,
  /\b(?:dose|dosage)\b.{0,30}\b(?:insulin|metformin|medication|medicine|drug)\b|\b(?:insulin|metformin|medication|medicine|drug)\b.{0,30}\b(?:dose|dosage)\b/u,
  /\b(?:prescribe|prescription)\b.{0,30}\b(?:diet|meal plan|medication|medicine|drug)\b/u,
  /\b(?:safe|suitable|what should i eat|what can i eat|diet|meal plan)\b.{0,35}\b(?:diabetes|hypertension|kidney|renal|liver|heart|cancer|disease|condition)\b/u,
  /\b(?:eat|consume|live on)\b.{0,18}\bonly\b.{0,12}\b\d{2,3}\s*(?:kcal|calories)\b|\b(?:starve|starvation|stop eating|not eat)\b/u,
] as const;

const VULNERABLE_PATTERNS = [
  /(?:انا|مراتي|زوجتي).{0,12}(?:حامل|بترضّع|بترضع|مرضع)/u,
  /(?:طفلي|ابني|بنتي|رضيع).{0,24}(?:ياكل|يأكل|اكل|غذا|رجيم|دايت)/u,
  /(?:pregnant|pregnancy|breastfeeding|my child|my baby).{0,30}(?:eat|diet|nutrition|sodium)?/u,
  /(?:exact|strict|weight[ -]?loss|low[ -]?calorie).{0,20}(?:diet|meal plan).{0,30}(?:child|kid|\d{1,2}[ -]?year[ -]?old)|(?:child|kid|\d{1,2}[ -]?year[ -]?old).{0,30}(?:diet|meal plan|weight[ -]?loss)/u,
] as const;

const ALLERGEN_GUARANTEE_PATTERNS = [
  /(?:مضمون|امن|آمن|100%).{0,18}(?:حساسيه|حساسية|جلوتين|فول سوداني)/u,
  /(?:حساسيه|حساسية).{0,18}(?:مضمون|امن|آمن|100%)/u,
  /guarantee.{0,20}(?:allergen|allergy|gluten)|(?:allergen|allergy).{0,20}(?:safe|guarantee|100%)/u,
] as const;

const RELIGIOUS_GUARANTEE_PATTERNS = [
  /(?:حلال|كوشير).{0,18}(?:مضمون|100%|متاكد|متأكد)/u,
  /(?:مضمون|100%|متاكد|متأكد).{0,18}(?:حلال|كوشير)/u,
  /guarantee.{0,20}(?:halal|kosher)|(?:halal|kosher).{0,20}(?:guarantee|100%)/u,
] as const;

export function classifySafetyFlags(message: string): SafetyFlag[] {
  const text = normalized(message);
  const flags: SafetyFlag[] = [];
  if (matchesAny(text, EMERGENCY_PATTERNS)) flags.push("emergency");
  if (matchesAny(text, MEDICAL_PATTERNS)) flags.push("medical_advice_request");
  if (matchesAny(text, VULNERABLE_PATTERNS)) flags.push("vulnerable_population_personalization");
  if (matchesAny(text, ALLERGEN_GUARANTEE_PATTERNS)) flags.push("allergen_safety_guarantee");
  if (matchesAny(text, RELIGIOUS_GUARANTEE_PATTERNS)) flags.push("religious_compliance_guarantee");
  return flags;
}
