import chalk from "chalk";
import { DefaultPackageManager } from "./package-manager.js";
import { prepareLifecycleHooks, runLifecycleHooks } from "./lifecycle-hooks.js";
import { SettingsManager } from "./settings-manager.js";

export type PackageCommand = "install" | "remove" | "update" | "list";

export interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	local: boolean;
	help: boolean;
	invalidOption?: string;
}

export interface PackageCommandRunnerOptions {
	appName: string;
	args: string[];
	cwd: string;
	agentDir: string;
	stdout?: NodeJS.WriteStream;
	stderr?: NodeJS.WriteStream;
	allowedCommands?: ReadonlySet<PackageCommand>;
}

export interface PackageCommandRunnerResult {
	handled: boolean;
	exitCode: number;
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string, stderr: NodeJS.WriteStream): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		stderr.write(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`) + "\n");
		if (error.stack) {
			stderr.write(chalk.dim(error.stack) + "\n");
		}
	}
}

export function getPackageCommandUsage(appName: string, command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${appName} install <source> [-l]`;
		case "remove":
			return `${appName} remove <source> [-l]`;
		case "update":
			return `${appName} update [source]`;
		case "list":
			return `${appName} list`;
	}
}

function printPackageCommandHelp(
	appName: string,
	command: PackageCommand,
	stdout: NodeJS.WriteStream,
): void {
	switch (command) {
		case "install":
			stdout.write(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage(appName, "install")}

Install a package, add it to settings, and run lifecycle hooks.

Options:
  -l, --local    Install project-locally (.pi/settings.json)

Examples:
  ${appName} install npm:@foo/bar
  ${appName} install git:github.com/user/repo
  ${appName} install git:git@github.com:user/repo
  ${appName} install https://github.com/user/repo
  ${appName} install ssh://git@github.com/user/repo
  ${appName} install ./local/path
`);
			return;
		case "remove":
			stdout.write(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage(appName, "remove")}

Remove a package and its source from settings.

Options:
  -l, --local    Remove from project settings (.pi/settings.json)

Example:
  ${appName} remove npm:@foo/bar
`);
			return;
		case "update":
			stdout.write(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage(appName, "update")}

Update installed packages.
If <source> is provided, only that package is updated.
`);
			return;
		case "list":
			stdout.write(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage(appName, "list")}

List installed packages from user and project settings.
`);
			return;
	}
}

export function parsePackageCommand(
	args: string[],
	allowedCommands?: ReadonlySet<PackageCommand>,
): PackageCommandOptions | undefined {
	const [command, ...rest] = args;
	if (command !== "install" && command !== "remove" && command !== "update" && command !== "list") {
		return undefined;
	}
	if (allowedCommands && !allowedCommands.has(command)) {
		return undefined;
	}

	let local = false;
	let help = false;
	let invalidOption: string | undefined;
	let source: string | undefined;

	for (const arg of rest) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}
		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}
		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}
		if (!source) {
			source = arg;
		}
	}

	return { command, source, local, help, invalidOption };
}

