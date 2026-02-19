/**
 * QMD Memory System Setup
 * Initialize QMD collections for a group workspace
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const QMD_BIN = path.join(
  process.cwd(),
  'node_modules',
  '@tobilu',
  'qmd',
  'qmd',
);

interface QMDConfig {
  workspaceDir: string; // /workspace/group
  qmdDataDir: string; // /data/qmd/{groupFolder}
  groupFolder: string;
}

/**
 * Initialize QMD collections for a group.
 * This should be called once per group before using QMD.
 */
export async function initializeQMD(config: QMDConfig): Promise<void> {
  const { workspaceDir, qmdDataDir, groupFolder } = config;

  // Create QMD data directory
  fs.mkdirSync(qmdDataDir, { recursive: true });

  // Set QMD_DB environment variable for this group
  process.env.QMD_DB = path.join(qmdDataDir, 'qmd.db');

  // Create memory directory if it doesn't exist
  const memoryDir = path.join(workspaceDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  // Create conversations directory if it doesn't exist
  const conversationsDir = path.join(workspaceDir, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });

  // Check if collections are already configured
  const collectionsExist = await checkCollectionsExist();
  if (collectionsExist) {
    console.error(`[QMD] Collections already exist for ${groupFolder}`);
    return;
  }

  // Add collections
  console.error(`[QMD] Initializing collections for ${groupFolder}`);

  await addCollection(
    'memory',
    path.join(workspaceDir, 'memory'),
    '**/*.md',
    'Daily logs, topic files, dream cycle briefs - user memory system',
  );

  await addCollection(
    'conversations',
    path.join(workspaceDir, 'conversations'),
    '**/*.md',
    'Archived session transcripts from past conversations',
  );

  await addCollection(
    'workspace',
    workspaceDir,
    '*.md',
    'Workspace files including AGENTS.md and other docs',
  );

  console.error(`[QMD] Collections initialized for ${groupFolder}`);
}

/**
 * Check if collections already exist in the database
 */
async function checkCollectionsExist(): Promise<boolean> {
  try {
    const result = await runQMD(['collection', 'list', '--json']);
    const collections = JSON.parse(result);
    return Array.isArray(collections) && collections.length > 0;
  } catch (err) {
    // If command fails, assume no collections exist
    return false;
  }
}

/**
 * Add a collection to QMD
 */
async function addCollection(
  name: string,
  dirPath: string,
  mask: string,
  context: string,
): Promise<void> {
  try {
    await runQMD([
      'collection',
      'add',
      dirPath,
      '--name',
      name,
      '--mask',
      mask,
    ]);

    // Add context description
    await runQMD(['context', 'add', `qmd://${name}`, context]);

    console.error(`[QMD]   ✓ Added collection: ${name} (${dirPath})`);
  } catch (err) {
    console.error(
      `[QMD]   ✗ Failed to add collection ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run QMD command and return stdout
 */
function runQMD(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(QMD_BIN, args, {
      env: {
        ...process.env,
        // QMD_DB is already set in process.env
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`QMD command failed: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Get QMD environment variables for SDK MCP server
 */
export function getQMDEnvironment(qmdDataDir: string): Record<string, string> {
  return {
    QMD_DB: path.join(qmdDataDir, 'qmd.db'),
    QMD_MODELS_PATH:
      process.env.QMD_MODELS_PATH ||
      path.join(process.cwd(), 'data', 'qmd', 'models'),
  };
}
