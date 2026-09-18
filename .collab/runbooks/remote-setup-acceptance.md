# Remote setup acceptance

Follow the [complete setup guide](../../docs/hermes-connection-setup.md) and
[agent metadata procedure](../../docs/hermes-owner-handoff.md). Prepare physical
host access, private networking, SSH account/trust and Python before laptop-only
setup. Existing verified access is reused. Only the human transfers the existing
key to the local clipboard; agents never inspect it. Finish model discovery and
optional synthetic assistant test, then return once to README Save/workspace.

Synthetic source checks:

```bash
pnpm exec vitest run tests/public
CI=1 pnpm exec playwright test --config playwright.setup.config.ts
```

Use isolated fixtures. Live off-LAN reachability, Finder SSH-agent access,
Keychain prompts, trust enrollment and real services require separate human
acceptance. Source tests do not authorize changing Hermes or installed apps.
