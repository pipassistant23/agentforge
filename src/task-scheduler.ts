/**
 * Scheduled task runner for AgentForge.
 *
 * Polls the database for due tasks and runs them as agent processes via
 * the bare-metal runner. Each task gets its own agent invocation with
 * either a fresh isolated session or the group's existing conversation
 * session, depending on the task's context_mode.
 *
 * Results are forwarded to the target group's chat and logged to the DB.
 */
import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  AgentOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './bare-metal-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/** Dependencies injected into the scheduler to decouple it from the orchestrator. */
export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    processName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

/**
 * Execute a single scheduled task as an agent process.
 *
 * Looks up the registered group for the task, writes a tasks snapshot
 * so the agent can read its own schedule, then runs the agent via the
 * bare-metal runner. Streaming results are forwarded to the user in real
 * time via `deps.sendMessage`.
 *
 * An idle timer closes stdin after IDLE_TIMEOUT of no output — this causes
 * the agent to exit cleanly rather than hanging at its IPC poll loop.
 *
 * After the run, the result and next_run timestamp are persisted to the DB.
 * One-time tasks ("once" schedule type) have no next_run and are marked
 * "completed" by `updateTaskAfterRun`.
 *
 * @param task - The scheduled task record to execute
 * @param deps - Scheduler dependencies (sessions, queue, send)
 */
async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    const groupNotFoundError = `Group not found: ${task.group_folder}`;
    try {
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'error',
        result: null,
        error: groupNotFoundError,
      });
    } catch (logErr) {
      logger.warn({ taskId: task.id, err: logErr }, 'Failed to write task run log');
    }
    // Still advance the schedule so the task doesn't loop on every poll
    let nextRun: string | null = null;
    if (task.schedule_type === 'cron') {
      const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
      nextRun = interval.next().toISOString();
    } else if (task.schedule_type === 'interval') {
      nextRun = new Date(Date.now() + parseInt(task.schedule_value, 10)).toISOString();
    }
    updateTaskAfterRun(task.id, nextRun, `Error: ${groupNotFoundError}`);
    return;
  }

  // Update tasks snapshot for agent to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // 'group' context mode reuses the group's live conversation session,
  // giving the agent access to chat history. 'isolated' always starts fresh.
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // Idle timer: closes stdin after IDLE_TIMEOUT of no streaming output,
  // so the agent exits rather than waiting indefinitely for IPC messages.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { taskId: task.id },
        'Scheduled task idle timeout, closing process stdin',
      );
      deps.queue.closeStdin(task.chat_jid);
    }, IDLE_TIMEOUT);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
      },
      (proc, processName) =>
        deps.onProcess(task.chat_jid, proc, processName, task.group_folder),
      async (streamedOutput: AgentOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          // Only reset idle timer on actual results, not session-update markers
          resetIdleTimer();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (idleTimer) clearTimeout(idleTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  try {
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: error ? 'error' : 'success',
      result,
      error,
    });
  } catch (logErr) {
    // Log write failure (e.g. FK constraint when a task was deleted mid-run)
    // must not prevent next_run from advancing — otherwise the task loops forever.
    logger.warn(
      { taskId: task.id, err: logErr },
      'Failed to write task run log; schedule will still advance',
    );
  }

  // Compute next run time for recurring tasks; null signals "completed" to updateTaskAfterRun
  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

/** Prevents startSchedulerLoop from being called more than once. */
let schedulerRunning = false;

/**
 * Start the scheduler polling loop.
 *
 * On each tick, queries the DB for tasks whose `next_run` is in the past,
 * re-checks each task's status (in case it was paused since the query),
 * then enqueues it through the GroupQueue so it runs serially with any
 * concurrent message-driven agent invocations for the same group.
 *
 * @param deps - Scheduler dependencies including queue and session state
 */
export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled between
        // the getDueTasks query and here — avoid running stale tasks
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
