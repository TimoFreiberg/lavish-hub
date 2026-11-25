import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { createSdkJs } from "../src/server.js";

// The SDK the browser actually runs is a serialized bundle, not the module: `createSdkJs` has to
// declare every helper `createArtifactSdk` reaches for. A helper left out compiles fine and only
// ReferenceErrors on the first click, so these tests boot the served bundle and drive the real
// annotation path through a DOM stub instead of inspecting the module directly.

function createElement(tag) {
  const attributes = new Map();
  const queried = new Map();
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    style: {},
    value: "",
    innerHTML: "",
    textContent: "",
    offsetWidth: 100,
    offsetHeight: 100,
    hidden: false,
    listeners: [],
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    matches(selectorList) {
      return String(selectorList)
        .split(",")
        .some((part) => {
          const selector = part.trim();
          // `tag`, `[attr]`, or `tag[attr]` (e.g. `a[href]`): enough selector for what the SDK asks.
          const bracket = selector.indexOf("[");
          const tag = bracket >= 0 ? selector.slice(0, bracket) : selector;
          if (tag && tag !== element.tagName.toLowerCase()) return false;
          return bracket < 0 || attributes.has(selector.slice(bracket + 1, selector.indexOf("]")).split("=")[0]);
        });
    },
    closest(selectorList) {
      let current = element;
      while (current) {
        if (current.matches(selectorList)) return current;
        current = current.parentElement;
      }
      return null;
    },
    // The real `contains` is true for the node itself and every descendant, which is how the SDK
    // asks whether a mutation landed on, above, or inside something it watches.
    contains(node) {
      let current = node;
      while (current) {
        if (current === element) return true;
        current = current.parentElement;
      }
      return false;
    },
    appendChild(child) {
      child.parentElement = element;
      element.children.push(child);
      return child;
    },
    remove() {
      const index = element.parentElement?.children.indexOf(element) ?? -1;
      if (index >= 0) element.parentElement.children.splice(index, 1);
    },
    // Card internals are looked up by class after innerHTML is assigned, so hand back a stable
    // stub per selector: the test drives the very buttons the SDK wired up.
    querySelector(selector) {
      if (!queried.has(selector)) queried.set(selector, createElement(selector.replace(/^[.#]/, "")));
      return queried.get(selector);
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 };
    },
    addEventListener(type, handler) {
      element.listeners.push({ type, handler });
    },
    removeEventListener() {},
    focus() {},
    click() {},
    scrollIntoView() {},
    attachShadow() {
      const shadowRoot = createElement("shadow-root");
      // A new Reveal drops the previous marker by querying the shadow root for its class, so that
      // query answers with the markers actually appended there.
      shadowRoot.querySelectorAll = (selector) =>
        selector === ".lavish-reveal-marker"
          ? shadowRoot.children.filter((child) => child.className === "lavish-reveal-marker")
          : [];
      element.shadowRoot = shadowRoot;
      return shadowRoot;
    },
  };
  return element;
}

function appendTo(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function cell(tag, text) {
  const element = createElement(tag);
  element.textContent = text;
  return element;
}

// Resolves the `tag#id:nth-of-type(n) > ...` chains `selector()` emits against the stub tree, so a
// test can ask the SDK how many elements its own selector matches.
function queryChildChain(root, selectorText) {
  const parts = String(selectorText)
    .split(">")
    .map((part) => part.trim());
  const parsed = parts.map((part) => {
    const match = /^([a-z0-9-]+)(?:#([^:]+))?(?::nth-of-type\((\d+)\))?$/i.exec(part);
    return match ? { tag: match[1].toUpperCase(), id: match[2], nth: match[3] ? Number(match[3]) : null } : null;
  });
  if (parsed.some((part) => !part)) return [];
  const matchesPart = (node, part) => {
    if (!node || node.tagName !== part.tag) return false;
    if (part.id !== undefined && node.id !== part.id) return false;
    if (part.nth !== null) {
      const same = (node.parentElement?.children || []).filter((x) => x.tagName === node.tagName);
      if (same.indexOf(node) + 1 !== part.nth) return false;
    }
    return true;
  };
  const results = [];
  const visit = (node) => {
    let current = node;
    let ok = true;
    for (let index = parsed.length - 1; index >= 0; index -= 1) {
      if (!matchesPart(current, parsed[index])) {
        ok = false;
        break;
      }
      current = current.parentElement;
    }
    if (ok) results.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return results;
}

function bootSdk({
  runAnimationFrames = false,
  revisionsScript = null,
  revisionMarkElements = [],
  htmlAnnotate = null,
  platform = "Linux",
  structuralQueries = false,
  // Mermaid diagrams the page will report to `findMermaidSvgs`. A diagram's `.mermaid` container
  // is recovered through `closest`, so the query for one answers the other.
  mermaidSvgs = [],
  sdkOptions = undefined,
  origin = "http://127.0.0.1",
} = {}) {
  const posted = [];
  const documentListeners = [];
  // Deferred work the SDK schedules, run only when a test asks for it: the draft-anchor settle
  // re-query is a real timer, and asserting on it means running it rather than assuming it.
  const timers = [];
  const resizeObservers = [];
  const mutationObservers = [];
  const scheduleTimer = (fn, ms) => timers.push({ fn, ms }) && timers.length;
  const cancelTimer = (id) => {
    if (timers[id - 1]) timers[id - 1].cancelled = true;
  };
  /** @type {(selector: string) => any} */
  let documentQuery = () => null;
  /** @type {any} */
  let selection = null;
  const documentElement = createElement("html");
  const head = createElement("head");
  const body = createElement("body");
  if (htmlAnnotate !== null) documentElement.setAttribute("data-lavish-annotate", htmlAnnotate);
  appendTo(documentElement, head);
  appendTo(documentElement, body);
  for (const element of revisionMarkElements) appendTo(body, element);

  const sandbox = {
    parent: { postMessage: (message) => posted.push(message) },
    navigator: { platform },
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    MutationObserver: class MutationObserver {
      constructor(callback) {
        this.callback = callback;
        mutationObservers.push(this);
      }

      observe(target, options) {
        this.target = target;
        this.options = options;
      }
      disconnect() {}
    },
    ResizeObserver: class ResizeObserver {
      constructor(callback) {
        this.callback = callback;
        this.observed = [];
        resizeObservers.push(this);
      }

      observe(target) {
        this.observed.push(target);
      }

      disconnect() {
        this.observed = [];
      }
    },
    URL: class extends URL {
      static createObjectURL() {
        return "blob:lavish-test";
      }
      static revokeObjectURL() {}
    },
    URLSearchParams,
    getComputedStyle: () => ({}),
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: (fn) => (runAnimationFrames ? scheduleTimer(fn, 0) : 0),
    document: {
      readyState: "complete",
      currentScript: { src: "http://127.0.0.1/sdk.js?key=abc" },
      documentElement,
      head,
      body,
      activeElement: body,
      baseURI: "http://127.0.0.1/artifact/abc/index.html",
      addEventListener: (type, handler) => documentListeners.push({ type, handler }),
      removeEventListener() {},
      createElement,
      getElementById: () => null,
      querySelector: (selector) =>
        selector === "script[data-lavish-revisions]" ? revisionsScript : documentQuery(selector),
      querySelectorAll: (selector) =>
        selector === "svg"
          ? mermaidSvgs
          : selector === ".mermaid"
            ? mermaidSvgs.map((svg) => svg.closest(".mermaid")).filter(Boolean)
            : selector === "[data-lavish-revision]"
              ? revisionMarkElements
              : structuralQueries
                ? queryChildChain(documentElement, selector)
                : [],
      getSelection: () => selection,
    },
  };
  const windowListeners = [];
  sandbox.window = {
    addEventListener: (type, handler) => windowListeners.push({ type, handler }),
    dispatchEvent: (event) => { for (const listener of windowListeners.filter((entry) => entry.type === event.type)) listener.handler(event); },
    removeEventListener() {},
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: (fn) => (runAnimationFrames ? scheduleTimer(fn, 0) : 0),
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    location: {
      origin,
      pathname: "/artifact/abc/sub/page.html",
      search: "?view=full",
      hash: "#notes",
    },
    URL: sandbox.URL,
  };
  sandbox.top = sandbox.parent;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(createSdkJs("abc", 3, "load-token", sdkOptions), sandbox);

  return {
    document: sandbox.document,
    Element: sandbox.Element,
    posted,
    body,
    // The deferred work the SDK queued, and the size observers it armed, so a test can ask what
    // the client will still do rather than infer it from its messages.
    timers,
    resizeObservers,
    mutationObservers,
    get api() { return sandbox.window.lavish; },
    onWindowEvent(type, handler) { sandbox.window.addEventListener(type, handler); },
    // The SDK checks `instanceof Element`, so a stub that must pass that check takes this prototype.
    asElement(stub) {
      return Object.setPrototypeOf(stub, sandbox.Element.prototype);
    },
    // Returns the dispatched event so a test can tell whether the SDK swallowed the click.
    click(target, modifiers = {}) {
      const listener = documentListeners.find((entry) => entry.type === "click");
      assert.ok(listener, "the SDK registers a document click listener");
      const event = {
        target,
        ctrlKey: false,
        metaKey: false,
        ...modifiers,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopPropagation() {},
      };
      listener.handler(event);
      return event;
    },
    // Releases the mouse over `target` with `text` selected inside it, as a drag-select would.
    selectText(target, text) {
      const textNode = { nodeType: 3, parentElement: target, parentNode: { childNodes: [] } };
      textNode.parentNode.childNodes.push(textNode);
      const range = {
        collapsed: false,
        commonAncestorContainer: textNode,
        startContainer: textNode,
        startOffset: 0,
        endContainer: textNode,
        endOffset: text.length,
        cloneRange: () => range,
        getClientRects: () => [],
        getBoundingClientRect: () => target.getBoundingClientRect(),
      };
      selection = { rangeCount: 1, getRangeAt: () => range, toString: () => text };
      const listener = documentListeners.find((entry) => entry.type === "mouseup");
      assert.ok(listener, "the SDK registers a document mouseup listener");
      listener.handler({ target });
      selection = null;
    },
    setDocumentQuery(query) {
      documentQuery = query;
    },
    setLocation(next) {
      Object.assign(sandbox.window.location, next);
    },
    runTimers() {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) {
        if (!timer.cancelled) timer.fn();
      }
    },
    async runAllTimers() {
      for (let round = 0; round < 100; round += 1) {
        await Promise.resolve();
        await Promise.resolve();
        const pending = timers.splice(0, timers.length);
        if (pending.length === 0) {
          await Promise.resolve();
          if (timers.length === 0) return;
          continue;
        }
        for (const timer of pending) {
          if (!timer.cancelled) timer.fn();
        }
      }
      assert.fail("the SDK timer queue did not settle");
    },
    // Runs only the queued animation frames (the harness schedules them as 0 ms timers), leaving
    // longer timers such as the reveal marker's removal queued.
    runFrames() {
      const pending = timers.filter((timer) => timer.ms === 0 && !timer.ran && !timer.cancelled);
      for (const timer of pending) {
        timer.ran = true;
        timer.fn();
      }
    },
    // Runs the queued timers of exactly `ms` milliseconds.
    runTimersOf(ms) {
      for (const timer of timers.filter((entry) => entry.ms === ms && !entry.ran && !entry.cancelled)) {
        timer.ran = true;
        timer.fn();
      }
    },
    revealMarkers() {
      return documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .filter((child) => child.className === "lavish-reveal-marker");
    },
    // Chrome messages come from the parent at the server origin.

    sendChromeMessage(data) {
      const listeners = windowListeners.filter((entry) => entry.type === "message");
      assert.ok(listeners.length > 0, "the SDK registers a window message listener");
      for (const listener of listeners) {
        listener.handler({ source: sandbox.parent, origin: sandbox.window.location.origin, data });
      }
    },
    dispatchWindowEvent(type, properties = {}) {
      for (const listener of windowListeners.filter((entry) => entry.type === type)) {
        listener.handler({ source: sandbox.parent, origin: sandbox.window.location.origin, ...properties });
      }
    },
    documentListenerCount(type) {
      return documentListeners.filter((entry) => entry.type === type).length;
    },
    cards() {
      return documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .filter((child) => child.className === "lavish-annotation-card");
    },
    card() {
      const card = this.cards().at(-1);
      assert.ok(card, "clicking an element opens an annotation card");
      return card;
    },
    queue(text) {
      const card = this.card();
      card.querySelector("textarea").value = text;
      card.querySelector(".lavish-send").onclick();
      return posted.at(-1);
    },
  };
}

test("artifact-sdk forwards syncUrl and dispatches lavish:urlChange", () => {
  const sdk = bootSdk();
  sdk.api.syncUrl({ view: "tasks", hash: "#notes", mode: "push" });
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:syncUrl");
  assert.equal(message.view, "tasks");
  assert.equal(message.hash, "#notes");
  assert.equal(message.mode, "push");
  assert.equal(message.artifact_load_token, "load-token");
  assert.equal(sdk.api.navigateFrame, undefined);
  let event;
  sdk.onWindowEvent("lavish:urlChange", (value) => { event = value; });
  sdk.sendChromeMessage({ type: "lavish:urlChange", view: "changes", hash: "#section" });
  assert.equal(event.type, "lavish:urlChange");
  assert.equal(event.detail.view, "changes");
  assert.equal(event.detail.hash, "#section");
});

for (const { label, attributes, enabled } of [
  { label: "default", attributes: {}, enabled: true },
  { label: "html off", attributes: { htmlAnnotate: "off" }, enabled: false },
  { label: "html on", attributes: { htmlAnnotate: "on" }, enabled: true },
  { label: "unknown html value", attributes: { htmlAnnotate: "no" }, enabled: true },
  { label: "empty html value", attributes: { htmlAnnotate: "" }, enabled: true },
]) {
  test(`annotation declaration honours ${label} and reports its initial mode`, () => {
    const sdk = bootSdk(attributes);
    const target = appendTo(sdk.body, cell("p", "Decision board"));
    assert.equal(sdk.click(target).defaultPrevented, enabled);
    assert.equal(sdk.cards().length, enabled ? 1 : 0);
    const mode = sdk.posted.find((message) => message.type === "lavish:annotationMode");
    assert.ok(mode, "the SDK reports the initial mode to the chrome");
    assert.equal(mode.enabled, enabled);
    assert.equal(mode.artifact_load_token, "load-token");
  });
}

// Applying the page's "off" default closes no card, so it must not report one gone: the chrome
// saves every `card: null` report over the stored draft, and the frame's load event that replays
// that draft can arrive after a slow image, later than the report.
test("a page that declares off reports no review state at boot", () => {
  const sdk = bootSdk({ htmlAnnotate: "off" });
  sdk.runTimers();
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewState"),
    false,
    "nothing was open, so there is no card state to retire",
  );
  const target = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "h1", text: "needs a shorter headline" }, fields: [] },
  });
  sdk.setDocumentQuery((selector) => (selector === "h1" ? target : null));
  sdk.runTimers();
  assert.equal(sdk.card().querySelector("textarea").value, "needs a shorter headline");
});

