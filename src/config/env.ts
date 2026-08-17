import { canonicalCorsOrigins } from "./cors.js";

export type NodeEnv = "development" | "test" | "production";

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
}

export type DeploymentTarget = "staging" | "production";
export interface ProductionConfig extends AppConfig {
  deploymentTarget: DeploymentTarget; host: string; releaseId: string; allowedOrigins: string[];
  databaseUrl: string; qdrantUrl: string; qdrantApiKey?: string; qdrantCollection: string;
  embeddingBaseUrl: string; embeddingApiKey: string; embeddingModel: string; retrievalCorpusId: string;
  releaseEvidencePath: string; pilotConsentReference: string | null; privacyNoticeVersion: string | null; metricsToken: string;
}

export type ValidateResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

const NODE_ENVS: readonly string[] = ["development", "test", "production"];

const DECIMAL_INTEGER = /^[0-9]+$/;

/**
 * Return true only when `portText` is exactly a whole, base-10 integer with no
 * sign, whitespace, decimals, or other characters (e.g. rejects `3000abc`,
 * `1.5`, empty/whitespace-only), and its value is within the valid range.
 */
function isValidPort(portText: string): boolean {
  if (!DECIMAL_INTEGER.test(portText)) return false;
  const port = Number(portText);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Validate runtime configuration from a set of environment variables.
 * Missing optional values are left undefined (never invented) and invalid
 * input is rejected loudly. No value here is treated as a secret in source.
 */
export function validateEnv(
  env: Record<string, string | undefined>
): ValidateResult<AppConfig> {
  const errors: string[] = [];

  const nodeEnv = env.NODE_ENV ?? "development";
  if (!NODE_ENVS.includes(nodeEnv)) {
    errors.push(
      `NODE_ENV must be one of 'development' | 'test' | 'production' (received '${nodeEnv}').`
    );
  }

  const portRaw = (env.PORT ?? "3000").trim();
  if (!isValidPort(portRaw)) {
    errors.push(
      `PORT must be a whole decimal integer between 1 and 65535 ` +
        `(received '${env.PORT ?? ""}').`
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      nodeEnv: nodeEnv as NodeEnv,
      port: Number(portRaw),
    },
  };
}

/** Load and validate configuration from the current process environment. */
export function loadConfig(): AppConfig {
  const result = validateEnv(process.env);
  if (!result.ok) {
    throw new Error(`Invalid environment configuration:\n- ${result.errors.join("\n- ")}`);
  }
  return result.value;
}

function required(env: Record<string, string | undefined>, name: string, errors: string[]): string {
  const value = env[name]?.trim() ?? "";
  if (!value) errors.push(`${name} is required.`);
  return value;
}

function validateUrl(value: string, name: string, target: DeploymentTarget, errors: string[]): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") errors.push(`${name} must be an HTTP(S) URL.`);
    if (target === "production" && url.protocol !== "https:") errors.push(`${name} must use HTTPS in production.`);
    if (target === "production" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) errors.push(`${name} must not use a loopback host in production.`);
  } catch { errors.push(`${name} must be a valid URL.`); }
}

/** Strict production configuration. Errors name fields but never echo secret values. */
export function validateProductionEnv(env: Record<string, string | undefined>): ValidateResult<ProductionConfig> {
  const base = validateEnv(env);
  const errors = base.ok ? [] : [...base.errors];
  const rawTarget = env.DEPLOYMENT_TARGET?.trim();
  if (rawTarget !== "staging" && rawTarget !== "production") errors.push("DEPLOYMENT_TARGET must be 'staging' or 'production'.");
  const target: DeploymentTarget = rawTarget === "staging" ? "staging" : "production";
  const databaseUrl = required(env, "DATABASE_URL", errors);
  const qdrantUrl = required(env, "QDRANT_URL", errors);
  const embeddingBaseUrl = required(env, "EMBEDDING_BASE_URL", errors);
  const embeddingApiKey = required(env, "EMBEDDING_API_KEY", errors);
  const metricsToken = required(env, "METRICS_TOKEN", errors);
  const releaseId = required(env, "RELEASE_ID", errors);
  const qdrantCollection = required(env, "QDRANT_COLLECTION", errors);
  const embeddingModel = required(env, "EMBEDDING_MODEL", errors);
  const retrievalCorpusId = required(env, "RETRIEVAL_CORPUS_ID", errors);
  const releaseEvidencePath = required(env, "NUTRIGUARD_RELEASE_EVIDENCE", errors);
  const originText = required(env, "ALLOWED_ORIGINS", errors);
  if (qdrantUrl) validateUrl(qdrantUrl, "QDRANT_URL", target, errors);
  if (embeddingBaseUrl) validateUrl(embeddingBaseUrl, "EMBEDDING_BASE_URL", target, errors);
  if (databaseUrl) { try { const url = new URL(databaseUrl); if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error(); } catch { errors.push("DATABASE_URL must be a PostgreSQL URL."); } }
  const configuredOrigins = originText.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const origin of configuredOrigins) validateUrl(origin, "ALLOWED_ORIGINS entry", target, errors);
  const allowedOrigins = canonicalCorsOrigins(configuredOrigins);
  if (metricsToken && metricsToken.length < 24) errors.push("METRICS_TOKEN must contain at least 24 characters.");
  if (embeddingApiKey && embeddingApiKey.length < 12) errors.push("EMBEDDING_API_KEY is too short.");
  if (errors.length || !base.ok) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, value: { ...base.value, nodeEnv: "production", deploymentTarget: target, host: env.HOST?.trim() || "0.0.0.0", releaseId,
    allowedOrigins, databaseUrl, qdrantUrl, qdrantApiKey: env.QDRANT_API_KEY?.trim() || undefined, qdrantCollection,
    embeddingBaseUrl, embeddingApiKey, embeddingModel, retrievalCorpusId, releaseEvidencePath,
    pilotConsentReference: env.PILOT_CONSENT_REFERENCE?.trim() || null, privacyNoticeVersion: env.PRIVACY_NOTICE_VERSION?.trim() || null, metricsToken } };
}

export function loadProductionConfig(env: Record<string, string | undefined> = process.env): ProductionConfig {
  const result = validateProductionEnv(env);
  if (!result.ok) throw new Error(`Invalid production configuration:\n- ${result.errors.join("\n- ")}`);
  return result.value;
}
