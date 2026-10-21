import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
// Type-only imports: the server's response shapes, erased at build time.
import type { Session } from '../../../server/auth/sessions';
import type { VaultEvent } from '../../../server/events';
import type { SearchHit } from '../../../server/index/search';
import type { Backlink, GraphData, IndexedNote } from '../../../server/index/vault-index';
import type { Settings } from '../../../server/store/settings';
import type { TreeEntry, Version } from '../../../server/vault/files';
import type { RenameResult } from '../../../server/vault/ops';
import { session } from './stores/session';

export type { Backlink, GraphData, IndexedNote, RenameResult, SearchHit, Settings, TreeEntry, VaultEvent, Version };

/** A non-2xx answer. `body` is the parsed JSON (e.g. `{ error }`, or the 409 conflict body), else the text. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const msg = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${status}`;
    super(msg);
    this.name = 'ApiError';
  }
}

/** Body of a 409 from `PUT`/`POST /api/note`. */
export interface ConflictBody {
  error: string;
  diskContent: string | null;
  diskVersion: Version | null;
}

export interface Ceremony<T> {
  options: T;
  challengeId: string;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  transports: string[];
  createdAt: number;
  lastUsed: number | null;
}

export type SessionInfo = Session & { current: boolean };

export interface LookupEntry {
  path: string;
  name: string;
  aliases: string[];
  /** Absent for non-note files. */
  headings?: { level: number; text: string }[];
}

export type SettingsPatch = Partial<Omit<Settings, 'dailyNotes' | 'graph'>> & {
  dailyNotes?: Partial<Settings['dailyNotes']>;
  graph?: Partial<Settings['graph']>;
};

export type ChangesResult = { resync: true; seq: number } | { seq: number; events: VaultEvent[] };

interface RequestOptions {
  body?: unknown;
  /** Login/setup ceremonies: a 401 there is a failed attempt, not an expired session. */
  ceremony?: boolean;
}

/** One query parameter per entry, each value fully encoded (`/`, `#`, `?`, `%`, spaces …). */
function query(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(method: string, url: string, opts: RequestOptions = {}): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await fetch(url, init);
  const body = await readBody(res);
  if (!res.ok) {
    if (res.status === 401 && !opts.ceremony) session.expired.set(true);
    throw new ApiError(res.status, body);
  }
  return body as T;
}

const get = <T>(url: string) => request<T>('GET', url);
const post = <T>(url: string, body?: unknown, ceremony = false) => request<T>('POST', url, { body, ceremony });

