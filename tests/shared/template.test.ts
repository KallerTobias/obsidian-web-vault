import { describe, expect, it } from 'vitest';
import { applyTemplate, dailyNotePath } from '@shared/template';

const now = new Date(2026, 9, 19, 15, 4); // 2026-10-19 15:04 local time (Montag)
const ctx = { title: 'Meine Notiz', now };

describe('applyTemplate', () => {
  it('ersetzt {{title}}', () => {
    expect(applyTemplate('# {{title}}\n{{title}}', ctx)).toBe('# Meine Notiz\nMeine Notiz');
  });
  it('{{date}} → YYYY-MM-DD', () => {
    expect(applyTemplate('{{date}}', ctx)).toBe('2026-10-19');
  });
  it('{{time}} → HH:mm', () => {
    expect(applyTemplate('{{time}}', ctx)).toBe('15:04');
  });
  it('{{date:FORMAT}}', () => {
    expect(applyTemplate('{{date:DD.MM.YYYY}}', ctx)).toBe('19.10.2026');
  });
  it('{{time:FORMAT}}', () => {
    expect(applyTemplate('{{time:HH-mm}}', ctx)).toBe('15-04');
  });
  it('Wochentag und Monat auf Deutsch', () => {
    expect(applyTemplate('{{date:dddd}}', ctx)).toBe('Montag');
    expect(applyTemplate('{{date:MMMM}}', ctx)).toBe('Oktober');
  });
  it('unbekannte Platzhalter bleiben', () => {
    expect(applyTemplate('{{foo}} {{ date }} {{cursor}}', ctx)).toBe('{{foo}} {{ date }} {{cursor}}');
  });
  it('ersetzte Werte werden nicht erneut ausgewertet', () => {
    expect(applyTemplate('{{title}}', { ...ctx, title: '{{date}}' })).toBe('{{date}}');
  });
  it('Text ohne Platzhalter bleibt unverändert', () => {
    expect(applyTemplate('---\ntags: [x]\n---\n', ctx)).toBe('---\ntags: [x]\n---\n');
  });
});

describe('dailyNotePath', () => {
  it('Ordner + Format', () => {
    expect(dailyNotePath(now, 'Journal', 'YYYY/MM-DD')).toBe('Journal/2026/10-19.md');
  });
  it('Ordner mit Schrägstrichen am Rand / leer', () => {
    expect(dailyNotePath(now, 'Journal/', 'YYYY-MM-DD')).toBe('Journal/2026-10-19.md');
    expect(dailyNotePath(now, '', 'YYYY-MM-DD')).toBe('2026-10-19.md');
  });
});
