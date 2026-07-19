import { getTheme } from '../styling/index.js';

/**
 * Инструмент вопроса пользователю.
 *
 * Позволяет агенту задавать вопросы с вариантами ответов.
 * Используется когда агенту нужен выбор или уточнение.
 *
 * @module tools/question
 */

/** Состояние вопроса */
export interface QuestionState {
  active: boolean;
  question: string;
  choices?: string[];
  response?: string;
}

let currentQuestion: QuestionState | null = null;

/** Создаёт новый вопрос для пользователя */
export function askQuestion(question: string, choices?: string[]): QuestionState {
  currentQuestion = {
    active: true,
    question,
    choices,
  };
  return currentQuestion;
}

/** Возвращает текущий активный вопрос */
export function getQuestion(): QuestionState | null {
  return currentQuestion;
}

/** Записывает ответ пользователя на вопрос */
export function answerQuestion(response: string): void {
  if (currentQuestion) {
    currentQuestion.response = response;
    currentQuestion.active = false;
  }
}

/** Проверяет есть ли активный вопрос */
export function hasActiveQuestion(): boolean {
  return currentQuestion?.active === true;
}

/** Форматирует вопрос для отображения (без цвета) */
export function formatQuestion(q: QuestionState): string {
  const lines: string[] = [];
  lines.push(`Question: ${q.question}`);

  if (q.choices && q.choices.length > 0) {
    lines.push('');
    for (let i = 0; i < q.choices.length; i++) {
      lines.push(`  ${i + 1}. ${q.choices[i]}`);
    }
    lines.push('');
    lines.push(`Enter number (1-${q.choices.length}) or custom text:`);
  }

  return lines.join('\n');
}

/** Форматирует вопрос с цветом (Ink UI) */
export function formatQuestionColored(q: QuestionState): string {
  const theme = getTheme();
  const lines: string[] = [];
  lines.push(theme.warning(`  ${theme.icon.separator} Question: ${q.question}`));

  if (q.choices && q.choices.length > 0) {
    lines.push('');
    for (let i = 0; i < q.choices.length; i++) {
      lines.push(`    ${theme.highlight(String(i + 1))}. ${q.choices[i]}`);
    }
  }

  return lines.join('\n');
}

/** Парсит аргументы команды question (формат: text | choice1 | choice2) */
export function parseQuestionCommand(args: string): { question: string; choices: string[] } {
  // Формат: question text | choice1 | choice2 | ...
  const parts = args.split('|').map(s => s.trim());
  const question = parts[0] || '';
  const choices = parts.slice(1).filter(Boolean);
  return { question, choices };
}
