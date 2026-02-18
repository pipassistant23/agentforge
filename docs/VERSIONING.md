# Versioning Policy

AgentForge follows [Semantic Versioning 2.0.0](https://semver.org/).

---

## Version Format

```
MAJOR.MINOR.PATCH
```

Examples: `1.0.0`, `1.4.2`, `2.0.0`, `2.1.0-beta.1`

All three components are non-negative integers. Leading zeros are not permitted.

---

## When to Increment Each Component

### MAJOR

Increment MAJOR when a change breaks backward compatibility for users who fork and run AgentForge. Reset MINOR and PATCH to zero.

Triggers:

- Removing or renaming a configuration key that users are expected to set in `.env` or `groups/{name}/AGENTS.md`
- Changing the IPC message format in a way that requires updating `agent-runner-src/` and the host simultaneously
- Dropping support for a Node.js LTS version currently listed in `engines` in `package.json`
- Removing a feature that existed in the previous stable release (e.g., removing scheduled tasks support)
- Changing the SQLite schema in a way that requires a manual migration (no automatic migration provided)
- Renaming or moving key files that users are told to edit (`groups/{name}/AGENTS.md`, `.env`, systemd unit)

Example: `1.4.2` → `2.0.0`

### MINOR

Increment MINOR when new functionality is added in a backward-compatible manner. Reset PATCH to zero.

Triggers:

- New IPC message types that are handled gracefully by old agent-runner versions
- New optional environment variables in `.env`
- New skills added to `.claude/skills/`
- New MCP tools exposed to agents
- New Telegram features or bot pool capabilities that do not change existing behavior
- Adding new npm scripts that do not change existing scripts
- Performance improvements that do not change observable behavior

Example: `1.3.0` → `1.4.0`

### PATCH

Increment PATCH when backward-compatible bug fixes are made.

Triggers:

- Fixing a crash or error in message routing, IPC, or the agent runner
- Correcting a security vulnerability without changing the interface
- Fixing incorrect log output or spurious error messages
- Documentation corrections (typos, broken links, outdated examples)
- Dependency version bumps for security patches (patch-level dep bumps only)

Example: `1.4.1` → `1.4.2`

---

## Pre-Release Versions

Pre-release versions signal instability. They are appended to the base version with a hyphen.

```
MAJOR.MINOR.PATCH-LABEL.N
```

| Label | Meaning | Example |
|-------|---------|---------|
| `alpha` | Early preview; may be incomplete or broken | `2.0.0-alpha.1` |
| `beta` | Feature-complete; known issues may exist | `2.0.0-beta.1` |
| `rc` | Release candidate; no known blocking issues | `2.0.0-rc.1` |

Rules:

- Pre-release versions have lower precedence than the associated normal version. `2.0.0-rc.1 < 2.0.0`.
- Increment the numeric suffix (`N`) for each successive pre-release at the same label: `beta.1`, `beta.2`, `beta.3`.
- Pre-release versions should not be used as a base for stable PATCH releases. Cut a stable release instead.
- The `main` branch may receive pre-release tags but must always be deployable.

---

## Version Tagging in Git

Every release (including pre-releases) gets a git tag.

### Tag Format

```
v{MAJOR}.{MINOR}.{PATCH}
v{MAJOR}.{MINOR}.{PATCH}-{LABEL}.{N}
```

Examples: `v1.0.0`, `v1.4.2`, `v2.0.0-beta.1`

### Creating a Tag

Always tag the exact commit that was tested and released. Annotated tags are required; they record the tagger, date, and release notes summary.

```bash
# Create an annotated tag
git tag -a v1.1.0 -m "Release v1.1.0: add Telegram bot pool support"

# Push the tag to the remote
git push origin v1.1.0
```

Do not force-push or delete tags after they have been pushed to the remote. If a release is found to be broken, cut a new PATCH release instead.

### Listing Tags

```bash
git tag --list 'v*' --sort=-version:refname | head -10
```

---

## Backward Compatibility Rules

### What Users Are Shielded From

The following are considered public interface and must not break across MINOR and PATCH releases:

| Interface | Notes |
|-----------|-------|
| `.env` variable names | New optional variables may be added; existing names must not be renamed |
| `groups/{name}/AGENTS.md` file location | Agents depend on this path for group instructions |
| `groups/global/AGENTS.md`, `SOUL.md`, `TOOLS.md` file locations | Global template files synced to each group |
| Systemd unit name `agentforge.service` | Users configure this in scripts |
| IPC directory structure under `/data/ipc/` | Agent runner reads from here |
| `npm run build` / `npm test` / `npm start` scripts | Documented developer commands |

### What Is Internal and May Change

- The internal structure of `dist/` (compiled output)
- SQLite table schemas, provided an automatic migration is included
- The content or format of log output
- Internal TypeScript types not exported as a public API
- Files under `node_modules/`

### Deprecation

Before removing a public interface in a MAJOR release:

1. Mark it deprecated in a MINOR release. Add a warning to the relevant documentation and, where possible, emit a logged warning at runtime.
2. Keep it functional for at least one MINOR release cycle.
3. Remove it in the next MAJOR release.

Document all deprecations in `CHANGELOG.md` under the `Deprecated` section.
