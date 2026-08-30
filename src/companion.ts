import { parseRepositoryGraph, type RepositoryGraph } from "./model.ts";

export const DEFAULT_COMPANION_PORT = 7420;
export const COMPANION_PROTOCOL = 1;

export interface CompanionRepository {
  name: string;
  path: string;
}

export interface CompanionCatalog {
  protocol: number;
  name: string;
  repositories: CompanionRepository[];
}

export interface CompanionAddress {
  url: string;
  label: string;
  kind: "lan" | "tailscale" | "loopback";
}

export interface CompanionRoot {
  name: string;
  path: string;
}

export interface CompanionStatus {
  enabled: boolean;
  port: number;
  token: string;
  name: string;
  addresses: CompanionAddress[];
  pairingUrl?: string;
  roots: CompanionRoot[];
  error: string | null;
}

export const PAIRING_SCHEME = "codebase-atlas";

export interface PairingPayload {
  token: string;
  origins: string[];
}

export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function isPairingUrl(input: string): boolean {
  return /^codebase-atlas:/i.test(input.trim());
}

function hostPort(origin: string): string {
  const url = new URL(origin.includes("://") ? origin : `http://${origin}`);
  const port = url.port || String(DEFAULT_COMPANION_PORT);
  return `${url.hostname}:${port}`;
}

export function encodePairingUrl(token: string, origins: string[]): string {
  const normalized = normalizePairingCode(token);
  if (!normalized) throw new Error("Pairing code is missing.");
  const hosts = origins.map(hostPort);
  if (hosts.length === 0) throw new Error("Pairing code needs a host.");
  const query = [`v=1`, `t=${normalized}`, ...hosts.map((host) => `h=${host}`)].join("&");
  return `${PAIRING_SCHEME}://pair?${query}`;
}

export function parsePairingUrl(input: string): PairingPayload {
  const value = input.trim();
  if (!value) throw new Error("This is not a Codebase Atlas pairing code.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("This is not a Codebase Atlas pairing code.");
  }
  if (url.protocol.replace(/:$/, "").toLowerCase() !== PAIRING_SCHEME) {
    throw new Error("This is not a Codebase Atlas pairing code.");
  }
  const token = normalizePairingCode(url.searchParams.get("t") ?? "");
  const hosts = url.searchParams.getAll("h");
  if (!token || hosts.length === 0) {
    throw new Error("This pairing code is missing a host or token.");
  }
  return {
    token,
    origins: hosts.map((host) => parseCompanionOrigin(host)),
  };
}

export function pairingUrlFromStatus(status: Pick<CompanionStatus, "token" | "addresses">): string {
  const origins = status.addresses
    .filter((address) => address.kind !== "loopback")
    .map((address) => address.url);
  const usable = origins.length > 0 ? origins : status.addresses.map((address) => address.url);
  return encodePairingUrl(status.token, usable);
}

export function parseCompanionOrigin(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter this computer’s address or Tailscale name.");

  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    throw new Error("Enter a hostname, Tailscale name, or IP address.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Computer URLs must use HTTP or HTTPS.");
  }
  if (!url.hostname) {
    throw new Error("Enter a hostname, Tailscale name, or IP address.");
  }
  if (!url.port) {
    url.port = String(DEFAULT_COMPANION_PORT);
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.origin;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof parsed.error === "string" &&
      parsed.error
    ) {
      return parsed.error;
    }
  } catch {
    // Body is not JSON; fall through to the HTTP status.
  }
  return text.trim() || `Computer returned HTTP ${response.status}.`;
}

async function companionFetch(
  origin: string,
  token: string,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 120_000, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${normalizePairingCode(token)}`);
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      ...rest,
      headers,
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("The computer took too long to respond. Try a smaller repository.");
    }
    throw new Error(
      "Could not reach that computer. Use the same Wi-Fi, or connect both devices to Tailscale.",
    );
  }
  if (response.status === 401) throw new Error("Pairing code did not match.");
  if (!response.ok) throw new Error(await readError(response));
  return response;
}

export async function fetchCompanionCatalog(
  origin: string,
  token: string,
  options: { timeoutMs?: number } = {},
): Promise<CompanionCatalog> {
  const response = await companionFetch(origin, token, "/v1/catalog", options);
  const catalog: unknown = await response.json();
  if (
    !catalog ||
    typeof catalog !== "object" ||
    !("protocol" in catalog) ||
    !("name" in catalog) ||
    !("repositories" in catalog) ||
    typeof catalog.protocol !== "number" ||
    typeof catalog.name !== "string" ||
    !Array.isArray(catalog.repositories)
  ) {
    throw new Error("That computer did not return a Codebase Atlas catalog.");
  }
  if (catalog.protocol !== COMPANION_PROTOCOL) {
    throw new Error(
      "This computer is running a different Codebase Atlas version. Update both and try again.",
    );
  }
  return {
    protocol: catalog.protocol,
    name: catalog.name,
    repositories: catalog.repositories.filter(
      (entry: unknown): entry is CompanionRepository =>
        Boolean(
          entry &&
            typeof entry === "object" &&
            "name" in entry &&
            "path" in entry &&
            typeof entry.name === "string" &&
            typeof entry.path === "string",
        ),
    ),
  };
}

export async function connectPairing(
  payload: PairingPayload,
): Promise<{ origin: string; catalog: CompanionCatalog }> {
  let lastError: Error | null = null;
  for (const origin of payload.origins) {
    try {
      const catalog = await fetchCompanionCatalog(origin, payload.token, { timeoutMs: 6_000 });
      return { origin, catalog };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Could not reach that computer.");
}

export async function scanCompanionRepository(
  origin: string,
  token: string,
  path: string,
): Promise<RepositoryGraph> {
  const response = await companionFetch(origin, token, "/v1/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return parseRepositoryGraph(await response.text());
}
