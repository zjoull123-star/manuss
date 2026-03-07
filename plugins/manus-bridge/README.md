# manus-bridge

OpenClaw bridge plugin for delegating long-running tasks to the local `openclaw-manus` runtime.

## What it does

- Registers `/task`, `/task-status`, and `/approve-task`
- Registers optional agent tools:
  - `manus_submit_task`
  - `manus_task_status`
  - `manus_approve_task`
- Polls the `openclaw-manus` API and pushes task completion / approval updates back to the original conversation

## Install in OpenClaw

```bash
openclaw plugins install -l /absolute/path/to/openclaw-manus/plugins/manus-bridge
openclaw plugins enable manus-bridge
```

Replace the plugin path with the location of your local repository checkout.

## Recommended config

```json5
{
  plugins: {
    entries: {
      "manus-bridge": {
        enabled: true,
        config: {
          apiBaseUrl: "http://127.0.0.1:3000",
          pollIntervalMs: 5000,
          autoReplyOnCompletion: true,
          enableCommands: true
        }
      }
    }
  }
}
```

## Runtime expectations

- `openclaw-manus` API should be running on the configured `apiBaseUrl`
- For auto callbacks, the task must be created with `origin.replyMode = "auto_callback"`
- First-pass auto callback is implemented for `whatsapp`, `telegram`, and `slack`
