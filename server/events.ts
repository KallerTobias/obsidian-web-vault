import type { Version } from './vault/files';

export type VaultEvent =
  | { seq: number; type: 'created' | 'changed' | 'deleted'; path: string; version?: Version }
  | { seq: number; type: 'renamed'; from: string; to: string };

/** Verteilt `Omit` über die Union, damit die Varianten erhalten bleiben. */
export type NewVaultEvent = VaultEvent extends infer E ? (E extends VaultEvent ? Omit<E, 'seq'> : never) : never;

const CAPACITY = 1000;

/** Ereignisbus mit Ringpuffer der letzten 1.000 Ereignisse. */
export class EventBus {
  private buffer: VaultEvent[] = [];
  private current = 0;
  private listeners = new Set<(e: VaultEvent) => void>();

  get seq(): number {
    return this.current;
  }

  publish(e: NewVaultEvent): VaultEvent {
    const ev = { ...e, seq: ++this.current } as VaultEvent;
    this.buffer.push(ev);
    if (this.buffer.length > CAPACITY) this.buffer.shift();
    for (const fn of [...this.listeners]) {
      try {
        fn(ev);
      } catch {
        // ein fehlerhafter Abonnent darf die anderen nicht stören
      }
    }
    return ev;
  }

  /** Ereignisse mit seq > `seq`; 'gap', wenn der Puffer die Lücke nicht mehr abdeckt. */
  since(seq: number): VaultEvent[] | 'gap' {
    if (seq >= this.current) return [];
    const oldest = this.buffer[0]?.seq ?? this.current + 1;
    if (seq < oldest - 1) return 'gap';
    return this.buffer.filter((e) => e.seq > seq);
  }

  subscribe(fn: (e: VaultEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