test("the chrome can turn annotation on and off after a page declares off", () => {
  const sdk = bootSdk({ htmlAnnotate: "off" });
  const target = appendTo(sdk.body, cell("p", "Decision board"));
  assert.equal(sdk.click(target).defaultPrevented, false);
  sdk.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: true });
  assert.equal(sdk.click(target).defaultPrevented, true);
  assert.equal(sdk.cards().length, 1);
  sdk.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: false });
  assert.equal(sdk.click(target).defaultPrevented, false);
  // This harness retains closed cards; no new card should appear while disabled.
  assert.equal(sdk.cards().length, 1);
  sdk.runTimers();
  const state = sdk.posted.filter((message) => message.type === "lavish:reviewState").at(-1);
  assert.equal(state.state.card, null, "turning annotation off closes the active card");
});

// Reveal scrolls smoothly, so the target's rect only reaches its final place once the scroll
// settles. This target reports its pre-scroll rect until the test says the scroll has settled.
function bootRevealTarget() {
  const sdk = bootSdk({ runAnimationFrames: true });
  const scroll = { settled: false, reads: 0 };
  const target = sdk.asElement(appendTo(sdk.body, cell("section", "Revised block")));
  const calls = [];
  target.scrollIntoView = (options) => calls.push(options);
  target.getBoundingClientRect = () =>
    ++scroll.reads && scroll.settled
      ? { left: 40, top: 300, right: 640, bottom: 420, width: 600, height: 120 }
      : { left: 40, top: 2200, right: 640, bottom: 2320, width: 600, height: 120 };
  sdk.setDocumentQuery((selector) => (selector === "#revised" ? target : null));
  return { sdk, scroll, calls };
}

function assertMarkerAtSettledRect(sdk) {
  const markers = sdk.revealMarkers();
  assert.equal(markers.length, 1);
  assert.deepEqual(
    { left: markers[0].style.left, top: markers[0].style.top, width: markers[0].style.width },
    { left: "40px", top: "300px", width: "600px" },
    "the marker sits on the settled rect, not the pre-scroll one",
  );
}

test("reveal keeps the smooth scroll and moves the marker to the settled rect frame by frame", () => {
  const { sdk, scroll, calls } = bootRevealTarget();
  sdk.sendChromeMessage({ type: "lavish:revealElement", selector: "#revised" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].behavior, "smooth");
  scroll.settled = true;
  sdk.runFrames();
  assertMarkerAtSettledRect(sdk);
});

test("a reveal marker stops tracking once it is removed or replaced", () => {
  const { sdk, scroll } = bootRevealTarget();
  sdk.sendChromeMessage({ type: "lavish:revealElement", selector: "#revised" });
  sdk.sendChromeMessage({ type: "lavish:revealElement", selector: "#revised" });
  assert.equal(sdk.revealMarkers().length, 1, "a new reveal replaces the previous marker at once");
  const readsBeforeFrame = scroll.reads;
  sdk.runFrames();
  assert.equal(scroll.reads - readsBeforeFrame, 1, "a new reveal stops the previous one's frame loop");
  sdk.runTimersOf(2400);
  assert.equal(sdk.revealMarkers().length, 0);
  const readsAtRemoval = scroll.reads;
  sdk.runFrames();
  sdk.runFrames();
  assert.equal(scroll.reads, readsAtRemoval, "no frame re-reads the target after the marker is gone");
});

const TEST_CHROME_NONCE = "nonce-AAAAAAAAAAAAAAAAAAAAAAAA";
const TEST_CHROME_AUTH = "server-issued-chrome-auth-mac";

// Bounded: resolves with whatever reached the port within the window, never waits forever.
function portMessagesWithin(port, ms = 150) {
  return new Promise((resolve) => {
    const seen = [];
    port.addEventListener("message", (event) => seen.push(event.data));
    port.start?.();
    setTimeout(() => resolve(seen), ms);
  });
}

function nextPortMessage(port, type = "") {
  return new Promise((resolve) => {
    const handler = (event) => {
      if (type && event.data?.type !== type) return;
      port.removeEventListener("message", handler);
      resolve(event.data);
    };
    port.addEventListener("message", handler);
    port.start?.();
  });
}

function buildTable(sdk) {
  const table = appendTo(sdk.body, createElement("table"));
  const thead = appendTo(table, createElement("thead"));
  const headerRow = appendTo(thead, createElement("tr"));
  for (const label of ["Permission / setting", "Visible state", "Database evidence"]) {
    appendTo(headerRow, cell("th", label));
  }
  const tbody = appendTo(table, createElement("tbody"));
  const dataRow = appendTo(tbody, createElement("tr"));
  appendTo(dataRow, cell("td", "Media & Apple Music"));
  appendTo(dataRow, cell("td", "4 apps"));
  const evidence = appendTo(dataRow, cell("td", "Drive, Neovide, Cursor"));
  const badge = appendTo(evidence, cell("code", "Drive"));
  return { evidence, badge };
}

