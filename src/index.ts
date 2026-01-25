import "./stdio";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { spawnSync, SpawnSyncOptions, SpawnSyncReturns } from "child_process";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DEFAULT_CARGO_SEMVER_CHECKS_VERSION = "latest";
const DEFAULT_LABEL_PREFIX = "semver: ";
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");
const GITHUB_RELEASES_BASE = "https://github.com/obi1kenobi/cargo-semver-checks/releases";
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);

type SemverType = "major" | "minor" | "patch";

interface CommandResult extends SpawnSyncReturns<string> {
  stdout: string;
  stderr: string;
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const status = (error as { status?: number }).status;
  if (status && RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  return false;
}

async function withRetries<T>(
  operation: () => Promise<T>,
  label: string,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= maxAttempts || !isRetryableError(error)) {
        throw error;
      }
      core.warning(`${label} failed (${message}). Retrying (${attempt}/${maxAttempts})...`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts.`);
}

function runCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  }) as CommandResult;

  if (result.error) {
    throw new Error(`Failed to run "${command} ${args.join(" ")}": ${result.error.message}`);
  }

  return result;
}

function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_REGEX, "");
}

function ensureGitShaAvailable(sha: string, cwd: string): void {
  core.info(`Checking if base SHA ${sha} is available...`);
  const check = runCommand("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd });
  if (check.status === 0) {
    core.info("Base SHA is already available.");
    return;
  }

  core.info(`Fetching base SHA ${sha} from origin...`);
  const fetch = runCommand("git", ["fetch", "--no-tags", "--depth=1", "origin", sha], { cwd });
  if (fetch.status !== 0) {
    throw new Error(
      `Failed to fetch base SHA ${sha}: ${stripAnsi(
        `${fetch.stdout || ""}\n${fetch.stderr || ""}`,
      ).trim()}`,
    );
  }
  core.info("Base SHA fetched successfully.");
}

function getTargetTriple(): string | null {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "linux" && arch === "x64") {
    return "x86_64-unknown-linux-gnu";
  }
  if (platform === "linux" && arch === "arm64") {
    return "aarch64-unknown-linux-gnu";
  }
  if (platform === "darwin" && arch === "x64") {
    return "x86_64-apple-darwin";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (platform === "win32" && arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }

  return null;
}

function httpsGet(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode! >= 300 && response.statusCode! < 400 && response.headers.location) {
        httpsGet(response.headers.location).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }

      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

async function getLatestVersion(): Promise<string> {
  const url = `${GITHUB_RELEASES_BASE}/latest`;
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode! >= 300 && response.statusCode! < 400 && response.headers.location) {
        const match = response.headers.location.match(/\/tag\/v?(.+)$/);
        if (match) {
          resolve(match[1]);
          return;
        }
      }
      reject(new Error("Failed to determine latest version"));
    });
    request.on("error", reject);
  });
}

async function installFromRelease(version: string): Promise<void> {
  const triple = getTargetTriple();
  if (!triple) {
    throw new Error(`Unsupported platform: ${os.platform()}-${os.arch()}`);
  }

  let resolvedVersion = version;
  if (version === DEFAULT_CARGO_SEMVER_CHECKS_VERSION) {
    core.info("Resolving latest version...");
    resolvedVersion = await getLatestVersion();
    core.info(`Latest version: ${resolvedVersion}`);
  }

  const versionTag = resolvedVersion.startsWith("v") ? resolvedVersion : `v${resolvedVersion}`;
  const isWindows = os.platform() === "win32";
  const ext = isWindows ? "zip" : "tar.gz";
  const assetName = `cargo-semver-checks-${triple}.${ext}`;
  const downloadUrl = `${GITHUB_RELEASES_BASE}/download/${versionTag}/${assetName}`;

  core.info(`Downloading: ${downloadUrl}`);
  const data = await httpsGet(downloadUrl);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cargo-semver-checks-"));
  const archivePath = path.join(tempDir, assetName);
  fs.writeFileSync(archivePath, data);

  const binDir = path.join(os.homedir(), ".cargo", "bin");
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  if (isWindows) {
    const unzip = runCommand("powershell", [
      "-Command",
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${tempDir}' -Force`,
    ]);
    if (unzip.status !== 0) {
      throw new Error(`Failed to extract zip: ${unzip.stderr}`);
    }
    const exePath = path.join(tempDir, "cargo-semver-checks.exe");
    fs.copyFileSync(exePath, path.join(binDir, "cargo-semver-checks.exe"));
  } else {
    const tar = runCommand("tar", ["-xzf", archivePath, "-C", tempDir]);
    if (tar.status !== 0) {
      throw new Error(`Failed to extract tarball: ${tar.stderr}`);
    }
    const binPath = path.join(tempDir, "cargo-semver-checks");
    const destPath = path.join(binDir, "cargo-semver-checks");
    fs.copyFileSync(binPath, destPath);
    fs.chmodSync(destPath, 0o755);
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  core.info("cargo-semver-checks installed from release successfully.");
}

