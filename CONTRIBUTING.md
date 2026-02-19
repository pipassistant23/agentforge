# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

## Skills

A [skill](https://code.claude.com/docs/en/skills) is a markdown file in `.claude/skills/` that teaches Claude Code how to transform an AgentForge installation.

A PR that contributes a skill should not modify any source files.

Your skill should contain the **instructions** Claude follows to add the feature—not pre-built code. See `/convert-to-docker` for a good example.

### Why?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

### Testing

Test your skill by running it on a fresh clone before submitting.

---

## Versioning and Changelog

AgentForge uses [Semantic Versioning](https://semver.org/). The full policy is in [docs/VERSIONING.md](docs/VERSIONING.md).

### Contributors do not bump the version

Do not modify the `version` field in `package.json` in your pull request. Version numbers are assigned by the maintainer at release time.

### Changelog entries are required for source code changes

Every pull request that changes source code (i.e., anything under `src/` or `agent-runner-src/`) must include an entry in the `[Unreleased]` section of `CHANGELOG.md`.

**How to add an entry:**

1. Open `CHANGELOG.md`.
2. Find the `## [Unreleased]` section at the top.
3. Add a concise, present-tense bullet point under the appropriate subsection:
   - **Added** - a new feature or behavior
   - **Changed** - a change to existing behavior
   - **Deprecated** - something that will be removed in a future release
   - **Removed** - something that was removed
   - **Fixed** - a bug fix
   - **Security** - a security fix or hardening change

**Example entry:**

```markdown
## [Unreleased]

### Fixed

- Prevent duplicate messages being sent when the agent runner restarts mid-task.
```

Keep entries short (one or two sentences). Focus on what changed from the user's perspective, not the implementation details.

### Changelog entries are not required for skill-only PRs

Pull requests that only add or modify files in `.claude/skills/` do not need a changelog entry. Skills are user-installable extensions, not changes to the core platform.

### Commit message style

Follow the [Conventional Commits](https://www.conventionalcommits.org/) format used throughout this repository:

```
<type>: <short summary>
```

Common types: `feat`, `fix`, `docs`, `chore`, `test`, `ci`, `security`, `refactor`.

Examples:

- `fix: prevent infinite message replay on container timeout`
- `feat: add requiresTrigger option per registered group`
- `docs: correct systemd restart command in RELEASE_PROCESS.md`