test("the protocol-1 SDK rebinds a BFCache document without reinstalling its DOM listeners", async () => {
  const sdk = bootSdk({
    sdkOptions: {
      pageProtocol: 1,
      page: "sub/page.html",
      pageProof: "proof-sub-page",
      servedRoute: "sub/page.html",
      chromeNonce: TEST_CHROME_NONCE,
      chromeAuth: TEST_CHROME_AUTH,
    },
  });
  const initialReady = sdk.posted.at(-1);
  assert.equal(initialReady.type, "lavish:ready");

  const first = new MessageChannel();
  /** @type {any} */ (first.port1).unref?.();
  /** @type {any} */ (first.port2).unref?.();
  const firstResponsePromise = nextPortMessage(first.port1);
  sdk.dispatchWindowEvent("message", {
    data: { type: "lavish:challenge", challenge: "first-challenge", chrome_auth: TEST_CHROME_AUTH },
    ports: [first.port2],
  });
  const firstResponse = await firstResponsePromise;
  const firstRevisionsPromise = nextPortMessage(first.port1, "lavish:revisions");
  first.port1.postMessage({
    ...firstResponse,
    type: "lavish:activate",
    document_sequence: 1,
    historical_destination_receipt: "receipt-before-bfcache",
  });
  const revisions = await firstRevisionsPromise;
  assert.equal(revisions.page, "sub/page.html");
  assert.equal(revisions.document_sequence, 1);
  const clickListeners = sdk.documentListenerCount("click");
  assert.ok(clickListeners > 0, "the accepted document installs the full SDK once");
  const sentAck = nextPortMessage(first.port1, "lavish:queuePrompt");
  const accepted = sdk.api.queuePromptAcknowledged("context\n\ncomment", { requestId: "q-success", commentPrefix: "context\n\n" });
  const ackRequest = await sentAck;
  assert.equal(ackRequest.request_id, "q-success");
  assert.equal(ackRequest.prompt._lavishDiffPrefix, "context\n\n");
  first.port1.postMessage({ ...firstResponse, type: "lavish:queuePromptResult", document_sequence: 1, request_id: "q-success", ok: true });
  assert.equal((await accepted).status, "accepted");
  const staleSent = nextPortMessage(first.port1, "lavish:queuePrompt");
  const uncertain = sdk.api.queuePromptAcknowledged("keep", { requestId: "q-stale" });
  await staleSent;
  first.port1.postMessage({ ...firstResponse, type: "lavish:queuePromptResult", document_sequence: 99, request_id: "q-stale", ok: true });
  const barrier = nextPortMessage(first.port1, "lavish:snapshot");
  first.port1.postMessage({ ...firstResponse, type: "lavish:requestSnapshot", document_sequence: 1 });
  await barrier;
  sdk.runTimersOf(3000);
  assert.equal((await uncertain).status, "unknown");

  const heading = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.click(heading);
  const card = sdk.card();
  card.querySelector("textarea").value = "Keep my annotated image";
  const input = card.querySelector(".lavish-attach-input");
  input.files = [{ name: "evidence.png", type: "image/png", size: 3, arrayBuffer: async () => new ArrayBuffer(3) }];
  const uploadPromise = nextPortMessage(first.port1, "lavish:uploadAttachment");
  input.listeners.find((listener) => listener.type === "change").handler();
  const upload = await uploadPromise;
  first.port1.postMessage({
    ...firstResponse,
    type: "lavish:attachmentResult",
    document_sequence: 1,
    nonce: upload.nonce,
    localId: upload.localId,
    ok: true,
    id: "stored-image",
  });
  // Messages on one port arrive in order, so a snapshot round trip proves the SDK has
  // applied the upload result; a single event-loop turn is not enough on Windows.
  const uploadedSnapshotPromise = nextPortMessage(first.port1, "lavish:snapshot");
  first.port1.postMessage({
    type: "lavish:requestSnapshot",
    snapshot_request_id: "after-upload",
    page: firstResponse.page,
    page_proof: firstResponse.page_proof,
    document_id: firstResponse.document_id,
    document_sequence: 1,
    artifact_load_token: firstResponse.artifact_load_token,
    artifact_revision: firstResponse.artifact_revision,
  });
  assert.equal((await uploadedSnapshotPromise).snapshot_request_id, "after-upload");

  const rebindSent = nextPortMessage(first.port1, "lavish:queuePrompt");
  const rebindPending = sdk.api.queuePromptAcknowledged("pending before rebind", { requestId: "q-rebind" });
  await rebindSent;
  const departingPromise = nextPortMessage(first.port1, "lavish:documentDeparting");
  sdk.dispatchWindowEvent("pagehide");
  const departing = await departingPromise;
  assert.equal(departing.type, "lavish:documentDeparting");
  assert.equal(departing.document_sequence, 1);
  // Signed history is retained by trusted chrome under document-id/exact-URL,
  // not echoed back as authority by the untrusted artifact SDK.
  assert.equal(departing.historical_destination_receipt, undefined);
  assert.equal(departing.destination, firstResponse.destination);

  sdk.dispatchWindowEvent("pageshow", { persisted: true });
  const resumedReady = sdk.posted.at(-1);
  assert.equal(resumedReady.type, "lavish:ready");
  assert.equal(resumedReady.document_id, initialReady.document_id, "BFCache keeps the document identity");

  const second = new MessageChannel();
  /** @type {any} */ (second.port1).unref?.();
  /** @type {any} */ (second.port2).unref?.();
  const secondResponsePromise = nextPortMessage(second.port1);
  sdk.dispatchWindowEvent("message", {
    data: { type: "lavish:challenge", challenge: "second-challenge", chrome_auth: TEST_CHROME_AUTH },
    ports: [second.port2],
  });
  const secondResponse = await secondResponsePromise;
  assert.equal(secondResponse.historical_destination_receipt, undefined);
  assert.equal(secondResponse.document_id, firstResponse.document_id);
  assert.equal(secondResponse.destination, firstResponse.destination);
  second.port1.postMessage({ ...secondResponse, type: "lavish:activate", document_sequence: 2 });
  // The snapshot reply follows activate on the same port, so the SDK is rebound before
  // the card is used.
  const snapshotPromise = nextPortMessage(second.port1, "lavish:snapshot");
  second.port1.postMessage({
    type: "lavish:requestSnapshot",
    snapshot_request_id: "after-bfcache",
    page: secondResponse.page,
    page_proof: secondResponse.page_proof,
    document_id: secondResponse.document_id,
    document_sequence: 2,
    artifact_load_token: secondResponse.artifact_load_token,
    artifact_revision: secondResponse.artifact_revision,
  });
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.type, "lavish:snapshot");
  assert.equal(snapshot.document_sequence, 2);
  assert.equal(snapshot.snapshot_request_id, "after-bfcache");
  const received = [];
  second.port1.addEventListener("message", (event) => received.push(event.data));
  sdk.api.releaseQueueRequest("q-success");
  second.port1.postMessage({ ...secondResponse, type: "lavish:queuePromptResult", document_sequence: 2, request_id: "q-rebind", ok: true });
  const rebindBarrier = nextPortMessage(second.port1, "lavish:snapshot");
  second.port1.postMessage({ ...secondResponse, type: "lavish:requestSnapshot", document_sequence: 2 });
  await rebindBarrier;
  assert.equal(received.some((message) => message.type === "lavish:releaseQueueRequest"), false);
  sdk.runTimersOf(3000);
  assert.equal((await rebindPending).status, "unknown");
  assert.equal((await sdk.api.queuePromptAcknowledged("keep", { requestId: "q-stale" })).status, "unknown");
  assert.equal(sdk.documentListenerCount("click"), clickListeners, "rebind does not duplicate the SDK");
  assert.equal(sdk.card(), card, "BFCache preserves the live annotation card");
  assert.equal(card.querySelector("textarea").value, "Keep my annotated image");
  const queuedPromise = nextPortMessage(second.port1, "lavish:queuePrompt");
  card.querySelector(".lavish-send").onclick();
  const queued = await queuedPromise;
  assert.equal(queued.prompt.prompt, "Keep my annotated image");
  assert.deepEqual(queued.prompt.attachments, [{ id: "stored-image", name: "evidence.png" }]);

  first.port1.close();
  second.port1.close();
});

test("the protocol-1 SDK sends scoped uploads and authored destinations over its accepted port", async (t) => {
  const sdk = bootSdk({
    sdkOptions: {
      pageProtocol: 1,
      page: "sub/page.html",
      pageProof: "proof-sub-page",
      servedRoute: "sub/page.html",
      chromeNonce: TEST_CHROME_NONCE,
      chromeAuth: TEST_CHROME_AUTH,
    },
  });
  const channel = new MessageChannel();
  /** @type {any} */ (channel.port1).unref?.();
  /** @type {any} */ (channel.port2).unref?.();
  t.after(() => {
    channel.port1.close();
    channel.port2.close();
  });
  const responsePromise = nextPortMessage(channel.port1);
  sdk.dispatchWindowEvent("message", {
    data: { type: "lavish:challenge", challenge: "scoped-upload", chrome_auth: TEST_CHROME_AUTH },
    ports: [channel.port2],
  });
  const response = await responsePromise;
  assert.equal(response.destination, "/artifact/abc/sub/page.html?view=full#notes");
  const revisionsPromise = nextPortMessage(channel.port1, "lavish:revisions");
  channel.port1.postMessage({
    ...response,
    type: "lavish:activate",
    document_sequence: 7,
    historical_destination_receipt: "receipt-initial",
  });
  const revisions = await revisionsPromise;
  assert.equal(revisions.page, "sub/page.html");
  assert.equal(revisions.document_sequence, 7);

  const navigationPromise = nextPortMessage(channel.port1, "lavish:navigateFrame");
  sdk.api.navigateFrame("/artifact/abc/sibling.html");
  const navigation = await navigationPromise;
  assert.equal(navigation.target, "/artifact/abc/sibling.html");
  assert.equal(navigation.page, "sub/page.html");
  assert.equal(navigation.document_sequence, 7);

  const destinationPromise = nextPortMessage(channel.port1, "lavish:documentDestination");
  sdk.dispatchWindowEvent("hashchange");
  const destination = await destinationPromise;
  assert.deepEqual(
    {
      type: destination.type,
      page: destination.page,
      page_proof: destination.page_proof,
      served_route: destination.served_route,
      destination: destination.destination,
      document_sequence: destination.document_sequence,
      historical_destination_receipt: destination.historical_destination_receipt,
    },
    {
      type: "lavish:documentDestination",
      page: "sub/page.html",
      page_proof: "proof-sub-page",
      served_route: "sub/page.html",
      destination: "/artifact/abc/sub/page.html?view=full#notes",
      document_sequence: 7,
      historical_destination_receipt: undefined,
    },
  );

  sdk.setLocation({ hash: "#other" });
  const unknownDestinationPromise = nextPortMessage(channel.port1, "lavish:documentDestination");
  sdk.dispatchWindowEvent("hashchange");
  const unknownDestination = await unknownDestinationPromise;
  assert.equal(unknownDestination.historical_destination_receipt, undefined);
  assert.equal(unknownDestination.destination, "/artifact/abc/sub/page.html?view=full#other");
  channel.port1.postMessage({
    ...response,
    type: "lavish:historicalDestinationReceipt",
    document_sequence: 7,
    historical_destination_receipt: "receipt-other",
    destination: "/artifact/abc/sub/page.html?view=full#other",
  });
  await new Promise((resolve) => setImmediate(resolve));
  sdk.setLocation({ hash: "#notes" });
  const restoredDestinationPromise = nextPortMessage(channel.port1, "lavish:documentDestination");
  sdk.dispatchWindowEvent("popstate");
  const restoredDestination = await restoredDestinationPromise;
  assert.equal(restoredDestination.historical_destination_receipt, undefined);
  assert.equal(restoredDestination.destination, "/artifact/abc/sub/page.html?view=full#notes");
  sdk.setLocation({ hash: "#other" });
  const otherDestinationPromise = nextPortMessage(channel.port1, "lavish:documentDestination");
  sdk.dispatchWindowEvent("popstate");
  const otherDestination = await otherDestinationPromise;
  assert.equal(otherDestination.historical_destination_receipt, undefined);
  assert.equal(otherDestination.destination, "/artifact/abc/sub/page.html?view=full#other");
  sdk.setLocation({ hash: "#notes" });

  const { evidence } = buildTable(sdk);
  sdk.click(evidence);
  const card = sdk.card();
  const input = card.querySelector(".lavish-attach-input");
  input.files = [
    {
      name: "evidence.png",
      type: "image/png",
      size: 3,
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    },
  ];
  const change = input.listeners.find((listener) => listener.type === "change");
  assert.ok(change, "the emitted SDK wires the attachment picker");
  const uploadPromise = nextPortMessage(channel.port1, "lavish:uploadAttachment");
  change.handler();
  const upload = await uploadPromise;
  assert.equal(upload.type, "lavish:uploadAttachment");
  assert.equal(upload.page, "sub/page.html");
  assert.equal(upload.page_proof, "proof-sub-page");
  assert.equal(upload.served_route, "sub/page.html");
  assert.equal(upload.destination, "/artifact/abc/sub/page.html?view=full#notes");
  assert.equal(upload.document_sequence, 7);
  assert.equal(upload.artifact_load_token, "load-token");
  assert.equal(upload.localId, "att-1");
  assert.equal(upload.bytes.byteLength, 3);
  assert.ok(upload.nonce);

  channel.port1.postMessage({
    ...response,
    type: "lavish:attachmentResult",
    document_sequence: 7,
    nonce: upload.nonce,
    localId: upload.localId,
    ok: true,
    id: "stored-image",
  });
  const uploadedSnapshotPromise = nextPortMessage(channel.port1, "lavish:snapshot");
  channel.port1.postMessage({
    type: "lavish:requestSnapshot",
    snapshot_request_id: "after-upload",
    page: response.page,
    page_proof: response.page_proof,
    document_id: response.document_id,
    document_sequence: 7,
    artifact_load_token: response.artifact_load_token,
    artifact_revision: response.artifact_revision,
  });
  assert.equal((await uploadedSnapshotPromise).snapshot_request_id, "after-upload");
  const queuedPromise = nextPortMessage(channel.port1, "lavish:queuePrompt");
  card.querySelector("textarea").value = "Review scoped upload";
  card.querySelector(".lavish-send").onclick();
  const queued = await queuedPromise;
  assert.equal(queued.type, "lavish:queuePrompt");
  assert.deepEqual(queued.prompt.attachments, [{ id: "stored-image", name: "evidence.png" }]);
});

