# Lavish HTTP boundary

The foreground hub uses the packaged, patched Lavish 0.1.97 runtime. Before use it checks the server health response, version, page-review capability, and canonical state identity. A responding incompatible server on the selected port is rejected rather than replaced. The default is port 4388 and `${XDG_STATE_HOME:-$HOME/.local/state}/lavish-kit/lavish`; `LAVISH_AXI_PORT` and `LAVISH_AXI_STATE_DIR` override them.

The owner is the sole consumer of its page's feedback. A failed consuming poll is not retried because the server may have consumed the batch. See [feedback and actions](feedback-routing.md) and [hub](hub.md) for the observable behavior and delivery guarantees. The package does not use a global Lavish executable or provide a general Lavish CLI passthrough.
