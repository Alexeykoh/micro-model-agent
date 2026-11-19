/**
 * Обобщённый детектор churn тест/спек-артефактов.
 *
 * Наблюдение (реальный прогон): модель писала `*.test.*`, но реализацию не
 * создавала, а при падении тестов переписывала САМ тест — «подгоняла тесты
 * под код» вместо реализации. Предметной привязки здесь нет: правило
 * опирается только на путь файла и на то, идут ли write/edit подряд по
 * тест/спек-файлам без единой правки production-кода, поэтому работает для
 * любого языка и фреймворка.
 *
 * Nudge выдаётся один раз за прогон и является совещательным (не блокирует).
 */

const TEST_DIR_RE = /(^|[\\/])(tests?|specs?|__tests__|__specs__)([\\/]|$)/i;
const TEST_FILE_PATTERNS: RegExp[] = [
  /\.(test|spec)\.[a-z0-9]+$/i, // foo.test.ts, foo.spec.js
  /(^|[\\/])test_[^\\/]+$/i, // python: test_foo.py
  /_test\.[a-z0-9]+$/i, // go: foo_test.go
  /[\\/][A-Za-z0-9_]*Tests?\.[a-z0-9]+$/i, // Java/C#: FooTest.java
  /[\\/][A-Za-z0-9_]*Specs?\.[a-z0-9]+$/i,
];

/** Является ли путь тестовым/спецификационным артефактом (мультиязычно). */
export function isTestOrSpecPath(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  if (TEST_DIR_RE.test(normalized)) return true;
  return TEST_FILE_PATTERNS.some((re) => re.test(normalized));
}

/** Состояние churn тест-артефактов за прогон. */
export interface ArtifactChurnState {
  /** Сколько write/edit подряд пришлось на тест/спек-файлы (сброс на production-правке). */
  testWriteStreak: number;
  /** Последний тест/спек-файл из серии (для сообщения). */
  lastTestFile: string | null;
  /** Nudge уже выдан — не повторяем. */
  nudged: boolean;
}

/** Начальное состояние трекера churn. */
export function createArtifactChurnState(): ArtifactChurnState {
  return { testWriteStreak: 0, lastTestFile: null, nudged: false };
}

/** Сколько подряд идущих тест/спек-правок достаточно, чтобы счесть это churn. */
export const TEST_CHURN_THRESHOLD = 3;

/** Учесть один write/edit по указанному пути. */
export function recordArtifactWrite(state: ArtifactChurnState, filePath: string): void {
  if (!filePath) return;
  if (isTestOrSpecPath(filePath)) {
    state.testWriteStreak++;
    state.lastTestFile = filePath;
  } else {
    // Любая правка production-файла = прогресс; серия тестов прервана.
    state.testWriteStreak = 0;
  }
}

/**
 * Пора ли подтолкнуть модель: подряд идут только тест/спек-правки, а
 * production-код не менялся. Возвращает путь проблемного файла или null.
 */
export function testChurnFile(state: ArtifactChurnState): string | null {
  if (state.nudged) return null;
  if (state.testWriteStreak < TEST_CHURN_THRESHOLD) return null;
  return state.lastTestFile;
}