test("a requested layout diagnostic publishes even when the result is unchanged", async () => {
  const sdk = bootSdk({ runAnimationFrames: true });

  await sdk.runAllTimers();
  const first = sdk.posted.filter((message) => message.type === "lavish:layoutDiagnostics");
  assert.equal(first.length, 1);

  sdk.sendChromeMessage({ type: "lavish:requestLayoutDiagnostics" });
  await sdk.runAllTimers();
  const diagnostics = sdk.posted.filter((message) => message.type === "lavish:layoutDiagnostics");
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[1].artifact_pass_sequence, diagnostics[0].artifact_pass_sequence + 1);
  assert.deepEqual(diagnostics[1].findings, diagnostics[0].findings);
});

test("legacy queue acknowledgements ignore forged events and resolve only from the chrome origin", async () => {
  const sdk = bootSdk();
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:setQueueEpoch", epoch: "epoch-1" } });
  const first = sdk.api.queuePromptAcknowledged("draft", { requestId: "q-legacy" });
  sdk.dispatchWindowEvent("message", { isTrusted: false, data: { type: "lavish:queuePromptResult", request_id: "q-legacy", ok: true } });
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://foreign.invalid", data: { type: "lavish:queuePromptResult", request_id: "q-legacy", ok: true } });
  sdk.runTimersOf(3000);
  assert.equal((await first).status, "unknown");
  const retry = sdk.api.queuePromptAcknowledged("draft", { requestId: "q-legacy" });
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:queuePromptResult", queue_epoch: "epoch-1", request_id: "q-legacy", ok: false } });
  assert.equal((await retry).status, "rejected");
});

test("a legacy epoch change rejects stale retries and ignores forged epoch messages", async () => {
  const sdk = bootSdk();
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:setQueueEpoch", epoch: "epoch-1" } });
  const pending = sdk.api.queuePromptAcknowledged("draft", { requestId: "q-epoch" });
  assert.equal(sdk.posted.at(-1).queue_epoch, "epoch-1");
  sdk.dispatchWindowEvent("message", { isTrusted: false, origin: "http://127.0.0.1", data: { type: "lavish:setQueueEpoch", epoch: "forged" } });
  sdk.runTimersOf(3000);
  assert.equal((await pending).status, "unknown");
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:setQueueEpoch", epoch: "epoch-2" } });
  const count = sdk.posted.filter((message) => message.type === "lavish:queuePrompt").length;
  const retry = await sdk.api.queuePromptAcknowledged("draft", { requestId: "q-epoch" });
  assert.equal(retry.status, "unknown");
  assert.equal(retry.reason, "binding_changed");
  assert.equal(sdk.posted.filter((message) => message.type === "lavish:queuePrompt").length, count);
});

test("legacy rebinding retires capacity and ignores a delayed response from the old epoch", async () => {
  const sdk = bootSdk();
  const epoch = (value) => sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:setQueueEpoch", epoch: value } });
  const result = (id, value) => sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:queuePromptResult", queue_epoch: value, request_id: id, ok: true } });
  epoch("epoch-1");
  const pending = Array.from({ length: 128 }, (_, i) => sdk.api.queuePromptAcknowledged("draft", { requestId: `q-old-${i}` }));
  epoch("epoch-2");
  for (const request of pending) assert.equal((await request).reason, "binding_changed");
  assert.equal((await sdk.api.queuePromptAcknowledged("draft", { requestId: "q-old-0" })).reason, "binding_changed");
  const fresh = sdk.api.queuePromptAcknowledged("new", { requestId: "q-new" });
  result("q-new", "epoch-1");
  result("q-new", "epoch-2");
  assert.equal((await fresh).status, "accepted");
});

test("an uncertain storage acknowledgement keeps the request available for retry", async () => {
  const sdk = bootSdk();
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:setQueueEpoch", epoch: "epoch-1" } });
  const first = sdk.api.queuePromptAcknowledged("draft", { requestId: "q-storage" });
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:queuePromptResult", queue_epoch: "epoch-1", request_id: "q-storage", ok: false, uncertain: true } });
  assert.equal((await first).status, "unknown");
  sdk.api.releaseQueueRequest("q-storage");
  assert.equal(sdk.posted.some((message) => message.type === "lavish:releaseQueueRequest"), false);
  const retry = sdk.api.queuePromptAcknowledged("draft", { requestId: "q-storage" });
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:queuePromptResult", queue_epoch: "epoch-1", request_id: "q-storage", ok: true } });
  assert.equal((await retry).status, "accepted");
});

test("queue acknowledgement waiters reject concurrent IDs and bound outstanding bindings", async () => {
  const sdk = bootSdk();
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:setQueueEpoch", epoch: "epoch-1" } });
  const first = sdk.api.queuePromptAcknowledged("first", { requestId: "q-shared" });
  const concurrent = sdk.api.queuePromptAcknowledged("second", { requestId: "q-shared" });
  assert.equal((await concurrent).status, "busy");
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:queuePromptResult", queue_epoch: "epoch-1", request_id: "q-shared", ok: true } });
  assert.equal((await first).status, "accepted");
  const pending = [];
  for (let i = 0; i < 127; i++) pending.push(sdk.api.queuePromptAcknowledged("note", { requestId: `q-cap-${i}` }));
  assert.equal((await sdk.api.queuePromptAcknowledged("overflow", { requestId: "q-overflow" })).status, "rejected");
  sdk.runTimersOf(3000);
  for (const promise of pending) assert.equal((await promise).status, "unknown");
  const retry = sdk.api.queuePromptAcknowledged("note", { requestId: "q-cap-0" });
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:queuePromptResult", queue_epoch: "epoch-1", request_id: "q-cap-0", ok: true } });
  assert.equal((await retry).status, "accepted");
  sdk.api.releaseQueueRequest("q-cap-0");
  const fresh = sdk.api.queuePromptAcknowledged("new", { requestId: "q-fresh" });
  sdk.dispatchWindowEvent("message", { isTrusted: true, origin: "http://127.0.0.1", data: { type: "lavish:queuePromptResult", queue_epoch: "epoch-1", request_id: "q-fresh", ok: false } });
  assert.equal((await fresh).status, "rejected");
});

test("the served SDK echoes the snapshot request id", () => {
  const sdk = bootSdk();

  sdk.sendChromeMessage({ type: "lavish:requestSnapshot", snapshot_request_id: "snapshot-17" });

  const response = sdk.posted.at(-1);
  assert.equal(response.type, "lavish:snapshot");
  assert.equal(response.snapshot_request_id, "snapshot-17");
  assert.equal(response.artifact_load_token, "load-token");
});

// readArtifactRevisions calls parseRevisionRegistry and collectRevisionMarks, which in turn call
// the rest of the revision helper chain; a helper left out of the bundle only ReferenceErrors on
// this real read, which a source-grep over the bundle text cannot catch.
test("the served SDK bundle reports the artifact's own revision registry and marks", () => {
  const revisionsScript = createElement("script");
  revisionsScript.textContent = JSON.stringify([
    { id: "r1", label: "Tightened header copy", summary: "Shortened the hero headline" },
  ]);
  const marked = createElement("h1");
  marked.setAttribute("data-lavish-revision", "r1");
  marked.textContent = "Ship faster";

  const sdk = bootSdk({ revisionsScript, revisionMarkElements: [marked] });

  const message = sdk.posted.find((entry) => entry.type === "lavish:revisions");
  assert.ok(message, "the SDK reports the revision registry on load");
  assert.equal(message.revisions.length, 1);
  assert.equal(message.revisions[0].id, "r1");
  assert.equal(message.revisions[0].label, "Tightened header copy");
  assert.equal(message.revisions[0].mark_count, 1);
  assert.equal(message.marks.length, 1);
  assert.equal(message.marks[0].revision_id, "r1");
  assert.equal(message.marks[0].selector, "html > body > h1");
  assert.equal(message.marks[0].excerpt, "Ship faster");
});

test("the served SDK bundle queues a table-cell annotation without a missing-helper ReferenceError", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);
  const message = sdk.queue("Check this permission");

  assert.equal(message.type, "lavish:queuePrompt");
  assert.equal(message.prompt.prompt, "Check this permission");
  assert.deepEqual(
    { ...message.prompt.target },
    {
      type: "table-cell",
      selector: "body > table > tbody > tr > td:nth-of-type(3)",
      rowLabel: "Media & Apple Music",
      columnLabel: "Database evidence",
      text: "Drive, Neovide, Cursor",
    },
  );
});

test("the served SDK bundle keeps the clicked element's own identity inside a table cell", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const { badge } = buildTable(sdk);

  sdk.click(badge);
  const message = sdk.queue("Rename this app");

  assert.equal(message.prompt.tag, "code");
  assert.equal(message.prompt.selector, "table > tbody > tr > td:nth-of-type(3) > code");
  assert.equal(message.prompt.text, "Drive");
  assert.equal(message.prompt.target.selector, "body > table > tbody > tr > td:nth-of-type(3)");
  assert.equal(message.prompt.target.columnLabel, "Database evidence");
});

test("the annotation card names the cell it annotates when the cell itself is clicked", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);

  assert.match(sdk.card().innerHTML, /Annotate cell: Media &amp; Apple Music → Database evidence/);
  assert.match(sdk.card().innerHTML, /about this table cell/);
});

test("the annotation card names the clicked element, not the cell, for a nested click", () => {
  const sdk = bootSdk();
  const { badge } = buildTable(sdk);

  sdk.click(badge);

  assert.match(sdk.card().innerHTML, /Annotate &lt;code&gt; in Media &amp; Apple Music → Database evidence/);
  assert.doesNotMatch(sdk.card().innerHTML, /about this table cell/);
});

test("the served SDK bundle resolves table coordinates only for annotation clicks", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.api.queuePrompt("Programmatic note", { element: evidence });

  assert.equal(sdk.posted.at(-1).prompt.target, undefined);
});

test("the served SDK bundle annotates elements outside tables with no table target", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const message = sdk.queue("Reword this");

  assert.equal(message.prompt.tag, "p");
  assert.equal(message.prompt.target, undefined);
});

// closeCard() clears the element highlight, so that highlight standing or gone is the observable proof of close.
function pressEscape(textarea) {
  const listener = textarea.listeners.find((entry) => entry.type === "keydown");
  assert.ok(listener, "the annotation textarea registers a keydown listener");
  listener.handler({ key: "Escape", preventDefault() {} });
}

test("Escape closes an annotation card with no text and no attachment", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  textarea.value = "   "; // whitespace-only counts as empty
  pressEscape(textarea);

  assert.equal(paragraph.style.outline, "", "the highlight is cleared, proving the card closed");
});

test("Escape during IME composition leaves an empty annotation card open", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  const listener = textarea.listeners.find((entry) => entry.type === "keydown");
  listener.handler({ key: "Escape", isComposing: true, preventDefault() {} });

  assert.notEqual(paragraph.style.outline, "", "a composing Escape belongs to the IME, not the card");
});

