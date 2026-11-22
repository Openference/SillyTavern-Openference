/**
 * Openference provider for SillyTavern.
 *
 * Adds "Openference" to the Chat Completion source list, in the "Custom Providers" group. Under the hood it is the
 * Custom (OpenAI-compatible) connection with Openference's API root filled in, so typing a key in by hand works
 * exactly as it does for any other Custom connection.
 *
 * The provider card also gets one control of its own, "Connect with Openference". It signs the person in on
 * openference.com (the OAuth device flow, see device-flow.js) and saves the API key that comes back into
 * SillyTavern's own key list (see key-store.js), so there is nothing to copy and paste.
 *
 * This file only describes the provider and draws that control. It never connects to a model on its own.
 */

/* global SillyTavern */

import * as secrets from '../../../secrets.js';
import { DeviceFlowError, pollForKey, startDeviceFlow } from './device-flow.js';
import { bindKey, keyLabel, storeKey } from './key-store.js';
import { SETUP_GUIDE_URL, checkProviderSupport } from './support.js';

// Type from SillyTavern, for editors. It resolves when this folder sits in SillyTavern's
// public/scripts/extensions/third-party/ folder. It is a comment only and changes nothing at runtime.
/** @typedef {import('../../../custom-providers.js').Registration} Registration */
/** @typedef {import('../../../custom-providers.js').ModelSetup} ModelSetup */
/** @typedef {import('../../../custom-providers.js').AuthPolicy} AuthPolicy */

// A short id for the provider. Saved connections refer to it, so it must not change after release.
const PROVIDER_ID = 'openference';
const PROVIDER_LABEL = 'Openference';

const CONNECTION = {
    // The API root: without /chat/completions, without a key.
    custom_url: 'https://api.openference.com/v1',
};

// The model list is read from <custom_url>/models after connecting, so it is always the account's own.
/** @type {ModelSetup} */
const MODELS = { mode: 'discover' };

// A key is needed and is sent as "Authorization: Bearer <key>".
/** @type {AuthPolicy} */
const AUTH = { mode: 'bearer', required: true };

const LINKS = {
    documentationUrl: SETUP_GUIDE_URL,
    supportUrl: 'https://openference.com/contact',
    note: 'Keep Unlocked Context Size off and cap context at 128K to 200K to avoid Blocked replies.',
};

/** The area SillyTavern keeps in the provider card for an extension's own controls. It empties it when the provider changes. */
const SLOT_ID = 'custom_provider_extension_settings';
const LOG_PREFIX = '[Openference]';

/**
 * What the Connect control shows.
 * @typedef {{kind: 'idle'}
 *   | {kind: 'starting'}
 *   | {kind: 'waiting', userCode: string, verificationUri: string, link: string}
 *   | {kind: 'connected', label: string, bound: boolean}
 *   | {kind: 'unsaved', apiKey: string}
 *   | {kind: 'failed', message: string}} PanelState
 */

/** @type {PanelState} */
let state = { kind: 'idle' };
/**
 * The state the area was last drawn from.
 * @type {PanelState|null}
 */
let drawnState = null;
/** @type {AbortController|null} */
let abortController = null;
/** Counts sign-ins, so a sign-in that was cancelled cannot change what a newer one shows. */
let flowId = 0;
/** @type {Registration|null} */
let registration = null;
/** "Activate" and "enable" can both fire, so the notice for an unsupported SillyTavern is shown once per page load. */
let unsupportedNoticeShown = false;

function isActive() {
    return registration !== null && SillyTavern.getContext().customProviders.active() === registration.id;
}

/**
 * @param {'info'|'success'|'warning'|'error'} kind
 * @param {string} message
 * @param {Record<string, unknown>} [options] toastr options
 */
function toast(kind, message, options) {
    globalThis.toastr?.[kind]?.(message, PROVIDER_LABEL, options);
}

/**
 * Builds an element. Text goes in as text, never as markup.
 * @param {string} tag
 * @param {Record<string, string|boolean|((event: Event) => void)|undefined>} [props] `class`, `on<event>` handlers and attributes
 * @param {...(Node|string|null|false)} children
 * @returns {HTMLElement}
 */
