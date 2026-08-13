import { AsyncLocalStorage } from "node:async_hooks";

const backendAccessToken = new AsyncLocalStorage<string | null>();

/** Keep a user's Backend access token scoped to one inbound AI request. */
export function runWithBackendAccessToken<T>(token: string | null, operation: () => T): T {
  return backendAccessToken.run(token, operation);
}

/** Read the current request's token without persisting it on a singleton client. */
export function currentBackendAccessToken(): string | null {
  return backendAccessToken.getStore() ?? null;
}