test("the Enter that confirms an IME conversion in WebKit leaves the annotation card open", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  textarea.value = "漢字";
  const listener = textarea.listeners.find((entry) => entry.type === "keydown");
  let prevented = false;
  // WebKit fires compositionend before this keydown, so only keyCode 229 marks it as the IME's.
  listener.handler({ key: "Enter", isComposing: false, keyCode: 229, preventDefault: () => (prevented = true) });

  assert.equal(prevented, false, "the IME keeps its Enter");
  assert.notEqual(paragraph.style.outline, "", "the card stays open");
});

test("Escape leaves an annotation card with typed text open and untouched", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  textarea.value = "keep this note";
  pressEscape(textarea);

  assert.notEqual(paragraph.style.outline, "", "the card is still open, so the highlight remains");
  assert.equal(textarea.value, "keep this note", "Escape never discards the typed text");
});

test("Escape leaves an annotation card with an in-flight attachment open, even with no text", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const card = sdk.card();
  const attachInput = card.querySelector(".lavish-attach-input");
  // Never resolves - only the synchronous "uploading" status addFiles sets is needed here.
  attachInput.files = [{ name: "shot.png", type: "image/png", size: 10, arrayBuffer: () => new Promise(() => {}) }];
  const changeListener = attachInput.listeners.find((entry) => entry.type === "change");
  assert.ok(changeListener, "the attach input registers a change listener");
  changeListener.handler();

  pressEscape(card.querySelector("textarea"));

  assert.notEqual(
    paragraph.style.outline,
    "",
    "an attachment mid-upload is unsent content, so Escape must not close the card",
  );
});

// The chrome cannot see into this document, so a draft whose anchor is gone is only ever retired
// if the SDK says so. Silence left it to be retried against every later load.
test("the served SDK bundle reports a draft whose anchor the artifact no longer has", () => {
  const sdk = bootSdk();

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  // The load event proves the document parsed, not that it finished rendering, so nothing is
  // reported until the anchor has had time to appear.
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );

  sdk.runTimers();
  const report = sdk.posted.at(-1);
  assert.equal(report.type, "lavish:reviewDraftUnrestorable");
  assert.equal(report.selector, "#hero");
  assert.equal(report.artifact_load_token, "load-token");
});

// A section this page builds in script, or a Mermaid diagram, is not in the document when it
// loads. Reporting that as a missing anchor is how a live draft gets thrown away.
test("the served SDK bundle restores a draft whose anchor arrives after the load", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
    "an anchor that arrived late is restored, not reported gone",
  );
  assert.equal(sdk.card().querySelector("textarea").value, "needs a shorter headline");
});

test("the served SDK bundle reports nothing when there is no draft to restore", () => {
  const sdk = bootSdk();
  const before = sdk.posted.length;

  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: { card: null, fields: [] } });
  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: { card: { selector: "#hero", text: "  " } } });
  sdk.runTimers();

  assert.equal(sdk.posted.length, before);
});

// `showAnnotationCard` closes whatever card is open before it draws, so a late restore landing on
// a card the user opened inside the settle window would delete text they are still typing - text
// no report has carried to the chrome yet.
test("the served SDK bundle leaves a card the user opened alone when the anchor arrives late", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector("textarea").value = "typing something new";
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(sdk.card().querySelector("textarea").value, "typing something new");
  // The draft is still stored on the chrome side, so a later load can try again; nothing here
  // claims the anchor is gone either.
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );
});

// Cancelling a card reports `card: null`, which is what retires the stored draft on the chrome
// side. A late restore firing after that cancel would draw text the chrome no longer holds and
// report it back as a live draft, so the card the user dismissed reappears with someone else's
// text in it.
test("the served SDK bundle drops a late restore once the user has opened a card of their own", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector(".lavish-cancel").onclick();
  const cardsAfterCancel = sdk.cards().length;

  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(sdk.cards().length, cardsAfterCancel, "the cancelled card is not replaced by a restored one");
  assert.notEqual(sdk.card().querySelector("textarea").value, "needs a shorter headline");
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );
});

test("clicking an element with a queued note asks the chrome to edit it instead of opening a card", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  const queued = sdk.queue("Reword this");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  // The stub shadow root keeps closed cards, so a new card shows as a higher count.
  const cardsBefore = sdk.cards().length;

  sdk.click(paragraph);

  assert.equal(sdk.cards().length, cardsBefore);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.selector);
  assert.equal(message.artifact_load_token, "load-token");
});

test("an element whose queued note left the queue opens a fresh card again", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  const queued = sdk.queue("Reword this");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [] });
  const cardsBefore = sdk.cards().length;

  sdk.click(paragraph);

  assert.equal(sdk.cards().length, cardsBefore + 1);
});

test("the chrome can hand an element click back for a fresh card", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.setDocumentQuery((selector) => (selector === "body > p" ? paragraph : null));

  sdk.sendChromeMessage({ type: "lavish:annotateElement", selector: "body > p" });

  assert.match(sdk.card().innerHTML, /Annotate &lt;p&gt;/);
});

// A Mermaid node as the SDK sees one: a `<g class="node">` inside an SVG Mermaid rendered.
function buildMermaidNode(sdk) {
  const svg = appendTo(sdk.body, createElement("svg"));
  svg.id = "mermaid-1";
  const node = appendTo(svg, createElement("g"));
  node.id = "flowchart-A-0";
  const matchesTag = node.matches;
  node.matches = (selectorList) =>
    String(selectorList)
      .split(",")
      .some((part) => part.trim() === "g.node") || matchesTag(selectorList);
  const label = appendTo(node, cell("span", "Start"));
  const shape = appendTo(node, createElement("rect"));
  return { label, shape };
}

test("a note queued from a diagram node's label opens again from the node's shape", () => {
  const sdk = bootSdk();
  const { label, shape } = buildMermaidNode(sdk);
  sdk.click(label);
  const queued = sdk.queue("Rename this step");
  sdk.sendChromeMessage({
    type: "lavish:queuedAnchors",
    selectors: [queued.prompt.selector, queued.prompt.target.selector],
  });
  const cardsBefore = sdk.cards().length;

  sdk.click(shape);

  assert.equal(sdk.cards().length, cardsBefore);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.target.selector);
});

// The chrome hands a click on a node whose note is already sending back as `annotateElement` with
// the node's own selector, so a note can be queued from the `<g>` itself. A click on any of its
// shapes still finds that note: the node is one target however deep the click lands.
test("a note queued on a diagram node itself opens again from the node's shape", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const { label, shape } = buildMermaidNode(sdk);
  const node = label.parentElement;
  sdk.setDocumentQuery((selector) => (selector === "g#flowchart-A-0" ? node : null));
  sdk.sendChromeMessage({ type: "lavish:annotateElement", selector: "g#flowchart-A-0" });
  const queued = sdk.queue("Rename this step");
  assert.equal(queued.prompt.selector, queued.prompt.target.selector);
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(shape);

  assert.equal(sdk.cards().length, cardsBefore);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.selector);
});

// Every note inside a diagram node also answers to the node's selector, and the chrome opens the
// newest note carrying the selector it is given. A click on an element with its own note must
// name that note's selector, not the node's, or it would open a later note on another shape.
test("a click inside a diagram node reopens the clicked element's own note before the node's", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const { label, shape } = buildMermaidNode(sdk);
  const otherShape = appendTo(label.parentElement, createElement("path"));
  const notes = [];
  for (const [element, text] of [
    [shape, "Recolour this box"],
    [label, "Rename this step"],
    [otherShape, "Thicken this border"],
  ]) {
    sdk.click(element);
    notes.push(sdk.queue(text).prompt);
  }
  sdk.sendChromeMessage({
    type: "lavish:queuedAnchors",
    selectors: [...new Set(notes.flatMap((prompt) => [prompt.selector, prompt.target.selector]))],
  });

  sdk.click(label);

  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, notes[1].selector);
});

test("a click inside a table cell opens only the note on the exact element clicked", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);
  const strong = appendTo(evidence, cell("strong", "Drive"));
  const em = appendTo(evidence, cell("em", "Cursor"));
  sdk.click(evidence);
  const cellNote = sdk.queue("Explain this cell");
  sdk.click(strong);
  const strongNote = sdk.queue("Explain this app");
  sdk.sendChromeMessage({
    type: "lavish:queuedAnchors",
    selectors: [cellNote.prompt.selector, strongNote.prompt.selector],
  });
  const cardsBefore = sdk.cards().length;

  sdk.click(em);

  assert.equal(sdk.cards().length, cardsBefore + 1);
  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor");
});

// In annotate mode a plain click on a link annotates it, so Ctrl-click (Cmd-click on macOS) is the
// way to follow the link without leaving annotate mode: the SDK steps aside and the browser opens it.
function buildLink(sdk) {
  const link = appendTo(sdk.body, cell("a", "Read the spec"));
  link.setAttribute("href", "https://example.com/spec");
  const inner = appendTo(link, cell("span", "spec"));
  return { link, inner };
}

// The follow modifier is the platform's own: Cmd on macOS, Ctrl elsewhere. Meta on Linux/Windows
// is the Super/Windows key, which is not a link-follow gesture there, so it annotates like a plain click.
for (const [platform, modifier] of [
  ["MacIntel", "metaKey"],
  ["Linux x86_64", "ctrlKey"],
  ["Win32", "ctrlKey"],
]) {
  test(`${modifier}-click on a link on ${platform} follows the link instead of annotating`, () => {
    const sdk = bootSdk({ platform });
    const { link, inner } = buildLink(sdk);

    for (const target of [link, inner]) {
      const event = sdk.click(target, { [modifier]: true });
      assert.equal(event.defaultPrevented, false, "the browser's own link handling runs");
    }
    assert.equal(sdk.cards().length, 0);
  });
}

for (const [platform, modifier] of [
  ["Linux x86_64", "metaKey"],
  ["Win32", "metaKey"],
  ["MacIntel", "ctrlKey"],
]) {
  test(`${modifier}-click on a link on ${platform} annotates like a plain click`, () => {
    const sdk = bootSdk({ platform });
    const { link } = buildLink(sdk);

    const event = sdk.click(link, { [modifier]: true });

    assert.equal(event.defaultPrevented, true, "the SDK keeps the frame from navigating");
    assert.match(sdk.card().innerHTML, /Annotate &lt;a&gt;/);
  });
}

test("a plain click on a link in annotate mode still opens an annotation card", () => {
  const sdk = bootSdk();
  const { link } = buildLink(sdk);

  const event = sdk.click(link);

  assert.equal(event.defaultPrevented, true);
  assert.match(sdk.card().innerHTML, /Annotate &lt;a&gt;/);
});

test("a modified click on something that is not a link still annotates", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  const event = sdk.click(paragraph, { ctrlKey: true });

  assert.equal(event.defaultPrevented, true);
  assert.match(sdk.card().innerHTML, /Annotate &lt;p&gt;/);
});

test("Ctrl-click follows a link even when the link already has a queued note", () => {
  const sdk = bootSdk();
  const { link } = buildLink(sdk);
  sdk.click(link);
  const queued = sdk.queue("Is this the right spec?");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const postedBefore = sdk.posted.length;

  const event = sdk.click(link, { ctrlKey: true });

  assert.equal(event.defaultPrevented, false);
  assert.equal(
    sdk.posted.slice(postedBefore).some((message) => message.type === "lavish:editQueuedAnchor"),
    false,
  );
});

