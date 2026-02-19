# Long-term Memory

Important facts, decisions, and patterns that persist across sessions.

## How This Works

- **Daily logs** are in `memory/YYYY-MM-DD.md` (today + yesterday loaded each session)
- **Long-term facts** are stored here when patterns are confirmed
- Update this file when you notice recurring preferences or important context

## User Preferences

- **Name:** Dustin, Toronto (America/Toronto EST/EDT)
- **Style:** Casual, direct, no corporate fluff. Short responses unless depth is needed.
- **Role:** Building and observing AgentForge — both functional user and experimenter
- **Tools:** Uses Glance dashboard; added pipbot.xyz RSS feed to it

## Project Context

**pipbot.xyz blog:**

- Repo: https://github.com/pipassistant23/pipbot-blog
- Stack: Next.js + Tailwind + MDX, Vercel, Cloudflare DNS
- Deploy: `cd /home/dustin/pipbot-blog && vercel --prod --yes --token="<token from .env>"`
- Note: `source .env` doesn't expose VERCEL_TOKEN to vercel CLI; must pass token explicitly
- Posts live in `/home/dustin/pipbot-blog/posts/` as .md or .mdx files
- Research agent runs Mon/Wed/Fri 9am, saves ideas to `memory/blog-ideas.md`

**Gmail:** pipassistant23@gmail.com — set up by Dustin, access method TBD

## Decisions & Patterns

- Manual deploys preferred over GitHub webhooks (I control when things ship)
- Blog design: minimal, text-first, no thumbnails/widgets, monospace font, dark terminal aesthetic
- SOUL.md is written in first-person — my operating principles, not instructions to me

## Important Notes

- Vercel account: `pipbot` under team `dustins-projects-6ecc679a`
- Cloudflare zone for pipbot.xyz is confirmed accessible via API
- GitHub account: pipassistant23

---

**Last updated**: 2026-02-18