function installWithCargo(version: string, cwd: string, toolchain: string): void {
  const args: string[] = [];
  if (toolchain) {
    args.push(`+${toolchain}`);
  }
  args.push("install", "cargo-semver-checks", "--locked");
  if (version && version !== DEFAULT_CARGO_SEMVER_CHECKS_VERSION) {
    args.push("--version", version);
  }

  core.info(`Installing cargo-semver-checks: cargo ${args.join(" ")}`);
  const install = runCommand("cargo", args, { cwd, env: process.env });
  if (install.status !== 0) {
    throw new Error(
      `cargo-semver-checks install failed: ${stripAnsi(
        `${install.stdout || ""}\n${install.stderr || ""}`,
      ).trim()}`,
    );
  }
  core.info("cargo-semver-checks installed successfully.");
}

async function installCargoSemverChecks(
  version: string,
  cwd: string,
  toolchain: string,
  useReleaseBinary: boolean,
): Promise<void> {
  const cargoCheck = runCommand("cargo", ["--version"], { cwd });
  if (cargoCheck.status !== 0) {
    throw new Error("cargo is not available in PATH.");
  }
  core.info(`Cargo version: ${cargoCheck.stdout.trim()}`);

  if (useReleaseBinary) {
    const triple = getTargetTriple();
    if (triple) {
      try {
        await installFromRelease(version);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Failed to install from release: ${message}. Falling back to cargo install.`);
      }
    } else {
      core.info(`No prebuilt binary for ${os.platform()}-${os.arch()}, using cargo install.`);
    }
  }

  installWithCargo(version, cwd, toolchain);
}

interface SemverChecksOptions {
  baseSha: string;
  cwd: string;
  packageName: string;
  toolchain: string;
  featureGroup: string;
  features: string;
  rustTarget: string;
}

function runSemverChecks(options: SemverChecksOptions): CommandResult {
  const { baseSha, cwd, packageName, toolchain, featureGroup, features, rustTarget } = options;
  const env = { ...process.env, CARGO_TERM_COLOR: "always" };
  const args: string[] = [];
  if (toolchain) {
    args.push(`+${toolchain}`);
  }
  args.push("semver-checks", "--baseline-rev", baseSha, "--release-type=patch");
  if (packageName) {
    args.push("-p", packageName);
  } else {
    args.push("--workspace");
  }

  if (featureGroup) {
    if (featureGroup === "all-features") {
      args.push("--all-features");
    } else if (featureGroup === "default-features") {
      args.push("--default-features");
    } else if (featureGroup === "only-explicit-features") {
      args.push("--only-explicit-features");
    }
  }

  if (features) {
    args.push("--features", features);
  }

  if (rustTarget) {
    args.push("--target", rustTarget);
  }

  core.info(`Running: cargo ${args.join(" ")}`);
  core.info("---");

  const result = runCommand("cargo", args, { cwd, env });

  if (result.stdout) {
    core.info(result.stdout);
  }
  if (result.stderr) {
    core.info(result.stderr);
  }

  core.info("---");
  core.info(`Exit code: ${result.status}`);

  return result;
}

function extractRequiredUpdatesFromText(text: string): Set<SemverType> {
  const found = new Set<SemverType>();
  const cleaned = stripAnsi(text);

  const regexes = [/semver requires new (major|minor|patch) version/gi];

  for (const regex of regexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      found.add(match[1].toLowerCase() as SemverType);
    }
  }

  return found;
}

function determineSemverType(result: CommandResult): SemverType {
  const combined = stripAnsi(`${result.stdout || ""}\n${result.stderr || ""}`).trim();

  const requiredUpdates = extractRequiredUpdatesFromText(combined);

  const hasUpdates = requiredUpdates.size > 0;
  const successMessage = /no\s+(semver|public|api)/i.test(combined);

  if (result.status !== 0 && !hasUpdates && !successMessage) {
    throw new Error(`cargo semver-checks failed to produce parseable output:\n${combined}`);
  }

  core.info(`Detected required updates: ${[...requiredUpdates].join(", ") || "none"}`);

  if (requiredUpdates.has("major")) {
    return "major";
  }
  if (requiredUpdates.has("minor")) {
    return "minor";
  }

  return "patch";
}

type Octokit = ReturnType<typeof github.getOctokit>;

type PrContextResolution =
  | { skip: true; reason: string }
  | { skip: false; prNumber: number; baseSha: string };

async function resolvePrContext(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<PrContextResolution> {
  const eventName = github.context.eventName;
  if (core.isDebug()) {
    core.debug(`Event name: ${eventName}`);
  }

  if (eventName === "pull_request") {
    const pr = github.context.payload.pull_request;
    if (!pr) {
      throw new Error("Missing pull_request payload.");
    }

    const baseSha = pr.base?.sha as string | undefined;
    if (!baseSha) {
      throw new Error("Unable to determine the PR base SHA.");
    }

    return { skip: false, prNumber: pr.number, baseSha };
  }

  if (eventName === "workflow_run") {
    const workflowRun = github.context.payload.workflow_run;
    if (!workflowRun) {
      throw new Error("Missing workflow_run payload.");
    }
    if (core.isDebug()) {
      const headRepo = workflowRun.head_repository;
      const headRepoName =
        (headRepo?.full_name as string | undefined) ||
        (headRepo?.name as string | undefined) ||
        "unknown";
      core.debug(
        `workflow_run id=${workflowRun.id || "unknown"} head_sha=${workflowRun.head_sha || "n/a"} head_branch=${workflowRun.head_branch || "n/a"} head_repo=${headRepoName}`,
      );
    }

    const conclusion = workflowRun.conclusion;
    if (conclusion !== "success") {
      const rendered = conclusion ? String(conclusion) : "unknown";
      return {
        skip: true,
        reason: `workflow_run conclusion is ${rendered}; skipping semver checks.`,
      };
    }

    const pullRequests = workflowRun.pull_requests || [];
    let prNumber: number | undefined;
    let baseSha = pullRequests[0]?.base?.sha as string | undefined;

    if (pullRequests.length === 1) {
      prNumber = pullRequests[0]?.number;
    } else if (pullRequests.length === 0) {
      const headRepo = workflowRun.head_repository;
      const headBranch = workflowRun.head_branch as string | undefined;
      const headOwner =
        (headRepo?.owner?.login as string | undefined) ||
        (headRepo?.owner?.name as string | undefined);

      if (headOwner && headBranch) {
        core.info("workflow_run.pull_requests is empty; resolving PR from head repository.");
        const { data: headPRs } = await octokit.rest.pulls.list({
          owner,
          repo,
          head: `${headOwner}:${headBranch}`,
          state: "open",
        });
        if (core.isDebug()) {
          core.debug(`PRs for head ${headOwner}:${headBranch}: ${headPRs.length}`);
        }
        if (headPRs.length === 1) {
          prNumber = headPRs[0]?.number;
          baseSha = headPRs[0]?.base?.sha || baseSha;
        } else if (headPRs.length > 1) {
          throw new Error(`Unable to resolve PR from head ref; found ${headPRs.length}.`);
        }
      }

      if (!prNumber) {
        const headSha = workflowRun.head_sha as string | undefined;
        if (!headSha) {
          throw new Error("workflow_run is missing head_sha.");
        }
        core.info("Resolving PR from head_sha.");
        const { data: associatedPRs } =
          await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
            owner,
            repo,
            commit_sha: headSha,
          });
        if (core.isDebug()) {
          core.debug(`PRs for head_sha ${headSha}: ${associatedPRs.length}`);
        }
        if (associatedPRs.length !== 1) {
          throw new Error(`Unable to resolve PR from head_sha; found ${associatedPRs.length}.`);
        }
        prNumber = associatedPRs[0]?.number;
        baseSha = associatedPRs[0]?.base?.sha || baseSha;
      }
    } else {
      throw new Error(
        `workflow_run must have exactly one pull request, found ${pullRequests.length}.`,
      );
    }

    if (!prNumber) {
      throw new Error("workflow_run pull_request is missing number.");
    }

    if (!baseSha) {
      const { data: prData } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      baseSha = prData.base?.sha || undefined;
    }

    if (!baseSha) {
      throw new Error("Unable to determine the PR base SHA.");
    }

    return { skip: false, prNumber, baseSha };
  }

  throw new Error(`Unsupported event type: ${eventName}`);
}

async function ensureLabelExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  name: string,
): Promise<void> {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name });
    return;
  } catch (error) {
    if (!error || (error as { status?: number }).status !== 404) {
      throw error;
    }
  }

  await octokit.rest.issues.createLabel({
    owner,
    repo,
    name,
    color: "ededed",
    description: "Semver required update",
  });
}

async function removeLabelIfExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  name: string,
): Promise<void> {
  try {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name,
    });
  } catch (error) {
    if (!error || (error as { status?: number }).status !== 404) {
      throw error;
    }
  }
}

async function upsertSemverLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  labelPrefix: string,
  newLabel: string,
): Promise<void> {
  core.info(`Fetching existing labels for issue #${issueNumber}...`);
  const { data: existingLabels } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: issueNumber,
  });

  const existingNames = new Set(existingLabels.map((label) => label.name));
  core.info(
    `Found ${existingLabels.length} existing labels: ${[...existingNames].join(", ") || "(none)"}`,
  );

  if (labelPrefix && labelPrefix.length > 0) {
    for (const label of existingLabels) {
      if (label.name.startsWith(labelPrefix) && label.name !== newLabel) {
        core.info(`Removing old label: ${label.name}`);
        await removeLabelIfExists(octokit, owner, repo, issueNumber, label.name);
      }
    }
  }

  if (!existingNames.has(newLabel)) {
    core.info(`Adding new label: ${newLabel}`);
    await ensureLabelExists(octokit, owner, repo, newLabel);
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [newLabel],
    });
  } else {
    core.info(`Label "${newLabel}" already exists, skipping.`);
  }
}

