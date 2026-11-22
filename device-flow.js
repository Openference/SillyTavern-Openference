/**
 * Openference sign-in for SillyTavern: the OAuth device flow (RFC 8628).
 *
 * The flow ends with a new API key for the Openference account that approved it. This file only talks to
 * Openference and never touches the SillyTavern page, so it runs unchanged in Node (see test/). Saving the key
 * into SillyTavern is the job of key-store.js.
 *
 * What the extension may do is decided by Openference, not here: the `sillytavern` client can ask for exactly one
 * thing, to create a key, and the account owner can delete that key at any time from the dashboard.
 */

export const OPENFERENCE_ORIGIN = 'https://openference.com';
export const OAUTH_CLIENT_ID = 'sillytavern';
export const OAUTH_SCOPE = 'api_key:create';

const DEVICE_ENDPOINT = `${OPENFERENCE_ORIGIN}/oauth/device`;
const TOKEN_ENDPOINT = `${OPENFERENCE_ORIGIN}/oauth/token`;
const DEVICE_PAGE = `${OPENFERENCE_ORIGIN}/app/oauth/device`;
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const DEFAULT_INTERVAL_SECONDS = 5;
const MIN_INTERVAL_MS = 1000;
/** RFC 8628: a `slow_down` answer asks for five more seconds between polls. */
const SLOW_DOWN_STEP_MS = 5000;
/**
 * The code can be kept alive while the person pays on Openference (a crypto payment takes minutes), up to an hour
 * after it was issued. Polling therefore follows the server's answer, with this as a backstop.
 */
const MAX_WAIT_MS = 65 * 60 * 1000;
/** Polls in a row that may fail (offline, server hiccup) before giving up. */
const MAX_CONSECUTIVE_FAILURES = 6;
/** The only hosts a sign-in link may point to. A reply that names anything else is ignored. */
const LINK_HOSTS = new Set(['openference.com', 'www.openference.com']);

/**
 * `denied`: the person said no, or Openference could not create a key. `expired`: the code ran out.
 * `cancelled`: stopped from SillyTavern. `network`: Openference could not be reached.
 * `timeout`: nobody approved in time. `failed`: anything else.
 * @typedef {'denied'|'expired'|'cancelled'|'network'|'timeout'|'failed'} DeviceFlowErrorCode
 */

export class DeviceFlowError extends Error {
    /**
     * @param {DeviceFlowErrorCode} code What went wrong, for the interface
     * @param {string} message A sentence that is fine to show to the person
     */
    constructor(code, message) {
        super(message);
        this.name = 'DeviceFlowError';
        this.code = code;
    }
}

/**
 * @typedef {object} DeviceFlow
 * @property {string} deviceCode Secret code the extension polls with. Never shown.
 * @property {string} userCode Short code the person confirms on Openference
 * @property {string} verificationUri Page where the code can be typed in
 * @property {string} verificationLink The same page with the code filled in
 * @property {number} intervalSeconds How often to ask whether the sign-in was approved
 */

function cancelled() {
    return new DeviceFlowError('cancelled', 'Sign-in was cancelled.');
}

/**
 * Waits, and stops waiting when the signal aborts.
 * @param {number} ms Milliseconds to wait
 * @param {AbortSignal} [signal] Aborting rejects with a `cancelled` error
 * @returns {Promise<void>}
 */
export function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(cancelled());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(cancelled());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * A link from a server reply, only when it is an https page on Openference. Otherwise the fallback.
 * The link is shown to the person as something to click, so a reply must not be able to point it elsewhere.
 * @param {unknown} candidate Value from the reply
 * @param {string} fallback Link built here
 * @returns {string}
 */
function pinnedLink(candidate, fallback) {
    if (typeof candidate !== 'string') {
        return fallback;
    }
    try {
        const url = new URL(candidate);
        const trusted = url.protocol === 'https:' && !url.username && !url.password && LINK_HOSTS.has(url.hostname);
        return trusted ? url.toString() : fallback;
    } catch {
        return fallback;
    }
}

function positiveNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/** A sentence for a failed request: Openference's own wording when it sent some. */
function describeFailure(data, status) {
    const description = text(data.error_description);
    if (description) {
        return description;
    }
    const code = text(data.error);
    return `Openference could not complete the sign-in (${code || `HTTP ${status}`}).`;
}

