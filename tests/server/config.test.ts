import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config';

const base = { PUBLIC_URL: 'https://notes.example.com' };

describe('loadConfig', () => {
  it('requires PUBLIC_URL', () => {
    expect(() => loadConfig({})).toThrow('PUBLIC_URL ist erforderlich');
  });
  it('rejects plain http for non-localhost', () => {
    expect(() => loadConfig({ PUBLIC_URL: 'http://x' })).toThrow();
  });
  it('rejects an invalid URL', () => {
    expect(() => loadConfig({ PUBLIC_URL: 'nonsense' })).toThrow();
  });
  it('allows http on localhost', () => {
    const c = loadConfig({ PUBLIC_URL: 'http://localhost:8080' });
    expect(c.rpId).toBe('localhost');
  });
  it('derives rpId from hostname', () => {
    const c = loadConfig(base);
    expect(c.rpId).toBe('notes.example.com');
    expect(c.publicUrl.origin).toBe('https://notes.example.com');
  });
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8080);
    expect(c.sessionDays).toBe(14);
    expect(c.umask).toBe(0o002);
    expect(c.vaultDir).toBe('/vault');
    expect(c.dataDir).toBe('/data');
    expect(c.trustProxy).toBe(false);
    expect(c.excludeGlobs).toEqual([]);
    expect(c.readonlyGlobs).toEqual([]);
  });
  it('parses numeric overrides, UMASK as octal', () => {
    const c = loadConfig({ ...base, PORT: '3000', SESSION_DAYS: '30', UMASK: '022' });
    expect(c.port).toBe(3000);
    expect(c.sessionDays).toBe(30);
    expect(c.umask).toBe(0o022);
  });
  it('binds to 0.0.0.0 by default and takes HOST', () => {
    expect(loadConfig(base).host).toBe('0.0.0.0');
    expect(loadConfig({ ...base, HOST: ' 127.0.0.1 ' }).host).toBe('127.0.0.1');
  });
  it('rejects an empty HOST', () => {
    expect(() => loadConfig({ ...base, HOST: '  ' })).toThrow('HOST');
  });
  it('parses glob lists', () => {
    const c = loadConfig({ ...base, EXCLUDE_PATHS: 'Privat/**, Archiv/*', READONLY_PATHS: 'Ref/**' });
    expect(c.excludeGlobs).toEqual(['Privat/**', 'Archiv/*']);
    expect(c.readonlyGlobs).toEqual(['Ref/**']);
  });
  it('parses TRUST_PROXY', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8,127.0.0.1' }).trustProxy).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
  });

  it('parses TRUST_CF_CONNECTING_IP (default false, needs TRUST_PROXY)', () => {
    expect(loadConfig(base).trustCfConnectingIp).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '1', TRUST_CF_CONNECTING_IP: 'true' }).trustCfConnectingIp).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: '1', TRUST_CF_CONNECTING_IP: 'false' }).trustCfConnectingIp).toBe(false);
    expect(() => loadConfig({ ...base, TRUST_CF_CONNECTING_IP: 'true' })).toThrow(/braucht TRUST_PROXY/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: '1', TRUST_CF_CONNECTING_IP: 'ja' })).toThrow(/true oder false/);
  });
});
