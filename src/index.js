const core = require("@actions/core");
const github = require("@actions/github");
const { spawnSync } = require("child_process");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_CARGO_SEMVER_CHECKS_VERSION = "latest";
const DEFAULT_LABEL_PREFIX = "semver: ";
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");
const GITHUB_RELEASES_BASE = "https://github.com/obi1kenobi/cargo-semver-checks/releases";

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });

  if (result.error) {
    throw new Error(`Failed to run "${command} ${args.join(" ")}": ${result.error.message}`);
  }

  return result;
}

function stripAnsi(input) {
  return input.replace(ANSI_ESCAPE_REGEX, "");
}

function ensureGitShaAvailable(sha, cwd) {
  core.info(`Checking if base SHA ${sha} is available...`);
  const check = runCommand("git", ["cat-file", "-e", `${sha}^{commit}`], {
    cwd,
  });
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

function getTargetTriple() {
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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        httpsGet(response.headers.location).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

async function getLatestVersion() {
  const url = `${GITHUB_RELEASES_BASE}/latest`;
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
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

async function installFromRelease(version) {
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

function installWithCargo(version, cwd, toolchain) {
  const args = [];
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

async function installCargoSemverChecks(version, cwd, toolchain, useReleaseBinary) {
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
        core.warning(
          `Failed to install from release: ${error.message}. Falling back to cargo install.`,
        );
      }
    } else {
      core.info(`No prebuilt binary for ${os.platform()}-${os.arch()}, using cargo install.`);
    }
  }

  installWithCargo(version, cwd, toolchain);
}

function runSemverChecks(baseSha, cwd, packageName, toolchain) {
  const env = { ...process.env, CARGO_TERM_COLOR: "always" };
  const args = [];
  if (toolchain) {
    args.push(`+${toolchain}`);
  }
  args.push("semver-checks", "--baseline-rev", baseSha);
  if (packageName) {
    args.push("-p", packageName);
  } else {
    args.push("--workspace");
  }

  core.info(`Running: cargo ${args.join(" ")}`);
  core.info("---");

  const result = runCommand("cargo", args, { cwd, env });

  // Log stdout and stderr
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

function extractRequiredUpdatesFromText(text) {
  const found = new Set();
  const cleaned = stripAnsi(text);

  const regexes = [/semver requires new (major|minor|patch) version/gi];

  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(cleaned)) !== null) {
      found.add(match[1].toLowerCase());
    }
  }

  return found;
}

function determineSemverType(result) {
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
  if (requiredUpdates.has("patch")) {
    return "patch";
  }

  return "patch";
}

async function ensureLabelExists(octokit, owner, repo, name) {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name });
    return;
  } catch (error) {
    if (!error || error.status !== 404) {
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

async function removeLabelIfExists(octokit, owner, repo, issueNumber, name) {
  try {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name,
    });
  } catch (error) {
    if (!error || error.status !== 404) {
      throw error;
    }
  }
}

async function upsertSemverLabel(octokit, owner, repo, issueNumber, labelPrefix, newLabel) {
  const { data: existingLabels } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: issueNumber,
  });

  const existingNames = new Set(existingLabels.map((label) => label.name));

  if (labelPrefix && labelPrefix.length > 0) {
    for (const label of existingLabels) {
      if (label.name.startsWith(labelPrefix) && label.name !== newLabel) {
        await removeLabelIfExists(octokit, owner, repo, issueNumber, label.name);
      }
    }
  }

  if (!existingNames.has(newLabel)) {
    await ensureLabelExists(octokit, owner, repo, newLabel);
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [newLabel],
    });
  }
}

async function run() {
  try {
    const cargoVersion =
      core.getInput("cargo-semver-checks-version") || DEFAULT_CARGO_SEMVER_CHECKS_VERSION;
    const useReleaseBinaryInput = core.getInput("use-release-binary");
    const useReleaseBinary = useReleaseBinaryInput === "" || useReleaseBinaryInput === "true";
    const labelPrefix = core.getInput("label-prefix") || DEFAULT_LABEL_PREFIX;
    const githubToken = core.getInput("github-token", { required: true });
    const packageName = core.getInput("package") || "";
    const toolchain = core.getInput("toolchain") || "";

    const pr = github.context.payload.pull_request;
    if (!pr) {
      throw new Error("This action must run on pull_request events.");
    }

    const baseSha = pr.base && pr.base.sha;
    if (!baseSha) {
      throw new Error("Unable to determine the PR base SHA.");
    }

    const cwd = process.env.GITHUB_WORKSPACE || process.cwd();

    core.info(`Working directory: ${cwd}`);
    core.info(`PR base SHA: ${baseSha}`);
    core.info(`Use release binary: ${useReleaseBinary}`);
    if (toolchain) {
      core.info(`Toolchain: ${toolchain}`);
    }
    if (packageName) {
      core.info(`Package: ${packageName}`);
    }
    core.info("");

    ensureGitShaAvailable(baseSha, cwd);
    await installCargoSemverChecks(cargoVersion, cwd, toolchain, useReleaseBinary);

    core.info("");
    const result = runSemverChecks(baseSha, cwd, packageName, toolchain);
    const semverType = determineSemverType(result);
    const label = `${labelPrefix}${semverType}`;
    core.info(`Determined semver type: ${semverType}`);

    const octokit = github.getOctokit(githubToken);
    const { owner, repo } = github.context.repo;

    await upsertSemverLabel(octokit, owner, repo, pr.number, labelPrefix, label);

    core.setOutput("semver-type", semverType);
    core.info(`Applied label "${label}" to PR #${pr.number}.`);
  } catch (error) {
    core.setFailed(error && error.message ? error.message : String(error));
  }
}

run();
