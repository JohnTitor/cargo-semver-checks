const core = require('@actions/core');
const github = require('@actions/github');
const { spawnSync } = require('child_process');

const DEFAULT_CARGO_SEMVER_CHECKS_VERSION = 'latest';
const DEFAULT_LABEL_PREFIX = 'semver: ';

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });

  if (result.error) {
    throw new Error(
      `Failed to run "${command} ${args.join(' ')}": ${result.error.message}`
    );
  }

  return result;
}

function stripAnsi(input) {
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

function ensureGitShaAvailable(sha, cwd) {
  const check = runCommand('git', ['cat-file', '-e', `${sha}^{commit}`], {
    cwd,
  });
  if (check.status === 0) {
    return;
  }

  const fetch = runCommand(
    'git',
    ['fetch', '--no-tags', '--depth=1', 'origin', sha],
    { cwd }
  );
  if (fetch.status !== 0) {
    throw new Error(
      `Failed to fetch base SHA ${sha}: ${stripAnsi(
        `${fetch.stdout || ''}\n${fetch.stderr || ''}`
      ).trim()}`
    );
  }
}

function installCargoSemverChecks(version, cwd) {
  const cargoCheck = runCommand('cargo', ['--version'], { cwd });
  if (cargoCheck.status !== 0) {
    throw new Error('cargo is not available in PATH.');
  }

  const args = ['install', 'cargo-semver-checks', '--locked'];
  if (version && version !== DEFAULT_CARGO_SEMVER_CHECKS_VERSION) {
    args.push('--version', version);
  }

  const install = runCommand('cargo', args, { cwd, env: process.env });
  if (install.status !== 0) {
    throw new Error(
      `cargo-semver-checks install failed: ${stripAnsi(
        `${install.stdout || ''}\n${install.stderr || ''}`
      ).trim()}`
    );
  }
}

function isUnsupportedJsonFlag(output) {
  const lowered = output.toLowerCase();
  return (
    (lowered.includes('unknown argument') ||
      lowered.includes('unexpected argument') ||
      lowered.includes('unrecognized option') ||
      lowered.includes('found argument')) &&
    lowered.includes('output') &&
    lowered.includes('format')
  );
}

function runSemverChecks(baseSha, cwd) {
  const env = { ...process.env, CARGO_TERM_COLOR: 'never' };
  const baseArgs = ['semver-checks', '--baseline-rev', baseSha];
  const jsonArgs = [...baseArgs, '--output-format', 'json'];

  let result = runCommand('cargo', jsonArgs, { cwd, env });
  const combined = stripAnsi(
    `${result.stdout || ''}\n${result.stderr || ''}`
  ).trim();

  if (result.status !== 0 && isUnsupportedJsonFlag(combined)) {
    core.info('JSON output is not supported; rerunning without it.');
    result = runCommand('cargo', baseArgs, { cwd, env });
  }

  return result;
}

function tryParseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return null;
  }
}

function extractRequiredUpdatesFromJson(payload) {
  const found = new Set();

  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (
          /required[-_]?update/i.test(key) &&
          typeof nested === 'string'
        ) {
          found.add(nested.toLowerCase());
        }
        visit(nested);
      }
      return;
    }

    if (typeof value === 'string') {
      const match = value.match(
        /required[-_ ]update\s*[:=]\s*(major|minor|patch)/i
      );
      if (match) {
        found.add(match[1].toLowerCase());
      }
    }
  };

  visit(payload);
  return found;
}

function extractRequiredUpdatesFromText(text) {
  const found = new Set();
  const cleaned = stripAnsi(text);

  const regexes = [
    /required[-_ ]update\s*[:=]\s*(major|minor|patch)/gi,
    /requires a (major|minor|patch) version bump/gi,
    /requires (major|minor|patch) version bump/gi,
    /required update\s*\((major|minor|patch)\)/gi,
    /requires (major|minor|patch) bump/gi,
  ];

  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(cleaned)) !== null) {
      found.add(match[1].toLowerCase());
    }
  }

  return found;
}

function determineSemverType(result) {
  const combined = stripAnsi(
    `${result.stdout || ''}\n${result.stderr || ''}`
  ).trim();

  const jsonPayload = tryParseJson(combined);
  const requiredUpdates = jsonPayload
    ? extractRequiredUpdatesFromJson(jsonPayload)
    : extractRequiredUpdatesFromText(combined);

  const hasUpdates = requiredUpdates.size > 0;
  const successMessage = /no\s+(semver|public|api)/i.test(combined);

  if (result.status !== 0 && !hasUpdates && !successMessage) {
    throw new Error(
      `cargo semver-checks failed to produce parseable output:\n${combined}`
    );
  }

  if (requiredUpdates.has('major')) {
    return 'major';
  }
  if (requiredUpdates.has('minor')) {
    return 'minor';
  }
  if (requiredUpdates.has('patch')) {
    return 'patch';
  }

  return 'patch';
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
    color: 'ededed',
    description: 'Semver required update',
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

async function upsertSemverLabel(
  octokit,
  owner,
  repo,
  issueNumber,
  labelPrefix,
  newLabel
) {
  const { data: existingLabels } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: issueNumber,
  });

  const existingNames = new Set(existingLabels.map((label) => label.name));

  if (labelPrefix && labelPrefix.length > 0) {
    for (const label of existingLabels) {
      if (label.name.startsWith(labelPrefix) && label.name !== newLabel) {
        await removeLabelIfExists(
          octokit,
          owner,
          repo,
          issueNumber,
          label.name
        );
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
      core.getInput('cargo-semver-checks-version') ||
      DEFAULT_CARGO_SEMVER_CHECKS_VERSION;
    const labelPrefix =
      core.getInput('label-prefix') || DEFAULT_LABEL_PREFIX;
    const githubToken = core.getInput('github-token', { required: true });

    const pr = github.context.payload.pull_request;
    if (!pr) {
      throw new Error('This action must run on pull_request events.');
    }

    const baseSha = pr.base && pr.base.sha;
    if (!baseSha) {
      throw new Error('Unable to determine the PR base SHA.');
    }

    const cwd = process.env.GITHUB_WORKSPACE || process.cwd();

    ensureGitShaAvailable(baseSha, cwd);
    installCargoSemverChecks(cargoVersion, cwd);

    const result = runSemverChecks(baseSha, cwd);
    const semverType = determineSemverType(result);
    const label = `${labelPrefix}${semverType}`;

    const octokit = github.getOctokit(githubToken);
    const { owner, repo } = github.context.repo;

    await upsertSemverLabel(
      octokit,
      owner,
      repo,
      pr.number,
      labelPrefix,
      label
    );

    core.setOutput('semver-type', semverType);
    core.info(`Applied label "${label}" to PR #${pr.number}.`);
  } catch (error) {
    core.setFailed(error && error.message ? error.message : String(error));
  }
}

run();