test("Ctrl-click on a link after a text selection does not eat the next plain click", () => {
  const sdk = bootSdk();
  const { link } = buildLink(sdk);
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.selectText(paragraph, "prose");
  assert.match(sdk.card().innerHTML, /Annotate text/, "the selection opens a text annotation card");

  const followed = sdk.click(link, { ctrlKey: true });
  assert.equal(followed.defaultPrevented, false);

  sdk.click(paragraph);

  assert.match(sdk.card().innerHTML, /Annotate &lt;p&gt;/);
});

// #445: two structurally identical elements deeper than five levels used to share one selector,
// so clicking the second reopened the first one's queued note.
test("structurally identical deep elements get distinct selectors and their own notes", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const images = [];
  for (let index = 0; index < 2; index += 1) {
    let node = appendTo(sdk.body, createElement("section"));
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
    images.push(appendTo(node, createElement("img")));
  }

  sdk.click(images[0]);
  const first = sdk.queue("Swap this photo");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [first.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(images[1]);

  assert.equal(sdk.cards().length, cardsBefore + 1, "the second image opens a fresh card");
  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor");
  const second = sdk.queue("Crop this one");
  assert.notEqual(second.prompt.selector, first.prompt.selector);
  assert.deepEqual(queryChildChain(sdk.body.parentElement, first.prompt.selector), [images[0]]);
  assert.deepEqual(queryChildChain(sdk.body.parentElement, second.prompt.selector), [images[1]]);
});

// An id only stops the climb when it names one element: generated pages repeat ids.
test("a repeated id does not stop the selector climb", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const images = [];
  for (let index = 0; index < 2; index += 1) {
    const section = appendTo(sdk.body, createElement("section"));
    const card = appendTo(section, createElement("div"));
    card.id = "card";
    images.push(appendTo(card, createElement("img")));
  }

  sdk.click(images[0]);
  const first = sdk.queue("Swap this photo");
  sdk.click(images[1]);
  const second = sdk.queue("Crop this one");

  assert.notEqual(second.prompt.selector, first.prompt.selector);
  assert.deepEqual(queryChildChain(sdk.body.parentElement, first.prompt.selector), [images[0]]);
  assert.deepEqual(queryChildChain(sdk.body.parentElement, second.prompt.selector), [images[1]]);
});

// A chain that matches nothing in the document (here a detached subtree) is not unique either.
test("a selector matching no element keeps climbing", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const detached = createElement("main");
  const images = [];
  for (let index = 0; index < 2; index += 1) {
    let node = appendTo(detached, createElement("section"));
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
    images.push(appendTo(node, createElement("img")));
  }

  sdk.click(images[0]);
  const first = sdk.queue("Swap this photo");
  sdk.click(images[1]);
  const second = sdk.queue("Crop this one");

  assert.notEqual(second.prompt.selector, first.prompt.selector);
});

// In an HTML document a type selector matches an SVG element only in its own case, so a chain
// through `<foreignObject>` (Mermaid wraps every node label in one) must keep that case to name
// anything. The stubbed query below answers the way a browser does for the lowercased tag.
test("a selector through an SVG foreignObject keeps its case and names the clicked element", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const svg = appendTo(appendTo(sdk.body, createElement("section")), createElement("svg"));
  const foreignObject = appendTo(svg, createElement("foreignObject"));
  foreignObject.localName = "foreignObject";
  const label = appendTo(
    appendTo(appendTo(foreignObject, createElement("div")), createElement("p")),
    createElement("span"),
  );
  const query = sdk.document.querySelectorAll;
  sdk.document.querySelectorAll = (selector) => (String(selector).includes("foreignobject") ? [] : query(selector));

  sdk.click(label);
  const queued = sdk.queue("Rename this step");

  assert.deepEqual(sdk.document.querySelectorAll(queued.prompt.selector), [label]);
});

// A queued note made before a structurally identical branch appeared must still
// reopen when its element is clicked, though that element's fresh selector is now longer.
test("a queued note reopens after an identical branch is added beside it", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const build = () => {
    let node = appendTo(sdk.body, createElement("section"));
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
    return appendTo(node, createElement("img"));
  };
  const original = build();
  sdk.click(original);
  const queued = sdk.queue("Swap this photo");
  const twin = build();
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(original);

  assert.equal(sdk.cards().length, cardsBefore);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.selector);

  // The new twin is not the element the note resolves to, so it opens a fresh card.
  sdk.click(twin);
  assert.equal(sdk.cards().length, cardsBefore + 1);
});

// `snapshot()` reads only uid/tag/text, so it must not build selectors, whose
// uniqueness checks query the whole document once per element.
test("snapshot does not query the document for selector uniqueness", () => {
  const sdk = bootSdk({ structuralQueries: true });
  for (let index = 0; index < 3; index += 1) {
    let node = appendTo(sdk.body, createElement("section"));
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
  }
  // The stub Element class matches nothing; let snapshot()'s walk see the stub elements.
  Object.defineProperty(sdk.Element, Symbol.hasInstance, { value: (value) => Boolean(value?.tagName) });
  const queries = [];
  const realQuery = sdk.document.querySelectorAll;
  sdk.document.querySelectorAll = (selector) => {
    queries.push(selector);
    return realQuery(selector);
  };

  sdk.sendChromeMessage({ type: "lavish:requestSnapshot", snapshot_request_id: "s-1" });

  const response = sdk.posted.at(-1);
  assert.equal(response.type, "lavish:snapshot");
  assert.match(response.snapshot, /section/);
  assert.deepEqual(queries, []);
});

// An identical branch inserted *before* the annotated one makes the queued selector's
// first match the new copy. The note must still follow the element it was queued from.
test("a queued note follows its element when an identical branch is inserted before it", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const build = () => {
    const section = appendTo(sdk.body, createElement("section"));
    let node = section;
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
    return { section, img: appendTo(node, createElement("img")) };
  };
  const original = build().img;
  sdk.click(original);
  const queued = sdk.queue("Swap this photo");
  const copy = build();
  sdk.body.children.splice(sdk.body.children.indexOf(copy.section), 1);
  sdk.body.children.unshift(copy.section);
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(copy.img);
  assert.equal(sdk.cards().length, cardsBefore + 1);
  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor");

  sdk.click(original);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.selector);
});

// Two notes on one element whose selector changed between them: the chrome lists selectors oldest
// note first and opens the newest note carrying the selector it gets, so a click must name the
// newer note's selector, as it did when the click sent the element's fresh selector.
test("a click reopens the newer of two notes queued on one element whose selector changed", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.api.queuePrompt("Reword this", { element: paragraph, queueKey: "" });
  const older = sdk.posted.at(-1).prompt;
  const inserted = cell("p", "Inserted above");
  inserted.parentElement = sdk.body;
  sdk.body.children.unshift(inserted);
  sdk.api.queuePrompt("Shorten this", { element: paragraph, queueKey: "" });
  const newer = sdk.posted.at(-1).prompt;
  assert.notEqual(newer.selector, older.selector);
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [older.selector, newer.selector] });

  sdk.click(paragraph);

  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, newer.selector);
});

// A note the chrome cannot open (it is Sending) answers the reopen click with
// `lavish:annotateElement` and the note's stored selector. The fresh card must open on the
// element the note was queued from, not on the inserted copy that selector now matches first.
test("a fresh card for a note that cannot open lands on its element, not the copy its selector now names first", () => {
  const sdk = bootSdk({ structuralQueries: true });
  sdk.setDocumentQuery((selector) => queryChildChain(sdk.body.parentElement, selector)[0] ?? null);
  const build = () => {
    const section = appendTo(sdk.body, createElement("section"));
    let node = section;
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
    return { section, img: appendTo(node, createElement("img")) };
  };
  const original = build().img;
  sdk.click(original);
  const queued = sdk.queue("Swap this photo");
  const copy = build();
  sdk.body.children.splice(sdk.body.children.indexOf(copy.section), 1);
  sdk.body.children.unshift(copy.section);
  assert.equal(queryChildChain(sdk.body.parentElement, queued.prompt.selector)[0], copy.img);

  sdk.sendChromeMessage({ type: "lavish:annotateElement", selector: queued.prompt.selector });
  const fresh = sdk.queue("Crop this one");

  assert.deepEqual(queryChildChain(sdk.body.parentElement, fresh.prompt.selector), [original]);
});

// After a reload the frame has no record of which element a note came from, so the note falls
// back to its selector and the element that selector names reopens it.
test("after a reload a queued note reopens on the element its selector names", () => {
  const before = bootSdk({ structuralQueries: true });
  before.click(appendTo(before.body, cell("p", "Just prose")));
  const queued = before.queue("Reword this");
  const sdk = bootSdk({ structuralQueries: true });
  const reloaded = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(reloaded);

  assert.equal(sdk.cards().length, cardsBefore);
  assert.equal(sdk.posted.at(-1).type, "lavish:editQueuedAnchor");
  assert.equal(sdk.posted.at(-1).selector, queued.prompt.selector);
});

// After a reload the stored selector may be written differently from the selector the page now
// builds for the same element. It still reopens the note when it names that one element alone.
test("after a reload a queued selector that names only the clicked element reopens its note", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: ["body > p"] });
  const cardsBefore = sdk.cards().length;

  sdk.click(paragraph);

  assert.equal(sdk.cards().length, cardsBefore);
  assert.equal(sdk.posted.at(-1).type, "lavish:editQueuedAnchor");
  assert.equal(sdk.posted.at(-1).selector, "body > p");
});

// A text note is about the words, so no click reopens it, and it must not take over an element
// note's selector string either. After a reorder hands that string to another element, a text note
// queued inside that element would otherwise make a click there reopen the other element's note.
test("a text note queued inside an element does not make a click there reopen another element's note", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const moved = appendTo(sdk.body, cell("p", "First"));
  const other = appendTo(sdk.body, cell("p", "Second"));
  sdk.click(moved);
  const elementNote = sdk.queue("Reword this");
  sdk.body.children.reverse();
  sdk.selectText(other, "Second");
  // The drag-select's own click, which the SDK swallows.
  sdk.click(other);
  sdk.queue("Fix this wording");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [elementNote.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(other);

  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor", "the text note reopened another element's note");
  assert.equal(sdk.cards().length, cardsBefore + 1);
});

// Once a queued note's element is removed from the page, a different element that
// now matches its stored selector must not reopen that note; it opens a fresh card instead.
test("a queued note whose element was removed does not reopen on the element now matching its selector", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  const queued = sdk.queue("Reword this");
  paragraph.isConnected = false;
  sdk.body.children.splice(sdk.body.children.indexOf(paragraph), 1);
  const other = appendTo(sdk.body, cell("p", "Other text"));
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(other);

  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor", "another element reopened the note");
  assert.equal(sdk.cards().length, cardsBefore + 1);
});

// After a reload the page has no record of which element a note came from, so its selector only
// reopens it when that selector names exactly one element, the one clicked.
test("after a reload a queued selector reopens its note only when it names exactly the clicked element", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const first = appendTo(sdk.body, cell("p", "Just prose"));
  appendTo(sdk.body, cell("p", "Just prose"));
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: ["body > p"] });
  const cardsBefore = sdk.cards().length;

  sdk.click(first);

  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor", "an ambiguous selector reopened the note");
  assert.equal(sdk.cards().length, cardsBefore + 1);
});

