// Информационные команды: usage, map, changelog.
import type { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { getDefaultChannel } from "../output";
import { readMmaVersion } from "../core/version";
import type { IndexerModule } from "../modules/indexer/module";
import { runMapAction } from "../modules/indexer/map-command";
import { fetchProviderBudget } from "../llm/provider-budget";
import { formatCost } from "../modules/pricing/prices";
import {
  readChangelog,
  extractLatestChangelog,
  extractChangelogRange,
} from "../modules/updater/changelog-reader";

const version = readMmaVersion();

export function buildUsageCommand(program: Command): void {
  program
    .command("usage")
    .description(t("cli.usage"))
    .action(async () => {
      const { config, logger } = await bootstrap();
      const { type: provider, baseUrl, apiKey } = config.provider;
      const result = await fetchProviderBudget(provider, baseUrl, apiKey, {
        log: (level, message) => (level === "warn" ? logger.warn(message) : logger.debug(message)),
      });

      if (result.reason === "unsupported") {
        getDefaultChannel().writeLine(t("cli.usage_unsupported", { provider }));
        return;
      }
      if (result.reason === "no-key") {
        getDefaultChannel().writeLine(t("cli.usage_no_key"));
        return;
      }
      if (result.reason === "error" || !result.budget) {
        getDefaultChannel().writeLine(t("cli.usage_error", { error: result.error ?? "" }));
        return;
      }

      const b = result.budget;
      let printed = false;
      if (b.keyUsageUsd !== undefined) {
        getDefaultChannel().writeLine(
          t("cli.usage_key_usage", { usage: formatCost(b.keyUsageUsd) }),
        );
        printed = true;
      }
      if (b.keyLimitUsd !== undefined && b.keyRemainingUsd !== undefined) {
        getDefaultChannel().writeLine(
          t("cli.usage_key_limit", {
            limit: formatCost(b.keyLimitUsd),
            remaining: formatCost(b.keyRemainingUsd),
          }),
        );
        printed = true;
      }
      if (b.balanceUsd !== undefined) {
        getDefaultChannel().writeLine(
          t("cli.usage_balance", { balance: formatCost(b.balanceUsd) }),
        );
        printed = true;
      }
      if (b.totalCreditsUsd !== undefined && b.totalUsageUsd !== undefined) {
        getDefaultChannel().writeLine(
          t("cli.usage_account", {
            credits: formatCost(b.totalCreditsUsd),
            used: formatCost(b.totalUsageUsd),
          }),
        );
        printed = true;
      }
      if (!printed) getDefaultChannel().writeLine(t("cli.usage_empty"));
    });
}

export function buildMapCommand(program: Command): void {
  program
    .command("map")
    .description(t("cli.map.description"))
    .argument("[action]", t("cli.map.action"), "summary")
    .argument("[query]", t("cli.map.query"))
    .action(async (action: string, query?: string) => {
      const { agent } = await bootstrap();
      const indexer = agent.getModule<IndexerModule>("indexer");
      if (!indexer) {
        getDefaultChannel().writeLine(t("indexer.not_indexed"));
        return;
      }
      const result = await runMapAction(indexer, action, query);
      getDefaultChannel().writeLine(result.output);
    });
}

export function buildChangelogCommand(program: Command): void {
  program
    .command("changelog")
    .description(t("cli.changelog_title", { version }))
    .option("--from <version>", t("cli.changelog_range", { from: "..." }))
    .action((opts: { from?: string }) => {
      const changelog = readChangelog("micro-models-agent");
      if (!changelog) {
        getDefaultChannel().writeLine(pc.yellow(t("cli.changelog_not_found")));
        return;
      }
      if (opts.from) {
        const range = extractChangelogRange(changelog, opts.from, version);
        if (!range) {
          getDefaultChannel().writeLine(pc.yellow(t("cli.changelog_not_found")));
          return;
        }
        getDefaultChannel().writeLine(pc.cyan(t("cli.changelog_range", { from: opts.from })));
        getDefaultChannel().writeLine(range);
      } else {
        const latest = extractLatestChangelog(changelog);
        if (!latest) {
          getDefaultChannel().writeLine(pc.yellow(t("cli.changelog_not_found")));
          return;
        }
        getDefaultChannel().writeLine(pc.cyan(t("cli.changelog_title", { version })));
        getDefaultChannel().writeLine(latest);
      }
    });
}
