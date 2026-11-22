/**
 * Whether this SillyTavern can list Openference as a source.
 *
 * The entry in the source list comes from SillyTavern's Custom provider API, version 1, which is in SillyTavern
 * 1.20.0 and newer. An older SillyTavern still loads this extension but has no such API, and a different API version
 * may take other arguments. In both cases the extension adds nothing, and this file words the notice that says why,
 * so that nobody is left looking for a source that is not there.
 *
 * It takes what `SillyTavern.getContext()` returns as an argument, so it runs unchanged in Node (see test/).
 */

/** The version of SillyTavern's Custom provider API that this extension is written for. */
export const PROVIDER_API_VERSION = 1;

/** The setup guide. It covers the Custom (OpenAI-compatible) source, which works on every SillyTavern version. */
export const SETUP_GUIDE_URL = 'https://docs.openference.com/integrations/sillytavern';

/**
 * @typedef {{supported: true}
 *   | {supported: false, reason: 'no-provider-api' | 'other-api-version', message: string}} SupportCheck
 */

/**
 * @param {{customProviders?: {apiVersion?: unknown} | null} | null | undefined} context What `SillyTavern.getContext()` returns
 * @returns {SupportCheck}
 */
export function checkProviderSupport(context) {
    const customProviders = context?.customProviders;

    if (!customProviders) {
        return {
            supported: false,
            reason: 'no-provider-api',
            message: `This extension needs SillyTavern 1.20.0 or newer, so Openference was not added to the source list. On this version, use the Custom (OpenAI-compatible) source: ${SETUP_GUIDE_URL}`,
        };
    }

    if (customProviders.apiVersion !== PROVIDER_API_VERSION) {
        return {
            supported: false,
            reason: 'other-api-version',
            message: `This SillyTavern uses a different Custom provider API version than this extension supports, so Openference was not added to the source list. Update the extension (Manage extensions in the Extensions panel) or use the Custom (OpenAI-compatible) source: ${SETUP_GUIDE_URL}`,
        };
    }

    return { supported: true };
}
