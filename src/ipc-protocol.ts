/**
 * Zod schemas for all IPC payload types exchanged between agent processes
 * and the AgentForge host.
 *
 * Agents write JSON files to their group-namespaced IPC directories. This
 * module defines and validates the shape of those files before any field
 * is accessed in ipc.ts. A discriminated union on the `type` field ensures
 * exhaustive handling and precise parse errors on malformed payloads.
 *
 * Message payloads (messages/ subdir):
 *   - `message` - Outbound message from agent to a chat JID
 *
 * Task payloads (tasks/ subdir):
 *   - `schedule_task`  - Create a new scheduled task
 *   - `pause_task`     - Pause an existing task
 *   - `resume_task`    - Resume a paused task
 *   - `cancel_task`    - Delete a task permanently
 *   - `refresh_groups` - Force group metadata sync (main only)
 *   - `register_group` - Activate a new group JID (main only)
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Message payloads (messages/ IPC subdirectory)
// ---------------------------------------------------------------------------

export const MessagePayloadSchema = z.object({
  type: z.literal('message'),
  chatJid: z.string(),
  text: z.string(),
  /** Optional bot identity to use from the pool (Telegram only). */
  sender: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Task payloads (tasks/ IPC subdirectory)
// ---------------------------------------------------------------------------

export const ScheduleTaskSchema = z.object({
  type: z.literal('schedule_task'),
  prompt: z.string(),
  schedule_type: z.enum(['cron', 'interval', 'once']),
  schedule_value: z.string(),
  targetJid: z.string(),
  context_mode: z.enum(['group', 'isolated']).optional(),
});

export const PauseTaskSchema = z.object({
  type: z.literal('pause_task'),
  taskId: z.string(),
});

export const ResumeTaskSchema = z.object({
  type: z.literal('resume_task'),
  taskId: z.string(),
});

export const CancelTaskSchema = z.object({
  type: z.literal('cancel_task'),
  taskId: z.string(),
});

export const RefreshGroupsSchema = z.object({
  type: z.literal('refresh_groups'),
});

export const RegisterGroupSchema = z.object({
  type: z.literal('register_group'),
  jid: z.string(),
  name: z.string(),
  folder: z.string(),
  trigger: z.string(),
  requiresTrigger: z.boolean().optional(),
  agentConfig: z
    .object({
      timeout: z.number().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Discriminated unions
// ---------------------------------------------------------------------------

/**
 * All valid message IPC payloads (messages/ subdirectory).
 * Currently only one type; kept as a union for forward-compatibility.
 */
export const IpcMessagePayloadSchema = z.discriminatedUnion('type', [
  MessagePayloadSchema,
]);
export type IpcMessagePayload = z.infer<typeof IpcMessagePayloadSchema>;

/**
 * All valid task IPC payloads (tasks/ subdirectory).
 */
export const IpcTaskPayloadSchema = z.discriminatedUnion('type', [
  ScheduleTaskSchema,
  PauseTaskSchema,
  ResumeTaskSchema,
  CancelTaskSchema,
  RefreshGroupsSchema,
  RegisterGroupSchema,
]);
export type IpcTaskPayload = z.infer<typeof IpcTaskPayloadSchema>;
