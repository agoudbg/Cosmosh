# SSH Session Basics

## Start a Session

1. Select the target server profile.
2. Start SSH session.
3. Wait for terminal prompt readiness.
4. Run a harmless verification command.

## During a Session

1. Keep one task context per active session.
2. Resize terminal when layout changes to avoid broken command views.
3. Prefer explicit command sequencing over long interactive drift.
4. Record important command outputs before switching sessions.

## Trust and Verification

- Review host fingerprint prompts carefully.
- Trust only verified hosts.

## End Session Safely

1. Complete or cancel running commands cleanly.
2. Exit remote shell.
3. Confirm session is fully closed in UI.
4. If reconnect is required, start a new clean session instead of reusing stale context.

## Common Mistakes

1. Connecting to the wrong environment due to similar host names.
2. Skipping fingerprint verification under time pressure.
3. Leaving sessions open unintentionally after task completion.
