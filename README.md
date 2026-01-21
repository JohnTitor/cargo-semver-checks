# Cargo Semver Labeler Action

GitHub Action that runs `cargo-semver-checks` on pull requests, determines the
required semver bump (major/minor/patch), and applies a label to the PR. It
compares the PR head against the PR base SHA with `--baseline-rev`.

## Why not `cargo-semver-checks-action`?

The official [`cargo-semver-checks`](https://github.com/obi1kenobi/cargo-semver-checks-action) action focuses on running checks right before `cargo publish`. This action is specialized for PR workflows:
it compares against the PR base SHA and automatically labels the PR with the
required semver update level.

## Behavior

- Runs `cargo semver-checks --baseline-rev <base_sha>`.
- Picks the highest required update: `major` > `minor` > `patch`.
- Removes existing labels that start with the configured prefix.
- Creates the label if it does not exist.

## Inputs

| Name                          | Required | Default        | Description                                  |
| ----------------------------- | -------- | -------------- | -------------------------------------------- |
| `cargo-semver-checks-version` | false    | `latest`       | Version of `cargo-semver-checks` to install. |
| `label-prefix`                | false    | `semver: `     | Prefix for labels.                           |
| `github-token`                | false    | `github.token` | Token with permission to label PRs.          |

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
      - uses: JohnTitor/cargo-semver-checks@v0.1.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          cargo-semver-checks-version: latest
          label-prefix: "semver: "
```

## Development

```sh
pnpm install
pnpm run build
```
