# Release Process

This document is the authoritative checklist for cutting an AgentForge release. Work through every section in order. Do not skip steps.

See [VERSIONING.md](./VERSIONING.md) for the rules that govern when to increment MAJOR, MINOR, or PATCH.

---

## 1. Pre-Release Testing

Complete all checks before proceeding to the version bump.

### 1.1 Verify the build is clean

```bash
npm run build
```

The build must produce no TypeScript errors. Fix any errors before continuing.

### 1.2 Run the test suite

```bash
npm test
```

All tests must pass. A failing test suite is a release blocker.

### 1.3 Run type checking independently

```bash
npm run typecheck
```

### 1.4 Verify code formatting

```bash
npm run format:check
```

If this fails, run `npm run format` and commit the result before continuing.

### 1.5 Check the service starts cleanly

```bash
sudo systemctl restart agentforge.service
sleep 5
sudo systemctl status agentforge.service
```

The status must show `active (running)`. Check logs if it is not:

```bash
sudo journalctl -u agentforge.service -n 50
```

### 1.6 Verify the agent runner builds

```bash
cd agent-runner-src && npm run build
```

Confirm `agent-runner-src/dist/index.js` is up to date.

### 1.7 Smoke test against a live Telegram group

Send a test message to a registered group and confirm the agent responds. This step cannot be automated and must be done manually.

---

## 2. Version Bump

### 2.1 Determine the new version

Consult [VERSIONING.md](./VERSIONING.md) to determine whether this is a MAJOR, MINOR, or PATCH release.

Current version is in `package.json`. Pre-release versions follow the form `1.2.0-beta.1`.

### 2.2 Update package.json

Use `npm version` to update `package.json` without creating a git commit yet (the `--no-git-tag-version` flag prevents npm from tagging prematurely):

```bash
# For a patch release:
npm version patch --no-git-tag-version

# For a minor release:
npm version minor --no-git-tag-version

# For a major release:
npm version major --no-git-tag-version

# For a pre-release:
npm version prerelease --preid=beta --no-git-tag-version
# or set it explicitly:
npm version 2.0.0-rc.1 --no-git-tag-version
```

Verify the version field in `package.json` reflects the new version.

### 2.3 Update agent-runner-src/package.json (if changed)

If the agent runner has changed, bump its version to match:

```bash
cd agent-runner-src
npm version <new-version> --no-git-tag-version
cd ..
```

---

## 3. Changelog

### 3.1 Review commits since the last release

```bash
# Find the last release tag
git tag --list 'v*' --sort=-version:refname | head -1

# List commits since that tag
git log v1.0.0..HEAD --oneline
```

If there is no previous tag, list all commits: `git log --oneline`.

### 3.2 Update CHANGELOG.md

Move the contents of the `[Unreleased]` section into a new versioned section.

The section header format is:

```markdown
## [1.1.0] - 2026-02-18
```

Use today's date in `YYYY-MM-DD` format.

Under the new section, organize entries into the appropriate subsections:

- **Added** - new features
- **Changed** - changes to existing functionality
- **Deprecated** - features that will be removed in a future MAJOR release
- **Removed** - features removed in this release
- **Fixed** - bug fixes
- **Security** - security fixes

After moving entries, add a new empty `[Unreleased]` section at the top.

Update the comparison links at the bottom of `CHANGELOG.md`:

```markdown
[Unreleased]: https://github.com/your-org/agentforge/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/your-org/agentforge/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/your-org/agentforge/releases/tag/v1.0.0
```

---

## 4. Commit the Release

Stage only the files that were changed as part of the release:

```bash
git add package.json CHANGELOG.md
# Include agent-runner-src/package.json if it was bumped
git add agent-runner-src/package.json
```

Create the release commit:

```bash
git commit -m "chore: release v1.1.0"
```

---

## 5. Git Tagging

Create an annotated tag on the release commit. The tag message should be a one-line summary of the most significant change.

```bash
git tag -a v1.1.0 -m "Release v1.1.0: brief summary of changes"
```

Push the commit and tag together:

```bash
git push origin main
git push origin v1.1.0
```

Confirm the tag appears on the remote:

```bash
git ls-remote --tags origin | grep v1.1.0
```

---

## 6. GitHub Release

Create a GitHub release from the tag:

```bash
gh release create v1.1.0 \
  --title "v1.1.0" \
  --notes-file <(sed -n '/^## \[1.1.0\]/,/^## \[/p' CHANGELOG.md | head -n -1)
```

Or create it through the GitHub web UI at `https://github.com/your-org/agentforge/releases/new`.

For pre-releases, add the `--prerelease` flag:

```bash
gh release create v2.0.0-beta.1 --prerelease --title "v2.0.0-beta.1 (beta)"
```

### Release notes content

The release notes must include:

1. A short prose summary (1-3 sentences) of what this release delivers.
2. The full changelog entries for this version, copied from `CHANGELOG.md`.
3. Upgrade instructions if the release contains breaking changes.

---

## 7. Post-Release Verification

### 7.1 Confirm the tag is visible on GitHub

Visit `https://github.com/your-org/agentforge/releases` and confirm the new release appears.

### 7.2 Pull the tag on a clean checkout (optional but recommended for MAJOR releases)

```bash
git clone https://github.com/your-org/agentforge.git /tmp/agentforge-verify
cd /tmp/agentforge-verify
git checkout v1.1.0
npm install
npm run build
npm test
```

### 7.3 Verify the running service version

After deploying to production, confirm the running process is the new version:

```bash
# Check dist/ build time vs. service start time
ls -la dist/index.js
sudo systemctl status agentforge.service
```

The dist file modification time must be after the service start time. If not, restart the service:

```bash
sudo systemctl restart agentforge.service
```

---

## 8. Rollback Procedure

Use this procedure if a release must be reverted after deployment.

### 8.1 Identify the last good version

```bash
git tag --list 'v*' --sort=-version:refname | head -5
```

### 8.2 Check out the last good tag

```bash
git checkout v1.0.0
```

### 8.3 Rebuild from the previous version

```bash
npm install
npm run build
cd agent-runner-src && npm install && npm run build && cd ..
```

### 8.4 Restart the service

```bash
sudo systemctl restart agentforge.service
sudo systemctl status agentforge.service
```

### 8.5 Verify the rollback

Send a test message and confirm the agent responds correctly.

### 8.6 Document the rollback

Open an issue or note in `CHANGELOG.md` under `[Unreleased]` describing what went wrong and what the fix will be. Do not delete the broken release tag; add a note to the GitHub release instead.

### 8.7 Return to main

Once the issue is resolved:

```bash
git checkout main
```

Fix the issue, run through the full release process again, and cut a new PATCH version.
