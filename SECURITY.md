# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in AgentForge, please report it by:

1. **Email:** Send details to the repository maintainer
2. **Private advisory:** Use GitHub's private vulnerability reporting feature
3. **Do NOT** open a public issue for security vulnerabilities

We aim to respond to security reports within 48 hours.

## Known Dependencies with Advisories

### @tobilu/qmd -> node-llama-cpp -> cmake-js -> tar

**Status:** No fix available
**Severity:** High (not critical)
**Location:** agent-runner-src/package.json only (not in orchestrator)
**Impact:** Build-time dependency only, affects agent-runner module
**CVSS:** Various tar vulnerabilities (file overwrite, symlink poisoning, path traversal)

**Mitigations:**

- These vulnerabilities affect the `tar` package used during build/installation
- They do **not** affect AgentForge's runtime security
- The `tar` package is not used in production code
- Risk is limited to development/build environments
- AgentForge does not extract untrusted tar archives
- Main orchestrator does not include this dependency (isolated to agent-runner)

**Tracking:**

- Upstream fix required in `@tobilu/qmd` package
- Monitoring: https://github.com/advisories/GHSA-8qq5-rm4j-mr97
- Alternative QMD implementations may be considered in future releases

## Security Hardening (v1.0.0+)

AgentForge v1.0.0 includes the following security enhancements:

1. **Path Traversal Prevention**
   - Strict validation of group folder names
   - Regex whitelist: `/^[a-z0-9][a-z0-9_-]*$/`

2. **Input Validation**
   - All IPC messages validated before processing
   - JID format enforcement
   - Name length limits

3. **Secrets Isolation**
   - Agent processes receive minimal environment variables
   - Sensitive tokens (TELEGRAM_BOT_TOKEN) excluded from agent env
   - API keys passed via stdin, never via environment

4. **Process Error Handling**
   - Comprehensive error handlers on process spawn
   - Promise rejection handling in output chains
   - Graceful degradation on failures

5. **Filesystem Isolation**
   - Per-group workspaces with strict boundaries
   - No shared state between groups
   - IPC directory separation

## Security Best Practices

### Deployment

- Run AgentForge as a non-root user
- Use systemd for process isolation
- Restrict filesystem permissions on `/data/` directory
- Keep Node.js and system packages updated
- Monitor logs for suspicious activity

### Configuration

- Use strong, unique bot tokens
- Rotate API keys regularly
- Limit group registrations to trusted users
- Enable audit logging in production

### Agent Execution

- Agents run in isolated workspaces
- No network access to host services by default
- Limited resource usage per agent
- Automatic timeout on long-running tasks

## Audit Schedule

- **npm audit:** Runs on every PR and weekly via GitHub Actions
- **CodeQL:** Available when code scanning is enabled in repository settings
- **Manual review:** Before major releases

## Changelog

### v1.0.0 (2026-02-18)

- Initial security hardening
- Path traversal prevention
- Secrets isolation
- Comprehensive error handling
- Input validation on all IPC messages

---

Last updated: 2026-02-18
