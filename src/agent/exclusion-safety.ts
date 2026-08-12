export type SupportedAgentLanguage = "ar-EG" | "ar" | "en";

/** Shared wording for every data-only ingredient exclusion. */
export function exclusionSafetyNote(removedNames: readonly string[], language: SupportedAgentLanguage): string {
  const names = removedNames.join(language === "en" ? ", " : " و");
  return language === "en"
    ? `I excluded ${names} at your request. If this relates to a severe allergy, consult a qualified clinician or dietitian; NutriGuard cannot guarantee absence of cross-contamination.`
    : `تم استبعاد ${names} بناءً على طلبك. لو الاستبعاد مرتبط بحساسية شديدة، راجع طبيبًا أو أخصائي تغذية مؤهلًا؛ النظام لا يضمن خلو الطعام من التلوث التبادلي.`;
}
