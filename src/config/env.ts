export type NodeEnv = "development" | "test" | "production";

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
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