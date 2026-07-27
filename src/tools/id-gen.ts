let counter = 0;

export function generateToolCallId(prefix = 'call'): string {
  counter++;
  return `${prefix}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 6)}`;
}

export function generateSubagentToolCallId(): string {
  return generateToolCallId('sub');
}

export function generateReactToolCallId(): string {
  return generateToolCallId('react');
}
