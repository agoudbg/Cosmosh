# Local Terminal Usage

Use local terminal sessions for quick command execution without opening external shells.

## Typical Workflow

1. Open local terminal from workspace entry.
2. Run local-only commands (build, checks, scripts).
3. Keep remote operations in SSH sessions.
4. Close local terminal when the task ends.

## Good Practices

1. Avoid mixing unrelated tasks in one long-lived local session.
2. Name or label session context clearly when multiple terminals are open.
3. Run destructive commands only after directory/path confirmation.
4. Close idle sessions to keep workspace focused.

## Common Mistakes

1. Running remote-intended commands in local terminal by mistake.
2. Keeping stale terminals open and losing task context.
3. Executing destructive commands from the wrong working directory.