function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
        if (value === undefined || value === false) {
            continue;
        }
        if (name === 'class') {
            node.className = String(value);
        } else if (typeof value === 'function') {
            node.addEventListener(name.slice(2), value);
        } else {
            node.setAttribute(name, value === true ? '' : value);
        }
    }
    for (const child of children) {
        if (child !== null && child !== false) {
            node.append(child);
        }
    }
    return node;
}

function button(label, onClick, { disabled = false } = {}) {
    return h('button', { type: 'button', class: 'menu_button menu_button_icon openference-button', onclick: onClick, disabled }, label);
}

/** @param {PanelState} current */
function buildPanel(current) {
    switch (current.kind) {
        case 'idle':
            return h('div', { class: 'openference-connect' },
                button('Connect with Openference', connect),
                h('small', {}, 'Sign in on openference.com and approve. SillyTavern gets its own API key and saves it in your key list. You can delete it any time in your Openference dashboard.'),
            );
        case 'starting':
            return h('div', { class: 'openference-connect' },
                button('Starting…', connect, { disabled: true }),
            );
        case 'waiting':
            return h('div', { class: 'openference-connect' },
                h('div', {}, 'Approve the sign-in on Openference:'),
                h('a', { class: 'menu_button menu_button_icon openference-button', href: current.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open Openference'),
                h('div', {}, 'Code: ', h('code', { class: 'openference-user-code' }, current.userCode)),
                h('small', {}, `You can also open ${current.verificationUri} on any device and enter the code. You can add credits there if your account has none yet.`),
                h('div', { class: 'openference-status', role: 'status' }, 'Waiting for approval…'),
                button('Cancel', cancel),
            );
        case 'connected':
            return h('div', { class: 'openference-connect' },
                h('div', { class: 'openference-status', role: 'status' },
                    `Connected. The key "${current.label}" is saved in your key list. `,
                    current.bound ? 'Click Connect below to load your models.' : 'Pick it in the key list, then click Connect.',
                ),
                button('Connect again', connect),
            );
        case 'unsaved':
            return buildUnsaved(current.apiKey);
        case 'failed':
            return h('div', { class: 'openference-connect' },
                h('div', { class: 'warning', role: 'alert' }, current.message),
                button('Try again', connect),
            );
        default: {
            /** @type {never} */
            const unhandled = current;
            throw new Error(`${LOG_PREFIX} Unknown panel state: ${JSON.stringify(unhandled)}`);
        }
    }
}

/** The key could not be saved: show it once, so the person can paste it into the key field. */
function buildUnsaved(apiKey) {
    const field = /** @type {HTMLInputElement} */ (h('input', { class: 'text_pole', type: 'text', readonly: true, value: apiKey, autocomplete: 'off', 'aria-label': 'Openference API key' }));
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(apiKey);
            toast('success', 'Key copied.');
        } catch {
            // No clipboard on this page (plain HTTP, for example): select it so Ctrl+C works.
            field.select();
        }
    };
    return h('div', { class: 'openference-connect' },
        h('div', { class: 'warning', role: 'alert' }, 'SillyTavern could not save the new key. Copy it now and paste it into the key field below. It is shown only this once.'),
        h('div', { class: 'openference-key-row' }, field, button('Copy', copy)),
        button('Done', () => setState({ kind: 'idle' })),
    );
}

function renderPanel() {
    const target = document.getElementById(SLOT_ID);
    if (target && isActive()) {
        target.replaceChildren(buildPanel(state));
        drawnState = state;
    }
}

/**
 * Brings the area up to date when the selected connection changes: SillyTavern may have emptied it, or a sign-in
 * may have finished while another source was selected and left the old picture there. Otherwise it is left alone.
 */
function syncPanel() {
    const target = document.getElementById(SLOT_ID);
    if (target && isActive() && (!target.childElementCount || drawnState !== state)) {
        renderPanel();
    }
}

/** @param {PanelState} next */
function setState(next) {
    state = next;
    renderPanel();
}

function cancel() {
    abortController?.abort();
}

/**
 * The key the selected Custom connection uses. SillyTavern records it with the connection's settings.
 * @returns {{mode: string, id?: string}|undefined}
 */