export async function runPackageCommand(
	options: PackageCommandRunnerOptions,
): Promise<PackageCommandRunnerResult> {
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const parsed = parsePackageCommand(options.args, options.allowedCommands);
	if (!parsed) {
		return { handled: false, exitCode: 0 };
	}

	if (parsed.help) {
		printPackageCommandHelp(options.appName, parsed.command, stdout);
		return { handled: true, exitCode: 0 };
	}

	if (parsed.invalidOption) {
		stderr.write(chalk.red(`Unknown option ${parsed.invalidOption} for "${parsed.command}".`) + "\n");
		stderr.write(chalk.dim(`Use "${options.appName} --help" or "${getPackageCommandUsage(options.appName, parsed.command)}".`) + "\n");
		return { handled: true, exitCode: 1 };
	}

	const source = parsed.source;
	if ((parsed.command === "install" || parsed.command === "remove") && !source) {
		stderr.write(chalk.red(`Missing ${parsed.command} source.`) + "\n");
		stderr.write(chalk.dim(`Usage: ${getPackageCommandUsage(options.appName, parsed.command)}`) + "\n");
		return { handled: true, exitCode: 1 };
	}

	const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
	reportSettingsErrors(settingsManager, "package command", stderr);
	const packageManager = new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
	});
	packageManager.setProgressCallback((event) => {
		if (event.type === "start" && event.message) {
			stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (parsed.command) {
			case "install": {
				const lifecycleOptions = {
					source: source!,
					local: parsed.local,
					cwd: options.cwd,
					agentDir: options.agentDir,
					appName: options.appName,
					packageManager,
					stdout,
					stderr,
				};

				const beforeInstallHooks = await prepareLifecycleHooks(lifecycleOptions, "source");
				const beforeInstallResult = await runLifecycleHooks(beforeInstallHooks, "beforeInstall");

				await packageManager.install(source!, { local: parsed.local });
				packageManager.addSourceToSettings(source!, { local: parsed.local });

				const afterInstallHooks = await prepareLifecycleHooks(lifecycleOptions, "installed", {
					verifyRuntimeDependencies: true,
				});
				const afterInstallResult = await runLifecycleHooks(afterInstallHooks, "afterInstall");

				const hookErrors = beforeInstallResult.hookErrors + afterInstallResult.hookErrors;
				if (hookErrors > 0) {
					stderr.write(chalk.yellow(`Lifecycle hooks completed with ${hookErrors} hook error(s).`) + "\n");
				}
				stdout.write(chalk.green(`Installed ${source}`) + "\n");
				return { handled: true, exitCode: 0 };
			}

			case "remove": {
				const lifecycleOptions = {
					source: source!,
					local: parsed.local,
					cwd: options.cwd,
					agentDir: options.agentDir,
					appName: options.appName,
					packageManager,
					stdout,
					stderr,
				};
				const removeHooks = await prepareLifecycleHooks(lifecycleOptions, "installed");
				const beforeRemoveResult = await runLifecycleHooks(removeHooks, "beforeRemove");

				await packageManager.remove(source!, { local: parsed.local });
				const removed = packageManager.removeSourceFromSettings(source!, { local: parsed.local });

				const afterRemoveResult = await runLifecycleHooks(removeHooks, "afterRemove");
				const hookErrors = beforeRemoveResult.hookErrors + afterRemoveResult.hookErrors;
				if (hookErrors > 0) {
					stderr.write(chalk.yellow(`Lifecycle hooks completed with ${hookErrors} hook error(s).`) + "\n");
				}

				if (!removed) {
					stderr.write(chalk.red(`No matching package found for ${source}`) + "\n");
					return { handled: true, exitCode: 1 };
				}
				stdout.write(chalk.green(`Removed ${source}`) + "\n");
				return { handled: true, exitCode: 0 };
			}

			case "list": {
				const globalSettings = settingsManager.getGlobalSettings();
				const projectSettings = settingsManager.getProjectSettings();
				const globalPackages = globalSettings.packages ?? [];
				const projectPackages = projectSettings.packages ?? [];

				if (globalPackages.length === 0 && projectPackages.length === 0) {
					stdout.write(chalk.dim("No packages installed.") + "\n");
					return { handled: true, exitCode: 0 };
				}

				const formatPackage = (pkg: (typeof globalPackages)[number], scope: "user" | "project") => {
					const pkgSource = typeof pkg === "string" ? pkg : pkg.source;
					const filtered = typeof pkg === "object";
					const display = filtered ? `${pkgSource} (filtered)` : pkgSource;
					stdout.write(`  ${display}\n`);
					const path = packageManager.getInstalledPath(pkgSource, scope);
					if (path) {
						stdout.write(chalk.dim(`    ${path}`) + "\n");
					}
				};

				if (globalPackages.length > 0) {
					stdout.write(chalk.bold("User packages:") + "\n");
					for (const pkg of globalPackages) {
						formatPackage(pkg, "user");
					}
				}

				if (projectPackages.length > 0) {
					if (globalPackages.length > 0) stdout.write("\n");
					stdout.write(chalk.bold("Project packages:") + "\n");
					for (const pkg of projectPackages) {
						formatPackage(pkg, "project");
					}
				}

				return { handled: true, exitCode: 0 };
			}

			case "update":
				await packageManager.update(source);
				if (source) {
					stdout.write(chalk.green(`Updated ${source}`) + "\n");
				} else {
					stdout.write(chalk.green("Updated packages") + "\n");
				}
				return { handled: true, exitCode: 0 };
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		stderr.write(chalk.red(`Error: ${message}`) + "\n");
		return { handled: true, exitCode: 1 };
	}
}
