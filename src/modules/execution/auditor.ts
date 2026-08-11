import { existsSync } from "fs";
import { resolve } from "path";
import { t } from "../../i18n/index";
import type { Plan } from "./planner";
import { isJsMemberAccess } from "../hallucination/js-identifiers";

const MASS_EDIT_THRESHOLD = 10;

export interface AuditResult {
	passed: boolean;
	missingFiles: string[];
	createdFiles: string[];
	modifiedFiles: string[];
	summary: string;
	massEditWarning: string | null;
}

export class Auditor {
	private baseDir: string;

	constructor(baseDir: string) {
		this.baseDir = baseDir;
	}

	async audit(plan: Plan): Promise<AuditResult> {
		const allStepText = plan.steps
			.map((s) => s.description.replace(/\([^)]*\)/g, " "))
			.join(" ");
		const fileMatches = allStepText.match(/\b[\w./-]+\.[a-z]+/gi) || [];
		// process.env / console.log in step descriptions are JS member access,
		// not files — drop them before existence checks (false "missing file"
		// warnings).
		const uniqueFiles = [
			...new Set(fileMatches.filter((f) => !isJsMemberAccess(f))),
		];

		const missingFiles: string[] = [];
		const existingFiles: string[] = [];

		for (const filePath of uniqueFiles) {
			const resolved = resolve(this.baseDir, filePath);
			if (existsSync(resolved)) {
				existingFiles.push(filePath);
			} else {
				missingFiles.push(filePath);
			}
		}

		const doneSteps = plan.steps.filter((s) => s.status === "done").length;
		const totalSteps = plan.steps.length;

		let massEditWarning: string | null = null;
		if (uniqueFiles.length > MASS_EDIT_THRESHOLD) {
			massEditWarning = t("exec.mass_edit_warning", {
				count: String(uniqueFiles.length),
			});
		}

		const passed = missingFiles.length === 0;

		let summary: string;
		if (passed) {
			summary = t("exec.audit_pass", {
				done: doneSteps,
				total: totalSteps,
				files: existingFiles.length,
			});
		} else {
			summary = t("exec.audit_fail", {
				done: doneSteps,
				total: totalSteps,
				files: missingFiles.length,
			});
		}

		return {
			passed,
			missingFiles,
			createdFiles: existingFiles,
			modifiedFiles: [],
			summary,
			massEditWarning,
		};
	}
}
