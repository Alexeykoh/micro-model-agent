/**
 * First-run orchestration: run the setup wizard BEFORE bootstrap so background
 * probes (context/reasoning) never start while the wizard owns the terminal.
 */
export async function order<TAnswers, TBoot>(opts: {
  hasConfig: boolean;
  interactive: boolean;
  runSetup: () => Promise<TAnswers | null>;
  applyAnswers?: (answers: TAnswers) => void;
  bootstrap: () => Promise<TBoot>;
}): Promise<{ answers: TAnswers | null; boot: TBoot }> {
  let answers: TAnswers | null = null;
  if (!opts.hasConfig && opts.interactive) {
    answers = await opts.runSetup();
    if (answers && opts.applyAnswers) opts.applyAnswers(answers);
  }
  const boot = await opts.bootstrap();
  return { answers, boot };
}
