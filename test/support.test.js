import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROVIDER_API_VERSION, SETUP_GUIDE_URL, checkProviderSupport } from '../support.js';

describe('checkProviderSupport', () => {
    it('accepts a SillyTavern that has version 1 of the Custom provider API', () => {
        assert.equal(PROVIDER_API_VERSION, 1);
        assert.deepEqual(checkProviderSupport({ customProviders: { apiVersion: 1 } }), { supported: true });
    });

    it('says what to do on a SillyTavern without the API, such as the stable 1.19.1', () => {
        const contexts = [{}, { customProviders: undefined }, { customProviders: null }, null, undefined];

        for (const context of contexts) {
            const result = checkProviderSupport(context);

            assert.equal(result.supported, false);
            assert.equal(result.reason, 'no-provider-api');
            assert.match(result.message, /needs SillyTavern 1\.20\.0 or newer/);
            assert.match(result.message, /Custom \(OpenAI-compatible\) source/);
            assert.ok(result.message.includes(SETUP_GUIDE_URL));
        }
    });

    it('does not claim a different API version works, and points to an extension update', () => {
        for (const apiVersion of [2, 0, '1', undefined, null]) {
            const result = checkProviderSupport({ customProviders: { apiVersion } });

            assert.equal(result.supported, false);
            assert.equal(result.reason, 'other-api-version');
            assert.match(result.message, /Update the extension/);
            assert.ok(result.message.includes(SETUP_GUIDE_URL));
        }
    });

    it('keeps the two notices apart, because the fix is different', () => {
        const missing = checkProviderSupport({});
        const other = checkProviderSupport({ customProviders: { apiVersion: 2 } });

        assert.equal(missing.supported, false);
        assert.equal(other.supported, false);
        assert.notEqual(missing.message, other.message);
        assert.doesNotMatch(missing.message, /Update the extension/);
    });

    it('points at the setup guide on openference.com', () => {
        assert.equal(new URL(SETUP_GUIDE_URL).origin, 'https://docs.openference.com');
    });
});
