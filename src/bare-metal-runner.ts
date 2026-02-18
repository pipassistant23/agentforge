/**
 * Bare Metal Runner for AgentForge
 * Spawns agent execution as Node.js processes (no containers)
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENT_MAX_OUTPUT_SIZE,
  AGENT_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---AGENTFORGE_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AGENTFORGE_OUTPUT_END---';

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

/**
 * Setup group session directory with Claude settings and skills
 */
function setupGroupSession(group: RegisteredGroup): string {
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        // Enable agent swarms (subagent orchestration)
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        // Load CLAUDE.md from additional mounted directories
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        // Enable Claude's memory feature
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync skills from skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        const dstFile = path.join(dstDir, file);
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }

  return groupSessionsDir;
}

/**
 * Run agent as baremetal Node.js process
 */
export async function runContainerAgent(
  group: RegisteredGroup,
  input: AgentInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<AgentOutput> {
  const startTime = Date.now();
  const processName = `agentforge-${group.folder}`;

  // Create IPC directories for this group
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });

  // Setup session directory with Claude settings
  setupGroupSession(group);

  // Create logs directory
  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    // Spawn agent as baremetal Node.js process
    const agentProcess = spawn('node', [path.join(process.cwd(), 'agent/agent-runner/dist/index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.join(GROUPS_DIR, group.folder),
      env: {
        // SECURITY: Only pass necessary env vars, exclude sensitive tokens
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: process.env.NODE_ENV,
        LOG_LEVEL: process.env.LOG_LEVEL,
        AGENTFORGE_CHAT_JID: input.chatJid,
        AGENTFORGE_GROUP_FOLDER: input.groupFolder,
        AGENTFORGE_IS_MAIN: input.isMain ? '1' : '0',
        // Point to actual host paths (baremetal, no container mounts)
        WORKSPACE_IPC: groupIpcDir,
        WORKSPACE_GROUP: path.join(GROUPS_DIR, group.folder),
        WORKSPACE_GLOBAL: path.join(GROUPS_DIR, 'global'),
      },
    });

    onProcess(agentProcess, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // SECURITY: Handle spawn errors (file not found, permissions, etc.)
    agentProcess.on('error', (err) => {
      logger.error(
        { group: group.name, error: err, processName },
        'Failed to spawn agent process',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Failed to spawn agent: ${err.message}`,
      });
    });

    // Pass secrets via stdin (never written to disk)
    input.secrets = readSecrets();

    // SECURITY: Check if stdin is available before writing
    if (!agentProcess.stdin) {
      logger.error({ group: group.name, processName }, 'Agent process stdin not available');
      agentProcess.kill();
      resolve({
        status: 'error',
        result: null,
        error: 'Agent process stdin not available',
      });
      return;
    }

    try {
      agentProcess.stdin.write(JSON.stringify(input));
      agentProcess.stdin.end();
    } catch (err) {
      logger.error({ group: group.name, error: err }, 'Failed to write to agent stdin');
      agentProcess.kill();
      resolve({
        status: 'error',
        result: null,
        error: `Failed to write to agent stdin: ${err}`,
      });
      return;
    }

    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    agentProcess.stdout!.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = AGENT_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: AgentOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // SECURITY: Add error handler to prevent unhandled rejections
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.error(
                  { group: group.name, error: err },
                  'Error in output callback, will continue processing',
                );
              });
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    agentProcess.stderr!.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ process: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously
      if (stderrTruncated) return;
      const remaining = AGENT_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Agent stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const configTimeout = group.agentConfig?.timeout || AGENT_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + grace period
    const TIMEOUT_GRACE_PERIOD = parseInt(
      process.env.TIMEOUT_GRACE_PERIOD || '30000',
      10,
    ); // Default: 30 seconds
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + TIMEOUT_GRACE_PERIOD);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, processName }, 'Agent timeout, killing process');
      agentProcess.kill('SIGKILL');
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    agentProcess.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `agent-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Agent Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Process: ${processName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

        // Timeout after output = idle cleanup, not failure
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Agent timed out after output (idle cleanup)',
          );
          outputChain
            .then(() => {
              resolve({
                status: 'success',
                result: null,
                newSessionId,
              });
            })
            .catch((err) => {
              logger.error({ group: group.name, error: err }, 'Error in final output chain');
              resolve({
                status: 'error',
                result: null,
                error: `Output callback error: ${err.message}`,
                newSessionId,
              });
            });
          return;
        }

        logger.error(
          { group: group.name, processName, duration, code },
          'Agent timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
        );
      }

      if (isVerbose || isError) {
        logLines.push(
          `=== Stdout ===`,
          stdout || '(empty)',
          ``,
          `=== Stderr ===`,
          stderr || '(empty)',
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration },
          `Agent process exited with code ${code}`,
        );

        // Wait for output chain to finish before resolving
        outputChain
          .then(() => {
            resolve({
              status: 'error',
              result: null,
              error: `Agent process exited with code ${code}`,
              newSessionId,
            });
          })
          .catch((err) => {
            logger.error({ group: group.name, error: err }, 'Error in final output chain');
            resolve({
              status: 'error',
              result: null,
              error: `Agent exited with code ${code}, output callback error: ${err.message}`,
              newSessionId,
            });
          });
        return;
      }

      logger.info({ group: group.name, code, duration }, 'Agent process completed');

      // Wait for output chain to finish
      outputChain
        .then(() => {
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        })
        .catch((err) => {
          logger.error({ group: group.name, error: err }, 'Error in final output chain');
          resolve({
            status: 'error',
            result: null,
            error: `Output callback error: ${err.message}`,
            newSessionId,
          });
        });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

/**
 * Write available groups snapshot for the agent to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