// Deep repeated structure can climb past 300 chars. The queued prompt keeps the whole
// selector, it still names only the clicked element, and a click on it reopens the note.
test("a selector longer than 300 chars is queued whole and still reopens its note", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const images = [];
  for (let index = 0; index < 2; index += 1) {
    let node = appendTo(sdk.body, createElement("section"));
    for (let depth = 0; depth < 60; depth += 1) node = appendTo(node, createElement("div"));
    images.push(appendTo(node, createElement("img")));
  }
  sdk.click(images[1]);
  const queued = sdk.queue("Swap this photo");

  assert.ok(queued.prompt.selector.length > 300, `selector is ${queued.prompt.selector.length} chars`);
  assert.deepEqual(queryChildChain(sdk.body.parentElement, queued.prompt.selector), [images[1]]);

  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  sdk.click(images[1]);
  assert.equal(sdk.posted.at(-1).type, "lavish:editQueuedAnchor");
  assert.equal(sdk.posted.at(-1).selector, queued.prompt.selector);
});

// A Mermaid node's target carries its own selector, so snapshot() must not build
// that one either; tag and text still come from the node.
test("snapshot does not query the document for a diagram node's selector", () => {
  const sdk = bootSdk({ structuralQueries: true });
  buildMermaidNode(sdk);
  Object.defineProperty(sdk.Element, Symbol.hasInstance, { value: (value) => Boolean(value?.tagName) });
  const queries = [];
  const realQuery = sdk.document.querySelectorAll;
  sdk.document.querySelectorAll = (selector) => {
    queries.push(selector);
    return realQuery(selector);
  };

  sdk.sendChromeMessage({ type: "lavish:requestSnapshot", snapshot_request_id: "s-1" });

  const response = sdk.posted.at(-1);
  assert.equal(response.type, "lavish:snapshot");
  assert.match(response.snapshot, /mermaid-node/);
  assert.match(response.snapshot, /Start/);
  assert.deepEqual(queries, []);
});

test("setDocumentMeta posts the title and icon the page asked for, stamped with the load token", () => {
  const sdk = bootSdk();
  sdk.api.setDocumentMeta({ title: "(1) Board", icon: "data:image/svg+xml,<svg/>" });
  const message = sdk.posted.find((entry) => entry.type === "lavish:documentMeta");
  assert.deepEqual(
    { ...message },
    {
      type: "lavish:documentMeta",
      title: "(1) Board",
      icon: "data:image/svg+xml,<svg/>",
      artifact_load_token: "load-token",
      artifact_revision: 3,
    },
  );
});

test("setDocumentMeta forwards null to restore, omits unset fields and drops non-strings", () => {
  const sdk = bootSdk();
  sdk.api.setDocumentMeta({ title: null });
  sdk.api.setDocumentMeta({ icon: 42, title: { toString: () => "x" } });
  sdk.api.setDocumentMeta();
  const messages = sdk.posted.filter((entry) => entry.type === "lavish:documentMeta");
  assert.deepEqual(
    messages.map((entry) => JSON.parse(JSON.stringify({ title: entry.title, icon: entry.icon }))),
    [{ title: null }, {}, {}],
  );
});

