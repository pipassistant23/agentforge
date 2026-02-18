/**
 * IPC watcher and task dispatcher for AgentForge.
 *
 * Agents communicate back to the host by writing JSON files to their
 * group-namespaced IPC directories. This module polls those directories
 * and executes the requested actions (send messages, manage tasks,
 * register groups) with authorization checks enforced by directory identity.
 *
 * Directory layout:
 *   /data/ipc/{groupFolder}/messages/*.json  - outbound messages to users
 *   /data/ipc/{groupFolder}/tasks/*.json     - task management and group registration
 *   /data/ipc/errors/                        - files that failed to process
 */
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TELEGRAM_BOT_POOL,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './bare-metal-runner.js';
import { sendPoolMessage } from './channels/telegram.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/** Dependencies injected into the IPC watcher to decouple it from the orchestrator. */
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

/** Prevents startIpcWatcher from being called more than once. */
let ipcWatcherRunning = false;

/**
 * Start the polling loop that processes IPC files from agent processes.
 *
 * Scans all group subdirectories under the IPC base directory on each tick,
 * processing message and task files in sequence. Authorization is derived
 * from the directory the file was found in — agents cannot spoof another
 * group's identity by putting a different groupFolder in the file payload.
 *
 * Files that fail to process are moved to `errors/` rather than deleted,
 * preserving them for debugging without blocking the loop.
 *
 * @param deps - Host services the watcher can call (send, register, sync)
 */
export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid.
                // Main group can send to any JID; others can only send to their own.
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Route through bot pool if sender is specified and it's a Telegram chat.
                  // This gives sub-agents their own named bot identity in the conversation.
                  if (
                    data.sender &&
                    data.chatJid.startsWith('tg:') &&
                    TELEGRAM_BOT_POOL.length > 0
                  ) {
                    await sendPoolMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      sourceGroup,
                    );
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

/**
 * Dispatch a single task IPC payload, enforcing authorization before acting.
 *
 * Supported actions:
 * - `schedule_task`  - Create a new scheduled task (non-main can only target self)
 * - `pause_task`     - Pause an active task (non-main can only pause own tasks)
 * - `resume_task`    - Resume a paused task (non-main can only resume own tasks)
 * - `cancel_task`    - Delete a task permanently (non-main can only cancel own tasks)
 * - `refresh_groups` - Force a group metadata sync (main only)
 * - `register_group` - Activate a new group JID (main only, with input validation)
 *
 * Authorization is based on `sourceGroup` (the directory the file came from),
 * NOT any group identifier inside the file payload.
 *
 * @param data - The parsed IPC payload
 * @param sourceGroup - Group folder that wrote the file (the verified identity)
 * @param isMain - Whether sourceGroup is the main orchestrator group
 * @param deps - Host services for group registration and metadata sync
 */
export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    agentConfig?: RegisteredGroup['agentConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        // Calculate the first next_run timestamp from the schedule expression
        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      // Validate required fields
      if (!data.jid || !data.name || !data.folder || !data.trigger) {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
        break;
      }

      // SECURITY: Validate folder name to prevent path traversal
      const folderRegex = /^[a-z0-9][a-z0-9_-]*$/;
      if (!folderRegex.test(data.folder)) {
        logger.error(
          { folder: data.folder, sourceGroup },
          'Invalid folder name - must be alphanumeric with hyphens/underscores only',
        );
        break;
      }

      // Validate JID format (Telegram: tg:-12345, WhatsApp: phone@s.whatsapp.net or groupid@g.us)
      const jidRegex = /^(tg:-?\d+|[\w.+-]+@[\w.+-]+)$/;
      if (!jidRegex.test(data.jid)) {
        logger.error({ jid: data.jid, sourceGroup }, 'Invalid JID format');
        break;
      }

      // Validate name length
      if (data.name.length > 100) {
        logger.error(
          { nameLength: data.name.length, sourceGroup },
          'Invalid name - exceeds 100 characters',
        );
        break;
      }

      deps.registerGroup(data.jid, {
        name: data.name,
        folder: data.folder,
        trigger: data.trigger,
        added_at: new Date().toISOString(),
        agentConfig: data.agentConfig,
        requiresTrigger: data.requiresTrigger,
      });
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