async function run(): Promise<void> {
  try {
    const cargoVersion =
      core.getInput("cargo-semver-checks-version") || DEFAULT_CARGO_SEMVER_CHECKS_VERSION;
    const useReleaseBinaryInput = core.getInput("use-release-binary");
    const useReleaseBinary = useReleaseBinaryInput === "" || useReleaseBinaryInput === "true";
    const labelPrefix = core.getInput("label-prefix") || DEFAULT_LABEL_PREFIX;
    const githubToken = core.getInput("github-token", { required: true });
    const packageName = core.getInput("package") || "";
    const toolchain = core.getInput("toolchain") || "";
    const featureGroup = core.getInput("feature-group") || "";
    const features = core.getInput("features") || "";
    const rustTarget = core.getInput("rust-target") || "";

    const octokit = github.getOctokit(githubToken);
    const { owner, repo } = github.context.repo;
    const prContext = await withRetries(
      () => resolvePrContext(octokit, owner, repo),
      "Resolve PR context",
    );
    if (prContext.skip) {
      core.info(prContext.reason);
      return;
    }

    const { prNumber, baseSha } = prContext;

    const cwd = process.env.GITHUB_WORKSPACE || process.cwd();

    core.info(`Event: ${github.context.eventName}`);
    core.info(`PR number: ${prNumber}`);
    core.info(`Working directory: ${cwd}`);
    core.info(`PR base SHA: ${baseSha}`);
    core.info(`Use release binary: ${useReleaseBinary}`);
    if (toolchain) {
      core.info(`Toolchain: ${toolchain}`);
    }
    if (packageName) {
      core.info(`Package: ${packageName}`);
    }
    if (featureGroup) {
      core.info(`Feature group: ${featureGroup}`);
    }
    if (features) {
      core.info(`Features: ${features}`);
    }
    if (rustTarget) {
      core.info(`Rust target: ${rustTarget}`);
    }
    core.info("");

    ensureGitShaAvailable(baseSha, cwd);
    await installCargoSemverChecks(cargoVersion, cwd, toolchain, useReleaseBinary);

    core.info("");
    const result = runSemverChecks({
      baseSha,
      cwd,
      packageName,
      toolchain,
      featureGroup,
      features,
      rustTarget,
    });
    const semverType = determineSemverType(result);
    const label = `${labelPrefix}${semverType}`;
    core.info(`Determined semver type: ${semverType}`);

    core.info(`Applying label "${label}" to PR #${prNumber}...`);
    await withRetries(
      () => upsertSemverLabel(octokit, owner, repo, prNumber, labelPrefix, label),
      "Apply semver label",
    );
    core.info(`Label applied successfully.`);

    core.setOutput("semver-type", semverType);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Ignore EPIPE errors (broken stdout/stderr pipe)
    if (!message.includes("EPIPE")) {
      try {
        core.setFailed(message);
      } catch {
        // Ignore errors from setFailed itself
      }
    }
  }
}

run();
