# Status-line integration

`agentyard` persists the current selection at `~/.agentyard/state.json`. Any
status line that can shell out — tmux's `status-right`, starship, p10k, a
custom PS1 — can read that file and show which agent session you are
pointed at, without going through the MCP host.

This is the out-of-band counterpart to the in-band `→ adapter/id (title): `
header the host LLM is instructed to emit. The status line tells you which
session you're *about* to talk to; the in-band header tells you which one
you *just* talked to.

## The state file

When a session is selected, `state.json` looks like:

```json
{
  "version": 1,
  "selected": {
    "adapter": "aoe",
    "id": "09c118b3df9f4d53",
    "title": "fender-evals"
  }
}
```

When no session is pinned, `selected` is `null` (or the file is absent
entirely on a fresh install). `title` is the session label captured at
pin time. It can go mildly stale if the adapter renames the session
out-of-band; the routing identity is `adapter/id`.

## Helper script

The status-line integrations below all call one tiny helper, so the
format lives in one place. Drop this on your `PATH`:

```bash
#!/usr/bin/env bash
# ~/bin/agentyard-status
# Prints a single line describing the currently-selected agentyard session,
# or nothing when none is pinned. Exits 0 either way.
set -eu
state="${AGENTYARD_STATE_PATH:-$HOME/.agentyard/state.json}"
[ -r "$state" ] || exit 0
jq -r '
  if .selected
  then "▶ " + (.selected.title // .selected.id) + " (" + .selected.adapter + ")"
  else empty
  end
' "$state" 2>/dev/null || true
```

`chmod +x ~/bin/agentyard-status` and confirm with `agentyard-status` in a
shell.

## tmux

Append the helper's output to `status-right`. Refresh interval is the only
knob worth tuning — `status-interval 2` keeps it responsive without
hammering the file.

```tmux
# ~/.tmux.conf
set -g status-interval 2
set -ga status-right ' #(agentyard-status)'
```

If your `status-right` is already crowded, prefix with a separator that
collapses when the helper prints nothing (e.g. `#(agentyard-status |
sed 's/^/  │ /')`).

## starship

Custom module — `when` filters out the empty case so the segment hides
when nothing is pinned.

```toml
# ~/.config/starship.toml
[custom.agentyard]
command = "agentyard-status"
when = "test -s ${AGENTYARD_STATE_PATH:-$HOME/.agentyard/state.json}"
format = "[$output]($style) "
style = "yellow"
```

Add `${custom.agentyard}` to your prompt format wherever you want it to
render.

## Plain bash/zsh PS1

If you don't run starship or p10k, the helper composes directly into
`PROMPT_COMMAND`:

```bash
# ~/.zshrc or ~/.bashrc
precmd() { __ayd="$(agentyard-status)"; }
# Then in your PS1/PROMPT, reference $__ayd where you want it.
```

## Verifying

After installing, pin a session via the MCP host (or by hand:
`echo '{"version":1,"selected":{"adapter":"aoe","id":"abc","title":"demo"}}'
> ~/.agentyard/state.json`) and confirm the status line updates. Clear it
(`select_session` with `clear: true`, or `rm ~/.agentyard/state.json`) and
confirm the segment hides.
