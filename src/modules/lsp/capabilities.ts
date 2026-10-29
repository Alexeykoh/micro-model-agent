// Клиентские capabilities LSP: ровно тот минимум, который нужен харнессу.
// Вынесено из `connection.ts`, чтобы файл оставался под потолком правила 6.
export function buildClientCapabilities(): Record<string, unknown> {
  return {
    // 3.17: смещение в позициях договаривается. utf-16 — единственный
    // обязательный к поддержке, он и остаётся дефолтом.
    general: { positionEncodings: ["utf-16"] },
    textDocument: {
      publishDiagnostics: { relatedInformation: true, versionSupport: true },
      // 3.17 pull-модель: объявляем, что умеем принимать диагностики по запросу.
      diagnostic: {},
    },
    workspace: { symbol: {} },
  };
}