/** A busy or broken server, as opposed to an answer about this sign-in. */
function isTransient(status) {
    return status === 429 || status >= 500;
}

/**
 * POSTs a form and reads the JSON answer. A body that is not JSON reads as an empty object.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {Record<string, string>} fields
 * @param {AbortSignal} [signal]
 * @returns {Promise<{response: Response, data: Record<string, unknown>}>}
 */
async function postForm(fetchImpl, url, fields, signal) {
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
            signal,
        });
    } catch {
        if (signal?.aborted) {
            throw cancelled();
        }
        throw new DeviceFlowError('network', 'Could not reach Openference. Check your connection and try again.');
    }
    const parsed = await response.json().catch(() => null);
    const data = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    return { response, data };
}

/**
 * Asks Openference for a sign-in code.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<DeviceFlow>}
 */
export async function startDeviceFlow({ fetchImpl = globalThis.fetch, signal } = {}) {
    const { response, data } = await postForm(fetchImpl, DEVICE_ENDPOINT, { client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE }, signal);
    if (!response.ok) {
        throw new DeviceFlowError('failed', describeFailure(data, response.status));
    }

    const deviceCode = text(data.device_code);
    const userCode = text(data.user_code);
    if (!deviceCode || !userCode) {
        throw new DeviceFlowError('failed', 'Openference sent an unexpected reply. Please try again later.');
    }

    return {
        deviceCode,
        userCode,
        verificationUri: pinnedLink(data.verification_uri, DEVICE_PAGE),
        verificationLink: pinnedLink(data.verification_uri_complete, `${DEVICE_PAGE}?user_code=${encodeURIComponent(userCode)}`),
        intervalSeconds: positiveNumber(data.interval, DEFAULT_INTERVAL_SECONDS),
    };
}

/**
 * Asks whether the sign-in was approved until it is, and returns the key that was created for it.
 * It waits one interval before the first question: the person has to open the page first.
 * @param {DeviceFlow} flow The code from startDeviceFlow()
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now] Clock in milliseconds
 * @param {AbortSignal} [options.signal] Aborting ends the wait with a `cancelled` error
 * @returns {Promise<{apiKey: string}>}
 */
export async function pollForKey(flow, { fetchImpl = globalThis.fetch, sleep = abortableSleep, now = Date.now, signal } = {}) {
    let intervalMs = Math.max(MIN_INTERVAL_MS, flow.intervalSeconds * 1000);
    const deadline = now() + MAX_WAIT_MS;
    let failures = 0;

    /** Counts a poll that did not get an answer about this sign-in. Gives up after too many in a row. */
    const noteFailure = () => {
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
            throw new DeviceFlowError('network', 'Could not reach Openference. Check your connection and try again.');
        }
    };

    while (now() < deadline) {
        await sleep(intervalMs, signal);
        if (signal?.aborted) {
            throw cancelled();
        }

        let answer;
        try {
            answer = await postForm(fetchImpl, TOKEN_ENDPOINT, {
                grant_type: DEVICE_GRANT_TYPE,
                device_code: flow.deviceCode,
                client_id: OAUTH_CLIENT_ID,
            }, signal);
        } catch (error) {
            if (error instanceof DeviceFlowError && error.code === 'network') {
                noteFailure();
                continue;
            }
            throw error;
        }

        const { response, data } = answer;
        if (response.ok) {
            const apiKey = text(data.api_key);
            if (!apiKey) {
                throw new DeviceFlowError('failed', 'Openference approved the sign-in but did not send a key. Please try again.');
            }
            return { apiKey };
        }

        const errorCode = text(data.error);
        if (!errorCode && isTransient(response.status)) {
            noteFailure();
            continue;
        }
        failures = 0;

        switch (errorCode) {
            case 'authorization_pending':
                break;
            case 'slow_down':
                intervalMs += SLOW_DOWN_STEP_MS;
                break;
            case 'access_denied':
                throw new DeviceFlowError('denied', text(data.error_description) || 'Sign-in was declined on Openference.');
            case 'expired_token':
                throw new DeviceFlowError('expired', 'The sign-in code expired. Start again.');
            default:
                throw new DeviceFlowError('failed', describeFailure(data, response.status));
        }
    }

    throw new DeviceFlowError('timeout', 'Sign-in was not completed in time. Start again.');
}
