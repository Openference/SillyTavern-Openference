/**
 * Hands the new Openference key to SillyTavern.
 *
 * SillyTavern keeps API keys in its own key store (the Secrets file in your data folder) and a connection only
 * refers to one of them by id. This file puts the key there, labelled, without replacing the key that is active
 * for the plain Custom (OpenAI-compatible) connection, and then points the Openference connection at it.
 * The key is never kept anywhere else: not in the extension's settings, not in the page, not in a log.
 *
 * The functions take what they need from SillyTavern as arguments, so they run unchanged in Node (see test/).
 */

/** The key category of SillyTavern's Custom (OpenAI-compatible) connection, which Openference is built on. */
export const SECRET_KEY = 'api_key_custom';

/** A key id as SillyTavern makes them. Anything else is not put into a command. */
const SECRET_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Name of the key in SillyTavern's key list. The date tells several connections apart.
 * @param {Date} [now]
 * @returns {string}
 */
export function keyLabel(now = new Date()) {
    return `Openference ${now.toISOString().slice(0, 10)}`;
}

/**
 * @typedef {object} SecretsModule What is used of SillyTavern's scripts/secrets.js. Both are optional: a SillyTavern
 *   that no longer has them is handled with its HTTP API.
 * @property {(key: string, value: string, label?: string, options?: {allowEmpty?: boolean, activate?: boolean}) => Promise<string|null>} [writeSecret]
 * @property {() => Promise<void>} [readSecretState]
 */

/**
 * Saves the key in SillyTavern's key store, labelled and not made the active key of the plain Custom connection.
 * @param {string} apiKey The key Openference created
 * @param {string} label Name for the key list
 * @param {object} deps
 * @param {SecretsModule} [deps.secrets] SillyTavern's scripts/secrets.js
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => Record<string, string>} [deps.getRequestHeaders] SillyTavern's request headers (they carry its CSRF token)
 * @returns {Promise<string|null>} The id of the saved key, or null when it could not be saved
 */
export async function storeKey(apiKey, label, { secrets, fetchImpl = globalThis.fetch, getRequestHeaders } = {}) {
    // SillyTavern's own helper also refreshes its key list, so the key shows up in the picker straight away.
    if (typeof secrets?.writeSecret === 'function') {
        // When it reports a failure the key may still have been written (it also reports one when a listener of its
        // own fails), so a second write through the HTTP API would risk a duplicate. The key is shown instead.
        try {
            return (await secrets.writeSecret(SECRET_KEY, apiKey, label, { activate: false })) || null;
        } catch {
            return null;
        }
    }

    try {
        const response = await fetchImpl('/api/secrets/write', {
            method: 'POST',
            headers: getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: SECRET_KEY, value: apiKey, label, activate: false }),
        });
        if (!response.ok) {
            return null;
        }
        const { id } = await response.json();
        await secrets?.readSecretState?.();
        return typeof id === 'string' && id ? id : null;
    } catch {
        return null;
    }
}

/**
 * @typedef {object} CredentialBinding The key a Custom connection uses, as SillyTavern records it.
 * @property {string} mode
 * @property {string} [id]
 */

/**
 * Makes the selected Custom connection use the saved key, so the person only has to press Connect.
 * Meant for the moment the Openference connection is the selected one: the command acts on whichever connection is.
 * @param {string} id Id of the saved key
 * @param {object} deps
 * @param {(command: string, options?: object) => Promise<unknown>} deps.executeSlashCommandsWithOptions SillyTavern's command runner
 * @param {() => CredentialBinding|undefined} deps.readBinding The selected connection's current key binding
 * @returns {Promise<boolean>} Whether the connection now uses the key
 */
export async function bindKey(id, { executeSlashCommandsWithOptions, readBinding }) {
    if (!SECRET_ID.test(id)) {
        return false;
    }
    try {
        await executeSlashCommandsWithOptions(`/secret-id quiet=true ${id}`, { handleExecutionErrors: true });
        const binding = readBinding();
        return binding?.mode === 'reference' && binding.id === id;
    } catch {
        return false;
    }
}