function currentBinding() {
    // SillyTavern's own type for these settings does not list the Custom connection state yet.
    /** @type {any} */
    const settings = SillyTavern.getContext().chatCompletionSettings;
    return settings?.custom_provider_state?.active?.credential;
}

/** Saves the new key, and points the Openference connection at it when that is the selected one. */
async function keepKey(apiKey) {
    const context = SillyTavern.getContext();
    const label = keyLabel();
    const id = await storeKey(apiKey, label, { secrets, getRequestHeaders: context.getRequestHeaders });
    if (!id) {
        setState({ kind: 'unsaved', apiKey });
        return;
    }

    const bound = isActive() && await bindKey(id, {
        executeSlashCommandsWithOptions: context.executeSlashCommandsWithOptions,
        readBinding: currentBinding,
    });
    setState({ kind: 'connected', label, bound });
    toast('success', bound ? 'Connected. Click Connect to load your models.' : `Key saved as "${label}".`);
}

async function connect() {
    if (state.kind === 'starting' || state.kind === 'waiting') {
        return;
    }

    const thisFlow = ++flowId;
    const controller = new AbortController();
    abortController = controller;
    setState({ kind: 'starting' });

    try {
        const flow = await startDeviceFlow({ signal: controller.signal });
        setState({ kind: 'waiting', userCode: flow.userCode, verificationUri: flow.verificationUri, link: flow.verificationLink });
        const { apiKey } = await pollForKey(flow, { signal: controller.signal });
        await keepKey(apiKey);
    } catch (error) {
        if (thisFlow !== flowId) {
            return;
        }
        if (error instanceof DeviceFlowError) {
            setState(error.code === 'cancelled' ? { kind: 'idle' } : { kind: 'failed', message: error.message });
        } else {
            console.error(LOG_PREFIX, 'Connecting failed:', error);
            setState({ kind: 'failed', message: 'Something went wrong while connecting. Please try again.' });
        }
    } finally {
        if (abortController === controller) {
            abortController = null;
        }
    }
}

/** Runs on "activate" and "enable". Both can fire, so registering twice must be harmless. */
export function onActivate() {
    if (registration) {
        return;
    }

    const context = SillyTavern.getContext();
    const support = checkProviderSupport(context);
    if (!support.supported) {
        // Say why nothing was added, instead of leaving a gap where the source should be. The stable release has no
        // Custom provider API yet, so this is what someone sees after installing on it.
        console.warn(`${LOG_PREFIX} ${support.message}`);
        if (!unsupportedNoticeShown) {
            unsupportedNoticeShown = true;
            toast('warning', support.message, { timeOut: 15000, extendedTimeOut: 5000 });
        }
        return;
    }

    const { customProviders, eventSource, eventTypes } = context;

    try {
        // SillyTavern works out which extension this call comes from, so there is no extension name to maintain here.
        registration = customProviders.register(PROVIDER_ID, {
            label: PROVIDER_LABEL,
            defaults: CONNECTION,
            models: MODELS,
            auth: AUTH,
            ...LINKS,
        });
    } catch (error) {
        console.error(`${LOG_PREFIX} Could not register the provider:`, error);
        return;
    }

    eventSource.on(eventTypes.CUSTOM_CONNECTION_CHANGED, syncPanel);
    eventSource.on(eventTypes.CHATCOMPLETION_SOURCE_CHANGED, syncPanel);
    syncPanel();
}

/** Runs on "disable", "delete" and "clean". Connections the user saved keep working without the extension. */
export function onDisable() {
    if (!registration) {
        return;
    }

    const { eventSource, eventTypes } = SillyTavern.getContext();
    cancel();
    eventSource.removeListener(eventTypes.CUSTOM_CONNECTION_CHANGED, syncPanel);
    eventSource.removeListener(eventTypes.CHATCOMPLETION_SOURCE_CHANGED, syncPanel);
    registration.unregister();
    registration = null;
    state = { kind: 'idle' };
    drawnState = null;
    // SillyTavern empties the area as well; this keeps it tidy even on an older version.
    document.getElementById(SLOT_ID)?.replaceChildren();
}