test("the protocol-1 SDK reveals nothing to a parent that cannot present this document's chrome auth", async (t) => {
  const boot = (overrides = {}) =>
    bootSdk({
      sdkOptions: {
        pageProtocol: 1,
        page: "sub/page.html",
        pageProof: "proof-sub-page",
        servedRoute: "sub/page.html",
        chromeNonce: TEST_CHROME_NONCE,
        chromeAuth: TEST_CHROME_AUTH,
        ...overrides,
      },
    });
  const attempt = async (sdk, data) => {
    const channel = new MessageChannel();
    /** @type {any} */ (channel.port1).unref?.();
    /** @type {any} */ (channel.port2).unref?.();
    t.after(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const seen = portMessagesWithin(channel.port1);
    sdk.dispatchWindowEvent("message", { data, ports: [channel.port2] });
    return { seen: await seen, port: channel.port1 };
  };

  const sdk = boot();
  const ready = sdk.posted.at(-1);
  assert.equal(ready.type, "lavish:ready");
  assert.equal(ready.document_nonce, TEST_CHROME_NONCE);
  // Readiness is broadcast to whatever parent frames the page, so it must carry no secret.
  const readyText = JSON.stringify(ready);
  assert.ok(!readyText.includes("proof-sub-page"));
  assert.ok(!readyText.includes(TEST_CHROME_AUTH));
  const clickListenersBefore = sdk.documentListenerCount("click");

  const hostileChallenges = [
    { type: "lavish:challenge", challenge: "missing" },
    { type: "lavish:challenge", challenge: "forged", chrome_auth: "forged-mac" },
    { type: "lavish:challenge", challenge: "empty", chrome_auth: "" },
    { type: "lavish:challenge", challenge: "nonce-as-auth", chrome_auth: TEST_CHROME_NONCE },
    { type: "lavish:challenge", challenge: "other-document", chrome_auth: "mac-for-another-document-nonce" },
    // The obsolete bind message must stay meaningless too.
    { type: "lavish:bind", challenge: "legacy", chrome_auth: TEST_CHROME_AUTH },
  ];
  for (const data of hostileChallenges) {
    const { seen, port } = await attempt(sdk, data);
    assert.deepEqual(seen, [], `no response for ${data.challenge}`);
    // Even a well-formed activation on that port cannot install the review SDK.
    port.postMessage({ type: "lavish:activate", document_id: ready.document_id, document_sequence: 1 });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sdk.documentListenerCount("click"), clickListenersBefore, "the review SDK never installed");

  // A document served without auth material can never be activated, even by an empty match.
  const bare = boot({ chromeNonce: "", chromeAuth: "" });
  for (const chrome_auth of [undefined, "", TEST_CHROME_AUTH]) {
    const { seen } = await attempt(bare, { type: "lavish:challenge", challenge: "bare", chrome_auth });
    assert.deepEqual(seen, []);
  }

  // Positive control: the same document answers the authenticated chrome.
  const { seen } = await attempt(sdk, {
    type: "lavish:challenge",
    challenge: "genuine",
    chrome_auth: TEST_CHROME_AUTH,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "lavish:challengeResponse");
  assert.equal(seen[0].page_proof, "proof-sub-page");
});

test("the protocol-1 SDK accepts the chrome origin in an opaque artifact and rejects relays", async (t) => {
  const boot = (origin = undefined) =>
    bootSdk({
      origin,
      sdkOptions: {
        pageProtocol: 1,
        page: "sub/page.html",
        pageProof: "proof-sub-page",
        servedRoute: "sub/page.html",
        chromeNonce: TEST_CHROME_NONCE,
        chromeAuth: TEST_CHROME_AUTH,
      },
    });
  const attempt = async (sdk, origin) => {
    const channel = new MessageChannel();
    /** @type {any} */ (channel.port1).unref?.();
    /** @type {any} */ (channel.port2).unref?.();
    t.after(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const seen = portMessagesWithin(channel.port1);
    sdk.dispatchWindowEvent("message", {
      origin,
      data: { type: "lavish:challenge", challenge: "relayed", chrome_auth: TEST_CHROME_AUTH },
      ports: [channel.port2],
    });
    const messages = await seen;
    channel.port1.postMessage({
      type: "lavish:activate",
      document_id: sdk.posted.find((message) => message.type === "lavish:ready")?.document_id,
      document_sequence: 1,
    });
    return messages;
  };

  // An external page left in the chrome's artifact frame can obtain the MAC for any nonce it
  // announces, then frame this document top-level in a popup it controls and relay that MAC.
  const sdk = boot();
  const clickListenersBefore = sdk.documentListenerCount("click");
  for (const origin of ["http://evil.example", "http://127.0.0.1:4388", "null", "", undefined]) {
    assert.deepEqual(await attempt(sdk, origin), [], `no response for origin ${origin}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sdk.documentListenerCount("click"), clickListenersBefore, "the review SDK never installed");

  // The sandbox gives the artifact an opaque origin, but its served SDK still names
  // the chrome's origin. An opaque sender remains untrusted.
  const opaque = boot("null");
  assert.deepEqual(await attempt(opaque, "null"), []);
  const opaqueAccepted = await attempt(opaque, "http://127.0.0.1");
  assert.equal(opaqueAccepted.length, 1);
  assert.equal(opaqueAccepted[0].type, "lavish:challengeResponse");

  // Positive control: the same MAC from the chrome's own origin completes the challenge.
  const seen = await attempt(sdk, "http://127.0.0.1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "lavish:challengeResponse");
});

// A diagram can sit behind a closed disclosure or an inactive tab for the whole session. Its box
// never reaches the embedding height, so asking again on a timer would keep asking for as long as
// the page is open.
function mermaidDiagram(box) {
  const container = createElement("div");
  // Mermaid renders its svg inside the container, and a page commonly leaves a wrapper of its own
  // in between, so the graph a reveal writes to is not the element the SDK watches.
  const wrapper = appendTo(container, createElement("div"));
  const created = [];
  // Inserting a child connects it on a real page, and `embedWhiteboard` reads `isConnected` to
  // decide whether an existing editor is still there.
  container.insertAdjacentElement = (_position, element) => {
    element.isConnected = true;
    created.push(element);
  };
  const svg = appendTo(wrapper, createElement("svg"));
  svg.id = "mermaid-1";
  svg.closest = (selector) => (String(selector).includes(".mermaid") ? container : null);
  svg.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: box.width,
    bottom: box.height,
    width: box.width,
    height: box.height,
  });
  return { container, svg, box, created };
}

// Must match `WHITEBOARD_LAYOUT_RETRY_DELAY_MS` in src/artifact-sdk.js; a mismatch here fails these
// tests rather than silently passing them.
const LAYOUT_RETRY_MS = 150;

function pendingLayoutRetries(sdk) {
  return sdk.timers.filter((timer) => timer.ms === LAYOUT_RETRY_MS && !timer.ran && !timer.cancelled);
}

function exhaustLayoutRetries(sdk) {
  let rounds = 0;
  while (pendingLayoutRetries(sdk).length > 0 && rounds < 500) {
    sdk.runTimersOf(LAYOUT_RETRY_MS);
    sdk.runFrames();
    rounds += 1;
  }
  return rounds;
}

function watchersOf(sdk, svg) {
  return sdk.resizeObservers.filter((observer) => observer.observed.includes(svg));
}

// The page-change observer the SDK uses for Mermaid. It is the only one that also reports attribute
// changes, which keeps it distinct from the layout audit's observers.
function pageChangeObserver(sdk) {
  const observer = sdk.mutationObservers.find((entry) => entry.options?.attributes === true);
  assert.ok(observer, "the SDK observes page changes it needs for Mermaid");
  return observer;
}

test("a diagram that is never laid out stops retrying", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });

  const rounds = exhaustLayoutRetries(sdk);

  assert.ok(rounds > 0, "a diagram that has not been laid out is retried at least once");
  assert.ok(rounds < 500, "the retries stop on their own instead of polling for the session");
  assert.equal(pendingLayoutRetries(sdk).length, 0, "nothing is left polling for layout");
  assert.equal(diagram.container.style.display, undefined, "a diagram without a box is never embedded");
});

test("a diagram revealed after the retries ran out still gets its whiteboard", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  exhaustLayoutRetries(sdk);
  assert.equal(diagram.container.style.display, undefined, "still hidden while it has no box");

  diagram.box.height = 300;
  const [watcher] = watchersOf(sdk, diagram.svg);
  assert.ok(watcher, "a diagram that gave up polling is watched for the size that would embed it");
  watcher.callback();
  sdk.runFrames();

  assert.equal(diagram.container.style.display, "none", "the revealed diagram becomes a whiteboard");
});

// A tab panel or drawer usually animates `transform` or `zoom`, and a ResizeObserver never reports
// that, so a class or style change is the only evidence of the reveal. Without this the retries the
// diagram spent are the last thing it ever does.
test("a class-only reveal is enough for a diagram that gave up polling", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  exhaustLayoutRetries(sdk);

  // The page has to report the attributes a reveal is made of, or nothing will ever ask again: a
  // transform or zoom reveal leaves no child-list change behind.
  const observer = pageChangeObserver(sdk);
  assert.equal(observer.options.attributes, true, "the page reports attribute changes");
  assert.equal(
    observer.options.attributeFilter,
    undefined,
    "every attribute is reported, so a data-* or aria-* reveal is not filtered away",
  );
  assert.equal(observer.options.childList, true, "and still reports the diagrams it adds");

  // The panel's class flips; the painted rect grows, the layout box a ResizeObserver reports does
  // not have to change, and the browser fires no resize notification for it.
  diagram.box.height = 300;
  observer.callback([{ type: "attributes", target: diagram.container }]);
  sdk.runFrames();

  assert.equal(diagram.container.style.display, "none", "the class change is enough to embed it");
});

// The same reveal is often written below the container: a panel animates the svg's or a wrapper's
// transform, and nothing above the container is named in the record.
test("a reveal written inside the container is enough for a diagram that gave up polling", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  exhaustLayoutRetries(sdk);
  assert.equal(diagram.container.style.display, undefined, "still hidden while it has no box");

  diagram.box.height = 300;
  pageChangeObserver(sdk).callback([{ type: "attributes", target: diagram.svg, attributeName: "style" }]);
  sdk.runFrames();

  assert.equal(diagram.container.style.display, "none", "a reveal below the container counts");
});

// Pan and zoom rewrite the live `viewBox` on every wheel and pointer move, and a diagram still too
// short to embed can sit under the pointer. A viewBox cannot reveal anything, so it must not buy a
// scan per input event - while the style and class writes that do reveal the diagram still must.
test("a viewBox write on a waiting diagram is not a reveal", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  exhaustLayoutRetries(sdk);
  const scheduled = sdk.timers.length;

  pageChangeObserver(sdk).callback([{ type: "attributes", target: diagram.svg, attributeName: "viewBox" }]);
  assert.equal(sdk.timers.length, scheduled, "the SDK's own pan and zoom buys no scan");

  diagram.box.height = 300;
  pageChangeObserver(sdk).callback([{ type: "attributes", target: diagram.svg, attributeName: "style" }]);
  sdk.runFrames();
  assert.equal(diagram.container.style.display, "none", "the same svg restyled by the page still embeds");
});

test("only a reveal tall enough to embed earns the retries back", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  exhaustLayoutRetries(sdk);
  const [watcher] = watchersOf(sdk, diagram.svg);
  assert.ok(watcher);

  // The observer reports the box that made this diagram skip first.
  watcher.callback();
  assert.equal(pendingLayoutRetries(sdk).length, 0, "its own notification is not a reveal");

  // A width-only change says nothing about whether the diagram can be embedded, and a collapsed
  // panel whose width tracks its parent would otherwise restart the whole ladder per resize frame.
  diagram.box.width = 900;
  watcher.callback();
  assert.equal(pendingLayoutRetries(sdk).length, 0, "a width-only change does not restart the retries");

  // A height that is still short of the embed threshold is not a reveal either.
  diagram.box.height = 20;
  watcher.callback();
  assert.equal(pendingLayoutRetries(sdk).length, 0, "a diagram that is still too short is left waiting");
  assert.equal(diagram.container.style.display, undefined);
});

// A live ResizeObserver is retained with the subtree it watches, so a container that leaves the page
// must not leave its watcher running for the life of the document.
test("a diagram that leaves the page stops being watched", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  exhaustLayoutRetries(sdk);
  const [watcher] = watchersOf(sdk, diagram.svg);
  assert.ok(watcher, "the diagram is watched while it is on the page");
  assert.deepEqual(watcher.observed, [diagram.svg]);

  diagram.container.isConnected = false;
  pageChangeObserver(sdk).callback([{ type: "attributes", target: diagram.container }]);
  sdk.runFrames();

  assert.deepEqual(watcher.observed, [], "the watcher is disconnected once its container is gone");
});

// The embed hides the Mermaid source behind its own `display: none`. If the editor is removed and the
// container stays hidden, the diagram becomes an invisible gap that only a reload clears.
test("a removed whiteboard editor leaves the diagram visible again", () => {
  const diagram = mermaidDiagram({ width: 600, height: 300 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  assert.equal(diagram.container.style.display, "none", "the diagram is embedded while it has a box");
  assert.equal(diagram.created.length, 1);

  // The container re-renders: the editor is gone and the layout it was filling is gone with it.
  diagram.created[0].isConnected = false;
  diagram.box.height = 0;
  pageChangeObserver(sdk).callback([{ type: "childList" }]);
  sdk.runFrames();

  assert.equal(diagram.container.style.display, "", "the plain Mermaid diagram is shown again");
});

// A theme change or a re-render replaces the svg inside the same container. The diagram is still
// hidden, but the element whose box the watch was waiting on is gone, so the watch moves with it.
test("a re-rendered diagram inside a hidden container is watched again", () => {
  const first = mermaidDiagram({ width: 600, height: 0 });
  const svgs = [first.svg];
  const sdk = bootSdk({ mermaidSvgs: svgs, runAnimationFrames: true });
  exhaustLayoutRetries(sdk);

  const [firstWatcher] = watchersOf(sdk, first.svg);
  assert.ok(firstWatcher, "the first svg is watched once it runs out of retries");

  const rerendered = mermaidDiagram({ width: 600, height: 0 });
  rerendered.svg.closest = () => first.container;
  svgs.splice(0, svgs.length, rerendered.svg);
  pageChangeObserver(sdk).callback([{ type: "childList" }]);
  sdk.runFrames();

  assert.equal(watchersOf(sdk, rerendered.svg).length, 1, "the watch follows the svg the page holds");
  assert.deepEqual(firstWatcher.observed, [], "the retired svg's watcher is disconnected");
  assert.equal(first.container.style.display, undefined, "the hidden container is left alone");
});

test("a watcher that was already released cannot wake anything", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  exhaustLayoutRetries(sdk);
  const [watcher] = watchersOf(sdk, diagram.svg);
  assert.ok(watcher);

  // A queued notification can still arrive after the reveal that released this watcher.
  diagram.box.height = 300;
  watcher.callback();
  sdk.runFrames();
  const embedded = diagram.created.length;
  assert.equal(embedded, 1);

  watcher.callback();
  sdk.runFrames();
  assert.equal(diagram.created.length, embedded, "the released watcher embeds nothing further");
  assert.equal(
    sdk.timers.filter((timer) => timer.ms === LAYOUT_RETRY_MS && !timer.ran).length,
    0,
    "and schedules no retries",
  );
});

// The attribute channel exists to notice a reveal, not to be a general page-change trigger: a
// scroll-linked class toggle or a progress bar's `style.width` would otherwise buy a full-document
// query per frame for as long as one diagram sits behind a disclosure nobody opened.
test("a restyle elsewhere on the page is not a reason to scan for diagrams", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  exhaustLayoutRetries(sdk);
  const scheduled = sdk.timers.length;

  const widget = createElement("div");
  const progressBar = createElement("div");
  pageChangeObserver(sdk).callback([
    { type: "attributes", target: widget, attributeName: "class" },
    { type: "attributes", target: progressBar, attributeName: "style" },
  ]);

  assert.equal(sdk.timers.length, scheduled, "a restyle a waiting diagram cannot see buys no scan");
  assert.equal(pendingLayoutRetries(sdk).length, 0, "and restarts no retries");
});

// The filters either side of the container are matched by walking record chains, so they have to be
// told apart from a restyle that shares the tree without being an ancestor, a descendant, or the
// container itself. This is the over-matching guard; the test above it is the discriminating one.
test("a restyle below an unrelated element is not a reason to scan for diagrams", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  // The waiting diagram is in the page, so a wrong answer cannot come from a detached node.
  appendTo(sdk.body, diagram.container);
  exhaustLayoutRetries(sdk);
  const scheduled = sdk.timers.length;

  const widget = appendTo(sdk.body, createElement("div"));
  const leaf = appendTo(widget, createElement("span"));
  pageChangeObserver(sdk).callback([{ type: "attributes", target: leaf, attributeName: "class" }]);

  assert.equal(sdk.timers.length, scheduled, "a restyle inside an unrelated element buys no scan");
  assert.equal(pendingLayoutRetries(sdk).length, 0, "and restarts no retries");
});

// A panel opening is a class change on an ancestor, not on the diagram's own container.
test("a class change above a waiting diagram is what wakes it", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  const panel = appendTo(sdk.body, diagram.container);
  exhaustLayoutRetries(sdk);

  diagram.box.height = 300;
  pageChangeObserver(sdk).callback([{ type: "attributes", target: panel, attributeName: "class" }]);
  sdk.runFrames();

  assert.equal(diagram.container.style.display, "none", "the panel opening embeds the diagram");
});

// Embedding hides the container, and that is itself an attribute change on it. The watch is released
// first, so the client cannot answer its own write.
test("the embed's own style write schedules no further pass", () => {
  const diagram = mermaidDiagram({ width: 600, height: 0 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  exhaustLayoutRetries(sdk);

  diagram.box.height = 300;
  watchersOf(sdk, diagram.svg)[0].callback();
  sdk.runFrames();
  assert.equal(diagram.container.style.display, "none", "the diagram is embedded");

  const afterEmbed = sdk.timers.length;
  pageChangeObserver(sdk).callback([{ type: "attributes", target: diagram.container }]);
  assert.equal(sdk.timers.length, afterEmbed, "nothing is waiting, so the write wakes nothing");
});

test("an added node still asks for a pass with nothing waiting", () => {
  const diagram = mermaidDiagram({ width: 600, height: 300 });
  const sdk = bootSdk({ mermaidSvgs: [diagram.svg], runAnimationFrames: true });
  const scheduled = sdk.timers.length;

  pageChangeObserver(sdk).callback([{ type: "childList" }]);
  assert.ok(sdk.timers.length > scheduled, "an added node asks for a pass");
});

test("two hidden diagrams spend their retries separately", () => {
  const first = mermaidDiagram({ width: 600, height: 0 });
  const second = mermaidDiagram({ width: 600, height: 0 });
  second.svg.id = "mermaid-2";
  const sdk = bootSdk({ mermaidSvgs: [first.svg, second.svg], runAnimationFrames: true });
  exhaustLayoutRetries(sdk);
  assert.equal(watchersOf(sdk, first.svg).length, 1);
  assert.equal(watchersOf(sdk, second.svg).length, 1);

  second.box.height = 300;
  watchersOf(sdk, second.svg)[0].callback();
  sdk.runFrames();

  assert.equal(second.container.style.display, "none", "the revealed diagram embeds");
  assert.equal(first.container.style.display, undefined, "the diagram still hidden is untouched");
});
