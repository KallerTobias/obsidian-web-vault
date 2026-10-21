export interface Config {
  publicUrl: URL;
  rpId: string;
  host: string;
  port: number;
  vaultDir: string;
  dataDir: string;
  sessionDays: number;
  trustProxy: boolean | number | string[];
  /** Take the client IP from `CF-Connecting-IP` (only behind Cloudflare, only with TRUST_PROXY). */
  trustCfConnectingIp: boolean;
  excludeGlobs: string[];
  readonlyGlobs: string[];
  umask: number;
}

type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function int(env: Env, key: string, fallback: number): number {
  const v = env[key]?.trim();
  if (!v) return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`${key} muss eine Zahl sein`);
  return Number(v);
}

function parseTrustProxy(v: string | undefined): boolean | number | string[] {
  const s = (v ?? '').trim();
  if (s === '' || s === 'false') return false;
  if (s === 'true') return true;
  if (/^\d+$/.test(s)) return Number(s);
  return list(s);
}

function bool(env: Env, key: string): boolean {
  const s = (env[key] ?? '').trim().toLowerCase();
  if (s === '' || s === 'false') return false;
  if (s === 'true') return true;
  throw new Error(`${key} muss true oder false sein`);
}

function parseUmask(v: string | undefined): number {
  const s = v?.trim();
  if (!s) return 0o002;
  if (!/^[0-7]{1,4}$/.test(s)) throw new Error('UMASK muss oktal sein, z. B. 002');
  return parseInt(s, 8);
}

function parseHost(v: string | undefined): string {
  if (v === undefined) return '0.0.0.0';
  const s = v.trim();
  if (!s) throw new Error('HOST darf nicht leer sein');
  return s;
}

export function loadConfig(env: Env): Config {
  const raw = env.PUBLIC_URL?.trim();
  if (!raw) throw new Error('PUBLIC_URL ist erforderlich');
  let publicUrl: URL;
  try {
    publicUrl = new URL(raw);
  } catch {
    throw new Error('PUBLIC_URL ist keine gültige URL');
  }
  const local = LOCAL_HOSTS.has(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && local)) {
    throw new Error('PUBLIC_URL muss https sein (http nur für localhost)');
  }
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  const trustCfConnectingIp = bool(env, 'TRUST_CF_CONNECTING_IP');
  if (trustCfConnectingIp && (trustProxy === false || trustProxy === 0 || (Array.isArray(trustProxy) && trustProxy.length === 0))) {
    throw new Error('TRUST_CF_CONNECTING_IP=true braucht TRUST_PROXY (der Cloudflare-Connector ist ein Proxy)');
  }
  return {
    publicUrl,
    rpId: publicUrl.hostname,
    host: parseHost(env.HOST),
    port: int(env, 'PORT', 8080),
    vaultDir: env.VAULT_DIR?.trim() || '/vault',
    dataDir: env.DATA_DIR?.trim() || '/data',
    sessionDays: int(env, 'SESSION_DAYS', 14),
    trustProxy,
    trustCfConnectingIp,
    excludeGlobs: list(env.EXCLUDE_PATHS),
    readonlyGlobs: list(env.READONLY_PATHS),
    umask: parseUmask(env.UMASK),
  };
}
