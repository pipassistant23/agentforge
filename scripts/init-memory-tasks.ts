/**
 * Initialize Dream Cycle and Morning Brief tasks
 * Run once to set up automated memory consolidation
 */

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'store', 'messages.db');
const MAIN_GROUP_FOLDER = 'main';
// TODO: Get this from Telegram bot info or user DM
const MAIN_DM_CHAT_ID =
  process.env.MAIN_DM_CHAT_ID || 'YOUR_TELEGRAM_DM_CHAT_ID';

const TIMEZONE = process.env.DREAM_CYCLE_TIMEZONE || 'America/New_York';

// Dream cycle: 11:30 PM Eastern
// Eastern is UTC-5 (EST) or UTC-4 (EDT)
// 11:30 PM EST = 4:30 AM UTC next day (winter)
// 11:30 PM EDT = 3:30 AM UTC next day (summer)
// Use winter schedule, system timezone will handle DST
const DREAM_CYCLE_CRON = '30 4 * * *'; // 4:30 AM UTC = 11:30 PM EST

// Morning brief: 8:00 AM Eastern
// 8:00 AM EST = 1:00 PM UTC (winter)
// 8:00 AM EDT = 12:00 PM UTC (summer)
const MORNING_BRIEF_CRON = '0 13 * * *'; // 1:00 PM UTC = 8:00 AM EST

const getTodayDate = () => new Date().toISOString().split('T')[0];

const DREAM_CYCLE_PROMPT = `You are running the nightly dream cycle. Your job is memory maintenance, not conversation.

1. Read today's daily file: memory/${getTodayDate()}.md
2. Search recent session transcripts for anything discussed but never saved to memory
3. Look for connections across recent days (patterns, related threads, recurring themes)
4. Check CLAUDE.md size — if it's drifted above ~500 tokens (~2000 chars), trim it:
   - Move detail that belongs in memory/ topic files
   - Keep only orientation-level summaries and active focus bullets
   - Update pointers if files moved
5. If any "active focus" items in CLAUDE.md are done or stale, move them to daily/topic files
6. Write a brief to memory/briefs/${getTodayDate()}.md with:
   - What happened today (2-3 sentences)
   - Connections spotted (if any)
   - What's on deck for tomorrow
   - Any memory maintenance done

Keep the brief conversational and short.
Read memory/conventions.md if you need the full rationale for these rules.

<internal>
This is the dream cycle. Do not send any output to the user. All work is internal.
</internal>`;

const MORNING_BRIEF_PROMPT = `You are delivering the user's morning brief. Be conversational, not corporate. Like a sharp friend catching them up.

1. Read the most recent file in memory/briefs/ (last night's dream cycle output)
   - If none exists, read the most recent memory/*.md instead
2. Read CLAUDE.md for active focus areas

Deliver a brief that covers:
- Quick recap of yesterday (1-2 lines)
- What's on deck today
- Any connections or ideas from the dream cycle
- One thing worth thinking about (optional, only if genuinely interesting)

Tone: warm, direct, casual. Not a status report.
Start with something natural, not "Good morning!" every time. Mix it up.
Keep it under 150 words unless there's genuinely a lot to cover.`;

function initTasks() {
  const db = new Database(DB_PATH);

  console.log(`Initializing memory tasks for ${MAIN_GROUP_FOLDER}...`);
  console.log(`Timezone: ${TIMEZONE}`);
  console.log(`Dream cycle cron: ${DREAM_CYCLE_CRON}`);
  console.log(`Morning brief cron: ${MORNING_BRIEF_CRON}`);

  // Calculate next run times
  const dreamCycleNextRun = CronExpressionParser.parse(DREAM_CYCLE_CRON, {
    tz: TIMEZONE,
  })
    .next()
    .toISOString();

  const morningBriefNextRun = CronExpressionParser.parse(MORNING_BRIEF_CRON, {
    tz: TIMEZONE,
  })
    .next()
    .toISOString();

  console.log(`Next dream cycle: ${dreamCycleNextRun}`);
  console.log(`Next morning brief: ${morningBriefNextRun}`);

  // Check if tasks already exist
  const existingDreamCycle = db
    .prepare('SELECT id FROM scheduled_tasks WHERE id = ?')
    .get('dream-cycle');
  const existingMorningBrief = db
    .prepare('SELECT id FROM scheduled_tasks WHERE id = ?')
    .get('morning-brief');

  // Dream cycle task
  if (existingDreamCycle) {
    console.log('Dream cycle task already exists, updating...');
    db.prepare(
      `UPDATE scheduled_tasks
       SET prompt = ?, schedule_value = ?, next_run = ?, context_mode = ?
       WHERE id = ?`,
    ).run(
      DREAM_CYCLE_PROMPT,
      DREAM_CYCLE_CRON,
      dreamCycleNextRun,
      'isolated',
      'dream-cycle',
    );
  } else {
    console.log('Creating dream cycle task...');
    db.prepare(
      `INSERT INTO scheduled_tasks
       (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'dream-cycle',
      MAIN_GROUP_FOLDER,
      MAIN_DM_CHAT_ID,
      DREAM_CYCLE_PROMPT,
      'cron',
      DREAM_CYCLE_CRON,
      'isolated',
      dreamCycleNextRun,
      'active',
      new Date().toISOString(),
    );
  }

  // Morning brief task
  if (existingMorningBrief) {
    console.log('Morning brief task already exists, updating...');
    db.prepare(
      `UPDATE scheduled_tasks
       SET prompt = ?, schedule_value = ?, next_run = ?, context_mode = ?
       WHERE id = ?`,
    ).run(
      MORNING_BRIEF_PROMPT,
      MORNING_BRIEF_CRON,
      morningBriefNextRun,
      'isolated',
      'morning-brief',
    );
  } else {
    console.log('Creating morning brief task...');
    db.prepare(
      `INSERT INTO scheduled_tasks
       (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'morning-brief',
      MAIN_GROUP_FOLDER,
      MAIN_DM_CHAT_ID,
      MORNING_BRIEF_PROMPT,
      'cron',
      MORNING_BRIEF_CRON,
      'isolated',
      morningBriefNextRun,
      'active',
      new Date().toISOString(),
    );
  }

  db.close();
  console.log('Memory tasks initialized successfully!');
  console.log('');
  console.log('Next steps:');
  console.log('1. Set MAIN_DM_CHAT_ID in .env with your Telegram DM chat ID');
  console.log(
    '2. Set DREAM_CYCLE_TIMEZONE in .env (default: America/New_York)',
  );
  console.log(
    '3. Restart the service: sudo systemctl restart agentforge.service',
  );
}

initTasks();
