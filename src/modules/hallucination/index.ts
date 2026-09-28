// Детектор галлюцинаций: реэкспорт проверок (консистентность, уверенность, факты, LLM-судья).
export { HallucinationDetector, type HallucinationCheckResult } from "./detector";
export { ConsistencyCheck } from "./consistency";
export { ConfidenceCheck } from "./confidence";
export { FactualCheck } from "./factual";
export { LLMJudge } from "./llm-judge";
