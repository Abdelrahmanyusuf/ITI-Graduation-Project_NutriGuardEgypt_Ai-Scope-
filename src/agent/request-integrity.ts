export type RequestIntegrityFlag =
  | "prompt_injection"
  | "untrusted_numeric_override"
  | "unapproved_data_request";

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ar").replace(/\s+/gu, " ").trim();
}

const INJECTION_PATTERNS = [
  /ignore (?:all |the )?(?:previous|system|developer) instructions?/u,
  /reveal (?:the )?(?:system prompt|hidden instructions?)/u,
  /(?:تجاهل|انسى|الغ[يى]) (?:كل )?(?:التعليمات|القواعد)/u,
  /(?:اظهر|اكشف) (?:الـ ?)?(?:system prompt|تعليمات النظام)/u,
  /(?:نفذ|شغل).{0,16}(?:sql|كود|أوامر النظام)/u,
] as const;

const NUMERIC_OVERRIDE_PATTERNS = [
  /(?:^|[^\p{L}\p{N}])(?:اعتبر|افترض|خلي|اكتب)(?=[^\p{L}\p{N}]|$).{0,30}(?:الصوديوم|السعرات|الدهون|البروتين).{0,16}[0-9٠-٩]/u,
  /\b(?:pretend|assume|say|override)\b.{0,30}(?:sodium|calories|fat|protein).{0,16}\d/u,
] as const;

const UNAPPROVED_DATA_PATTERNS = [
  /(?:استخدم|هات|اعرض).{0,24}(?:pending|مرفوض|غير معتمد|لسه متراجعش)/u,
  /(?:use|show).{0,24}(?:pending|rejected|unverified|unapproved) (?:data|recipe|source)/u,
] as const;

export function classifyRequestIntegrity(message: string): RequestIntegrityFlag[] {
  const text = normalize(message);
  const flags: RequestIntegrityFlag[] = [];
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(text))) flags.push("prompt_injection");
  if (NUMERIC_OVERRIDE_PATTERNS.some((pattern) => pattern.test(text))) flags.push("untrusted_numeric_override");
  if (UNAPPROVED_DATA_PATTERNS.some((pattern) => pattern.test(text))) flags.push("unapproved_data_request");
  return flags;
}