export const api = {
  health: () => get<{ ok: true }>('/api/health'),

  auth: {
    /** `publicOrigin`: the only origin the app works under (PUBLIC_URL). */
    state: () => get<{ authenticated: boolean; setupRequired: boolean; publicOrigin?: string }>('/api/auth/state'),
    setupOptions: (token: string) =>
      post<Ceremony<PublicKeyCredentialCreationOptionsJSON>>('/api/auth/setup/options', { token }, true),
    setupVerify: (token: string, challengeId: string, response: RegistrationResponseJSON | object, name: string) =>
      post<PasskeyInfo>('/api/auth/setup/verify', { token, challengeId, response, name }, true),
    loginOptions: () => post<Ceremony<PublicKeyCredentialRequestOptionsJSON>>('/api/auth/login/options', undefined, true),
    loginVerify: (challengeId: string, response: AuthenticationResponseJSON | object) =>
      post<{ ok: true }>('/api/auth/login/verify', { challengeId, response }, true),
    logout: () => post<void>('/api/auth/logout'),
    passkeys: {
      list: () => get<PasskeyInfo[]>('/api/auth/passkeys'),
      /** Step-up before adding: authenticate with an existing passkey (a failure is a 401 that does not end the session). */
      confirmOptions: () => post<Ceremony<PublicKeyCredentialRequestOptionsJSON>>('/api/auth/passkeys/confirm/options'),
      confirm: (challengeId: string, response: AuthenticationResponseJSON | object) =>
        post<{ ok: true }>('/api/auth/passkeys/confirm', { challengeId, response }, true),
      /** Needs a confirmation of this session within the last 5 minutes (else 403). */
      options: () => post<Ceremony<PublicKeyCredentialCreationOptionsJSON>>('/api/auth/passkeys/options'),
      add: (challengeId: string, response: RegistrationResponseJSON | object, name: string) =>
        post<PasskeyInfo>('/api/auth/passkeys', { challengeId, response, name }),
      rename: (id: string, name: string) =>
        request<void>('PATCH', `/api/auth/passkeys/${encodeURIComponent(id)}`, { body: { name } }),
      remove: (id: string, force = false) =>
        request<void>('DELETE', `/api/auth/passkeys/${encodeURIComponent(id)}${query({ force: force ? '1' : undefined })}`),
    },
    sessions: {
      list: () => get<SessionInfo[]>('/api/auth/sessions'),
      revoke: (id: string) => request<void>('DELETE', `/api/auth/sessions/${encodeURIComponent(id)}`),
      revokeOthers: () => post<void>('/api/auth/sessions/revoke-others'),
    },
  },

  /** The vault root folder with all visible entries below it. */
  tree: () => get<TreeEntry>('/api/tree'),

  note: {
    get: (path: string) => get<{ content: string; version: Version; readonly: boolean }>(`/api/note${query({ path })}`),
    /** Throws ApiError 409 with a `ConflictBody` when the file changed since `baseVersion`. */
    save: (path: string, content: string, baseVersion: Version) =>
      request<{ version: Version }>('PUT', `/api/note${query({ path })}`, { body: { content, baseVersion } }),
    /** Throws ApiError 409 when the path already exists. */
    create: (path: string, content: string) => post<{ path: string; version: Version }>('/api/note', { path, content }),
  },

  folder: {
    create: (path: string) => post<{ path: string }>('/api/folder', { path }),
  },

  rename: (from: string, to: string, updateLinks: boolean) => post<RenameResult>('/api/rename', { from, to, updateLinks }),
  renameAffected: (path: string) => get<{ count: number; paths: string[] }>(`/api/rename/affected${query({ path })}`),

  entry: {
    /** Moves a file or folder to `.trash/`. */
    trash: (path: string) => request<void>('DELETE', `/api/entry${query({ path })}`),
  },

  file: {
    /** URL of a vault file for `<img src>`, links and downloads (the session cookie authorises it). */
    url: (path: string) => `/api/file${query({ path })}`,
  },

  attachment: {
    upload: (file: Blob, opts: { notePath: string; fileName?: string; pasted?: boolean }) => {
      const form = new FormData();
      form.append('notePath', opts.notePath);
      if (opts.pasted) form.append('pasted', '1');
      // Fields before the file: the server reads the parts in order.
      form.append('file', file, opts.fileName ?? (file instanceof File ? file.name : 'Anhang'));
      return post<{ path: string }>('/api/attachment', form);
    },
  },

  backlinks: (path: string) =>
    get<{ linked: Backlink[]; unlinked: Backlink[] }>(`/api/backlinks${query({ path })}`),
  meta: (path: string) => get<IndexedNote>(`/api/meta${query({ path })}`),
  resolve: (target: string, from?: string) => get<{ path: string | null }>(`/api/resolve${query({ target, from })}`),
  lookup: () => get<LookupEntry[]>('/api/lookup'),
  search: (q: string, limit?: number) =>
    get<SearchHit[]>(`/api/search${query({ q, limit: limit === undefined ? undefined : String(limit) })}`),
  tags: () => get<{ tag: string; count: number }[]>('/api/tags'),
  graph: () => get<GraphData>('/api/graph'),

  events: {
    /** For `new EventSource(...)`. */
    url: '/api/events',
    /** Polling fallback: events after `since`, or `resync` when the server cannot catch the client up. */
    changes: (since: number) => get<ChangesResult>(`/api/changes${query({ since: String(since) })}`),
  },

  settings: {
    get: () => get<Settings>('/api/settings'),
    update: (patch: SettingsPatch) => request<Settings>('PUT', '/api/settings', { body: patch }),
  },
};
