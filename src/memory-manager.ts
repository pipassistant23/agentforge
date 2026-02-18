/**
 * Memory management utilities for AgentForge's daily log system
 */

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';

/**
 * Get the current date in YYYY-MM-DD format
 */
function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get yesterday's date in YYYY-MM-DD format
 */
function getYesterdayDate(): string {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0];
}

/**
 * Get the path to a group's memory directory
 */
export function getMemoryDir(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'memory');
}

/**
 * Get the path to today's memory log
 */
export function getTodaysMemoryPath(groupFolder: string): string {
  const memoryDir = getMemoryDir(groupFolder);
  return path.join(memoryDir, `${getTodayDate()}.md`);
}

/**
 * Get the path to yesterday's memory log
 */
export function getYesterdaysMemoryPath(groupFolder: string): string {
  const memoryDir = getMemoryDir(groupFolder);
  return path.join(memoryDir, `${getYesterdayDate()}.md`);
}

/**
 * Ensure memory directory exists for a group
 */
export function ensureMemoryDir(groupFolder: string): void {
  const memoryDir = getMemoryDir(groupFolder);
  fs.mkdirSync(memoryDir, { recursive: true });
}

/**
 * Initialize today's memory log if it doesn't exist
 */
export function initTodaysMemoryLog(groupFolder: string): void {
  ensureMemoryDir(groupFolder);
  const todayPath = getTodaysMemoryPath(groupFolder);

  if (!fs.existsSync(todayPath)) {
    const today = getTodayDate();
    const template = `# ${today}

## Summary

(Daily summary - updated throughout the day)

## Conversations

`;
    fs.writeFileSync(todayPath, template, 'utf-8');
  }
}

/**
 * Append an entry to today's memory log
 */
export function appendToTodaysMemory(
  groupFolder: string,
  content: string,
): void {
  ensureMemoryDir(groupFolder);
  initTodaysMemoryLog(groupFolder);

  const todayPath = getTodaysMemoryPath(groupFolder);
  const timestamp = new Date().toISOString();
  const entry = `\n### ${timestamp}\n\n${content}\n`;

  fs.appendFileSync(todayPath, entry, 'utf-8');
}

/**
 * Read today's memory log
 */
export function readTodaysMemory(groupFolder: string): string | null {
  const todayPath = getTodaysMemoryPath(groupFolder);
  if (!fs.existsSync(todayPath)) {
    return null;
  }
  return fs.readFileSync(todayPath, 'utf-8');
}

/**
 * Read yesterday's memory log
 */
export function readYesterdaysMemory(groupFolder: string): string | null {
  const yesterdayPath = getYesterdaysMemoryPath(groupFolder);
  if (!fs.existsSync(yesterdayPath)) {
    return null;
  }
  return fs.readFileSync(yesterdayPath, 'utf-8');
}

/**
 * Get memory context for session startup (today + yesterday)
 */
export function getMemoryContext(groupFolder: string): {
  today: string | null;
  yesterday: string | null;
} {
  return {
    today: readTodaysMemory(groupFolder),
    yesterday: readYesterdaysMemory(groupFolder),
  };
}

/**
 * Clean up old memory logs (keep last N days)
 */
export function cleanupOldMemoryLogs(
  groupFolder: string,
  keepDays: number = 30,
): void {
  const memoryDir = getMemoryDir(groupFolder);
  if (!fs.existsSync(memoryDir)) {
    return;
  }

  const now = new Date();
  const cutoffDate = new Date(now);
  cutoffDate.setDate(cutoffDate.getDate() - keepDays);

  const files = fs.readdirSync(memoryDir);
  for (const file of files) {
    const match = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (match) {
      const fileDate = new Date(match[1]);
      if (fileDate < cutoffDate) {
        fs.unlinkSync(path.join(memoryDir, file));
      }
    }
  }
}
