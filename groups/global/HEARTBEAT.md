# HEARTBEAT.md

**Keep this file empty (or with only comments) to skip heartbeat API calls.**

Add tasks below when you want the agent to check something periodically.

---

## Example Tasks

```
## Every morning at 9am
- Check for critical notifications
- Review pending tasks
- Update daily summary

## Every hour
- Monitor system health
- Check for urgent messages

## Every day at 6pm
- Prepare end-of-day summary
- Archive completed tasks
```

---

## How It Works

1. **Empty file** → No heartbeat calls (monitoring disabled)
2. **Add tasks** → Agent executes at specified intervals
3. **State tracking** → Results stored in `memory/heartbeat-state.json`

Customize intervals and tasks based on your needs.
