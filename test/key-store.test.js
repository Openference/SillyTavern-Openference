import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SECRET_KEY, bindKey, keyLabel, storeKey } from '../key-store.js';

describe('keyLabel', () => {
    it('names the key by day, so several connections can be told apart', () => {
        assert.equal(keyLabel(new Date('2026-11-22T23:59:59Z')), 'Openference 2026-11-22');
    });

    it('uses today when no date is given', () => {
        assert.match(keyLabel(), /^Openference \d{4}-\d{2}-\d{2}$/);
    });
});

describe('storeKey', () => {
    it('saves through SillyTavern\'s helper without making the key the active Custom key', async () => {
        const writes = [];
        const secrets = {
            writeSecret: async (...args) => {
                writes.push(args);
                return 'id-123';
            },
        };
        const fetchImpl = async () => assert.fail('the HTTP API is not needed when the helper works');

        const id = await storeKey('sk-new', 'Openference 2026-11-22', { secrets, fetchImpl });

        assert.equal(id, 'id-123');
        assert.deepEqual(writes, [[SECRET_KEY, 'sk-new', 'Openference 2026-11-22', { activate: false }]]);
        assert.equal(SECRET_KEY, 'api_key_custom');
    });

    it('reports a failed save without writing a second copy through the HTTP API', async () => {
        const secrets = { writeSecret: async () => null };
        const fetchImpl = async () => assert.fail('a second write could leave a duplicate');

        assert.equal(await storeKey('sk-new', 'label', { secrets, fetchImpl }), null);
    });

    it('reports a helper that throws', async () => {
        const secrets = {
            writeSecret: async () => {
                throw new Error('boom');
            },
        };
        assert.equal(await storeKey('sk-new', 'label', { secrets }), null);
    });

    describe('when SillyTavern has no helper', () => {
        it('writes through its HTTP API with its request headers, then refreshes the key list', async () => {
            const requests = [];
            const refreshed = [];
            const fetchImpl = async (url, init) => {
                requests.push({ url, init });
                return { ok: true, json: async () => ({ id: 'id-rest' }) };
            };
            const secrets = { readSecretState: async () => refreshed.push(true) };
            const getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' });

            const id = await storeKey('sk-new', 'Openference 2026-11-22', { secrets, fetchImpl, getRequestHeaders });

            assert.equal(id, 'id-rest');
            assert.equal(requests.length, 1);
            assert.equal(requests[0].url, '/api/secrets/write');
            assert.equal(requests[0].init.method, 'POST');
            assert.deepEqual(requests[0].init.headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' });
            assert.deepEqual(JSON.parse(requests[0].init.body), { key: 'api_key_custom', value: 'sk-new', label: 'Openference 2026-11-22', activate: false });
            assert.deepEqual(refreshed, [true]);
        });

        it('works without a key list refresh too', async () => {
            const fetchImpl = async () => ({ ok: true, json: async () => ({ id: 'id-rest' }) });
            assert.equal(await storeKey('sk-new', 'label', { fetchImpl, getRequestHeaders: () => ({}) }), 'id-rest');
        });

        it('reports a refusal', async () => {
            const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
            assert.equal(await storeKey('sk-new', 'label', { fetchImpl, getRequestHeaders: () => ({}) }), null);
        });

        it('reports an answer without an id', async () => {
            for (const body of [{}, { id: '' }, { id: 5 }]) {
                const fetchImpl = async () => ({ ok: true, json: async () => body });
                assert.equal(await storeKey('sk-new', 'label', { fetchImpl, getRequestHeaders: () => ({}) }), null, JSON.stringify(body));
            }
        });

        it('reports a network failure', async () => {
            const fetchImpl = async () => {
                throw new TypeError('Failed to fetch');
            };
            assert.equal(await storeKey('sk-new', 'label', { fetchImpl, getRequestHeaders: () => ({}) }), null);
        });
    });
});

describe('bindKey', () => {
    const bound = id => ({ mode: 'reference', key: 'api_key_custom', id, endpoint: 'https://api.openference.com/v1' });

    it('points the selected connection at the key, quietly, and confirms it took', async () => {
        const commands = [];
        const executeSlashCommandsWithOptions = async (command, options) => {
            commands.push({ command, options });
        };

        const result = await bindKey('0b2f-A1_c', { executeSlashCommandsWithOptions, readBinding: () => bound('0b2f-A1_c') });

        assert.equal(result, true);
        assert.deepEqual(commands, [{ command: '/secret-id quiet=true 0b2f-A1_c', options: { handleExecutionErrors: true } }]);
    });

    it('says no when the connection still uses another key', async () => {
        const executeSlashCommandsWithOptions = async () => {};
        assert.equal(await bindKey('id-1', { executeSlashCommandsWithOptions, readBinding: () => bound('other') }), false);
        assert.equal(await bindKey('id-1', { executeSlashCommandsWithOptions, readBinding: () => ({ mode: 'unbound' }) }), false);
        assert.equal(await bindKey('id-1', { executeSlashCommandsWithOptions, readBinding: () => undefined }), false);
    });

    it('says no when the command fails', async () => {
        const executeSlashCommandsWithOptions = async () => {
            throw new Error('No eligible stored key matches this ID or label.');
        };
        assert.equal(await bindKey('id-1', { executeSlashCommandsWithOptions, readBinding: () => bound('id-1') }), false);
    });

    it('never puts anything but a plain id into a command', async () => {
        const executeSlashCommandsWithOptions = async () => assert.fail('no command may run');
        for (const id of ['', 'id 1', 'id|/echo hi', 'id\n/echo', '"quoted"', '{{macro}}']) {
            assert.equal(await bindKey(id, { executeSlashCommandsWithOptions, readBinding: () => bound(id) }), false, JSON.stringify(id));
        }
    });
});
