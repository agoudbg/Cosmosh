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

## Orbit Bar

- Select terminal text to show Orbit Bar near the current selection.
- Use Orbit Bar actions for quick copy and search workflows.
- Search behavior follows the Settings search engine configuration.
- If Orbit Bar is not needed, disable it from Settings > Terminal.

## Tab Switching

- Press Ctrl+Tab (Control+Tab on macOS) to open the tab switcher.
- Keep holding Ctrl/Control and press Tab repeatedly to move forward through tabs.
- Hold Shift while pressing Tab to move backward.
- While the switcher is open, use ArrowUp/ArrowDown to preview targets.
- Release Ctrl/Control to confirm and jump to the selected tab.
- Mouse click on a tab in the switcher jumps immediately, even if Ctrl/Control is still held.

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
