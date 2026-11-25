const actions = {
  reconnect: ['NO_OWNER', 'OWNER_UNREACHABLE', 'LAVISH_CONNECTION_ERROR', 'SESSION_ENDED', 'NOT_FOUND', 'LISTENER_ACTIVE', 'LISTENER_REPLACED', 'UNSUPPORTED_LAVISH', 'LAVISH_STATE_MISMATCH'],
  refresh: ['WORKSPACE_UNAVAILABLE', 'BATCH_CONTEXT_UNAVAILABLE', 'UNKNOWN_VIEW', 'TARGET_CONFLICT'],
  check_delivery: ['AMBIGUOUS_DELIVERY', 'REPLY_DELIVERY_UNCERTAIN', 'BATCH_ALREADY_REPLIED'],
  fix_args: ['USAGE_ERROR', 'VALIDATION_ERROR', 'BATCH_NOT_FOUND'],
  retry: ['LAVISH_HTTP_ERROR'],
};
const actionFor = code => Object.entries(actions).find(([, codes]) => codes.includes(code))?.[0];

export class HubError extends Error {
  constructor(code, action, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HubError';
    this.code = code;
    this.action = action;
  }
}

export function classifyError(error) {
  if (error instanceof HubError) return error;
  const message = error?.message || String(error);
  let code = error?.ambiguousDelivery ? 'AMBIGUOUS_DELIVERY' : error?.code;
  if (!actionFor(code)) {
    if (error?.name === 'UsageError') code = 'USAGE_ERROR';
    else if (/workspace (is )?unavailable|repository is unavailable/i.test(message)) code = 'WORKSPACE_UNAVAILABLE';
    else if (/unknown view/i.test(message)) code = 'UNKNOWN_VIEW';
    else if (/target.*conflict/i.test(message)) code = 'TARGET_CONFLICT';
    else if (/validation|invalid/i.test(message)) code = 'VALIDATION_ERROR';
    else code = 'LAVISH_HTTP_ERROR';
  }
  return new HubError(code, actionFor(code), message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message, error);
}

export function formatHubError(error) {
  const classified = classifyError(error);
  return `lavish-hub: [${classified.code}] action=${classified.action} — ${classified.message}`;
}
