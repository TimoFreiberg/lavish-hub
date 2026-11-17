# PR drafts

Use `lavish-kit hub pr --file FILE` to attach a PR draft and `lavish-kit hub pr --rev REV` to configure its head. The first line of the draft must be `# ` followed by a nonempty title; the remaining lines are the body.

Configure Create PR in `${XDG_CONFIG_HOME:-$HOME/.config}/lavish-kit/config.json`. Set `createPr` to a nonempty array of command arguments, for example:

```json
{"createPr": ["your-pr-command"]}
```

The hub appends `-r`, the resolved full commit ID, `--body-file`, and the draft path. Configure a command that accepts those arguments. The hub saves the draft and records the launch attempt before opening the command. See [hub](hub.md) for launch behavior and recovery after an uncertain acknowledgement.
