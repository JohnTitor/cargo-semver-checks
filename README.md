# Cargo Semver Labeler Action

GitHub Action that runs `cargo-semver-checks` on pull requests, determines the
required semver bump (major/minor/patch), and applies a label to the PR. It
compares the PR head against the PR base SHA with `--baseline-rev`.

## Why not `cargo-semver-checks-action`?

The official [`cargo-semver-checks`](https://github.com/obi1kenobi/cargo-semver-checks-action) action focuses on running checks right before `cargo publish`.
This action is specialized for PR workflows:
it compares against the PR base SHA and automatically labels the PR with the
required semver update level.

This also supports running on the `workflow_run` event which is better than `pull_request_target` for security on OSS repos.

## Behavior

- Runs `cargo semver-checks --baseline-rev <base_sha> --workspace` by default.
- If `package` input is specified, runs with `-p <package>` instead of `--workspace`.
- If `toolchain` input is specified, runs with `cargo +<toolchain>` (e.g. `cargo +nightly`).
- Picks the highest required update: `major` > `minor` > `patch`.
- Removes existing labels that start with the configured prefix.
- Creates the label if it does not exist.

## Inputs

| Name                          | Required | Default        | Description                                                                    |
| ----------------------------- | -------- | -------------- | ------------------------------------------------------------------------------ |
| `cargo-semver-checks-version` | false    | `latest`       | Version of `cargo-semver-checks` to install.                                   |
| `use-release-binary`          | false    | `true`         | Install from GitHub release tarball instead of `cargo install`.                |
| `label-prefix`                | false    | `semver: `     | Prefix for labels.                                                             |
| `github-token`                | false    | `github.token` | Token with permission to label PRs.                                            |
| `package`                     | false    |                | Specific package to check (checks all if not set).                             |
| `toolchain`                   | false    |                | Rust toolchain to use (e.g. `nightly`, `stable`).                              |
| `feature-group`               | false    |                | Feature group to enable (`all-features`, `default-features`, `only-explicit`). |
| `features`                    | false    |                | Comma-separated list of features to enable.                                    |
| `rust-target`                 | false    |                | Rust target to build for (e.g. `aarch64-apple-darwin`).                        |

## Outputs

| Name          | Description                                         |
| ------------- | --------------------------------------------------- |
| `semver-type` | Detected update type: `major`, `minor`, or `patch`. |

## Usage

```yaml
name: Semver Label

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  semver-label:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: JohnTitor/cargo-semver-checks@v0.2.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          cargo-semver-checks-version: latest
          label-prefix: "semver: "
```

### Using `workflow_run`

Run this action after another workflow completes (for example, after CI), and use
the workflow run's head SHA for checkout:

```yaml
name: Semver Label (post CI)

on:
  workflow_run:
    workflows: [CI]
    types: [completed]

jobs:
  semver-label:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
      - uses: JohnTitor/cargo-semver-checks@v0.2.0
```

Notes:

- The action runs only when `workflow_run.conclusion` is `success`.
- The triggering workflow must be associated with exactly one PR (the action
  errors if zero or multiple PRs are found).

### Checking a specific package

```yaml
- uses: JohnTitor/cargo-semver-checks@v0.2.0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    package: my-crate
```

### Using a specific toolchain

```yaml
- uses: JohnTitor/cargo-semver-checks@v0.2.0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    toolchain: nightly
```

### Enabling specific features

```yaml
- uses: JohnTitor/cargo-semver-checks@v0.2.0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    features: feature1,feature2
```

### Using a feature group

```yaml
- uses: JohnTitor/cargo-semver-checks@v0.2.0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    feature-group: all-features
```

### Building for a specific target

```yaml
- uses: JohnTitor/cargo-semver-checks@v0.2.0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    rust-target: aarch64-apple-darwin
```

### Using `cargo install` instead of pre-built binaries

By default, the action downloads pre-built binaries from GitHub releases for faster installation.
If you prefer to build from source using `cargo install`, set `use-release-binary` to `false`:

```yaml
- uses: JohnTitor/cargo-semver-checks@v0.2.0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    use-release-binary: false
```

**Note:** The action automatically falls back to `cargo install` if:

- No pre-built binary is available for the platform
- The download fails for any reason

## Development

```sh
pnpm install
pnpm run build
```
