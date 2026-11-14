// Preview pages must not dispatch to a host-provided relay before simulation exists.
Object.defineProperty(window, 'lavish', { value: undefined, configurable: false, writable: false });
