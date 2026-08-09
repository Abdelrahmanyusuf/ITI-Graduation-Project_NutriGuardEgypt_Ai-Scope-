export type LogLevel = "debug" | "info" | "warn" | "error";
export type SafeLogFields = Record<string, string | number | boolean | null | undefined>;
const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|api.?key|message|question|body|comment)/iu;
export interface StructuredLogger { log(level: LogLevel, event: string, fields?: SafeLogFields): void }
export function sanitizeLogFields(fields: SafeLogFields = {}): SafeLogFields {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => SENSITIVE_KEY.test(key)
    ? [key, "[REDACTED]"] : [key, typeof value === "string" && value.length > 200 ? `${value.slice(0, 197)}...` : value]));
}
export class JsonStructuredLogger implements StructuredLogger {
  public constructor(private readonly write: (line: string) => void = console.log) {}
  public log(level: LogLevel, event: string, fields: SafeLogFields = {}): void {
    this.write(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...sanitizeLogFields(fields) }));
  }
}
