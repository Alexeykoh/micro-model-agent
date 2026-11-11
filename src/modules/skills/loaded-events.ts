// Подписчики изменения загруженного набора скиллов (веб-индикатор).
//
// Вынесено отдельным файлом, чтобы `module.ts` (у потолка ≤300 строк)
// не раздувался на каждый мост. Hub не знает про веб: он только
// оповещает своих подписчиков; fail-open на сбой одного из них.
import type { SkillMeta } from "./loader";

/** Узкий вид загруженного скила: имя и источник. Тело/пути наружу не уходят. */
export interface LoadedSkillRef {
  name: string;
  kind: SkillMeta["kind"];
}

/** Hub подписки на изменение загруженного набора. */
export class LoadedEvents {
  private listeners: Array<(loaded: LoadedSkillRef[]) => void> = [];

  /** Подписка; возвращает отписку. */
  subscribe(cb: (loaded: LoadedSkillRef[]) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Оповестить всех; сбой одного подписчика не роняет остальных. */
  notify(loaded: SkillMeta[]): void {
    const refs: LoadedSkillRef[] = loaded.map((s) => ({ name: s.name, kind: s.kind }));
    for (const cb of this.listeners) {
      try {
        cb(refs);
      } catch {
        /* fail-open: подписчик не должен ронять загрузку скилла */
      }
    }
  }
}