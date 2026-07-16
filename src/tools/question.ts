export interface QuestionState {
  active: boolean;
  question: string;
  choices?: string[];
  response?: string;
}

let currentQuestion: QuestionState | null = null;

export function askQuestion(question: string, choices?: string[]): QuestionState {
  currentQuestion = {
    active: true,
    question,
    choices,
  };
  return currentQuestion;
}

export function getQuestion(): QuestionState | null {
  return currentQuestion;
}

export function answerQuestion(response: string): void {
  if (currentQuestion) {
    currentQuestion.response = response;
    currentQuestion.active = false;
  }
}

export function hasActiveQuestion(): boolean {
  return currentQuestion?.active === true;
}

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

export function parseQuestionCommand(args: string): { question: string; choices: string[] } {
  // Format: question text | choice1 | choice2 | ...
  const parts = args.split('|').map(s => s.trim());
  const question = parts[0] || '';
  const choices = parts.slice(1).filter(Boolean);
  return { question, choices };
}
