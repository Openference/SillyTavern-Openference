import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeviceFlowError, abortableSleep, pollForKey, startDeviceFlow } from '../device-flow.js';

/** A Response-like object, enough for what device-flow.js reads. */
function reply(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
            if (body === undefined) {
                throw new SyntaxError('Unexpected end of JSON input');
            }
            return body;
        },
    };
}

/** A fetch that answers from a queue and records every request. */
function scriptedFetch(...answers) {
    const calls = [];
    const queue = [...answers];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
        const next = queue.shift();
        if (next === undefined) {
            throw new Error('No scripted answer left');
        }
        if (next instanceof Error) {
            throw next;
        }
        return next;
    };
    return { fetchImpl, calls };
}

/** Sleep and clock that move together: nothing waits for real. */
function fakeTime(start = 1_000_000) {
    let current = start;
    const sleeps = [];
    return {
        sleeps,
        now: () => current,
        sleep: async (ms) => {
            sleeps.push(ms);
            current += ms;
        },
    };
}

const flow = { deviceCode: 'oad_secret', userCode: 'ABCD-EFGH', intervalSeconds: 5 };
const pending = () => reply(400, { error: 'authorization_pending' });

describe('startDeviceFlow', () => {
    const issued = {
        device_code: 'oad_secret',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://openference.com/app/oauth/device',
        verification_uri_complete: 'https://openference.com/app/oauth/device?user_code=ABCD-EFGH',
        expires_in: 600,
        interval: 5,
    };

    it('asks for a key as the sillytavern client, with a plain form post', async () => {
        const { fetchImpl, calls } = scriptedFetch(reply(200, issued));
        const result = await startDeviceFlow({ fetchImpl });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://openference.com/oauth/device');
        assert.equal(calls[0].init.method, 'POST');
        // A form content type keeps the request simple for the browser: no preflight round trip.
        assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
        assert.deepEqual(calls[0].form, { client_id: 'sillytavern', scope: 'api_key:create' });
        assert.deepEqual(result, {
            deviceCode: 'oad_secret',
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://openference.com/app/oauth/device',
            verificationLink: 'https://openference.com/app/oauth/device?user_code=ABCD-EFGH',
            intervalSeconds: 5,
        });
    });

    it('builds the link itself when the reply has none, and defaults the interval', async () => {
        const { fetchImpl } = scriptedFetch(reply(200, { device_code: 'd', user_code: 'A B' }));
        const result = await startDeviceFlow({ fetchImpl });

        assert.equal(result.verificationUri, 'https://openference.com/app/oauth/device');
        assert.equal(result.verificationLink, 'https://openference.com/app/oauth/device?user_code=A%20B');
        assert.equal(result.intervalSeconds, 5);
    });

    for (const [name, link] of [
        ['another host', 'https://evil.example/app/oauth/device?user_code=X'],
        ['a lookalike host', 'https://openference.com.evil.example/app/oauth/device'],
        ['plain http', 'http://openference.com/app/oauth/device'],
        ['a script link', 'javascript:alert(1)'],
        ['embedded credentials', 'https://user:pass@openference.com/app/oauth/device'],
        ['text that is not a link', 'open the page'],
    ]) {
        it(`ignores a link that points to ${name}`, async () => {
            const { fetchImpl } = scriptedFetch(reply(200, { ...issued, verification_uri: link, verification_uri_complete: link }));
            const result = await startDeviceFlow({ fetchImpl });

            assert.equal(result.verificationUri, 'https://openference.com/app/oauth/device');
            assert.equal(result.verificationLink, 'https://openference.com/app/oauth/device?user_code=ABCD-EFGH');
        });
    }

    it('keeps a link on the www host', async () => {
        const link = 'https://www.openference.com/app/oauth/device?user_code=ABCD-EFGH';
        const { fetchImpl } = scriptedFetch(reply(200, { ...issued, verification_uri_complete: link }));
        assert.equal((await startDeviceFlow({ fetchImpl })).verificationLink, link);
    });

    it('uses the interval Openference asks for, and ignores nonsense', async () => {
        assert.equal((await startDeviceFlow({ fetchImpl: scriptedFetch(reply(200, { ...issued, interval: 9 })).fetchImpl })).intervalSeconds, 9);
        for (const interval of [0, -3, '5', null, Number.NaN]) {
            const { fetchImpl } = scriptedFetch(reply(200, { ...issued, interval }));
            assert.equal((await startDeviceFlow({ fetchImpl })).intervalSeconds, 5, `interval ${String(interval)}`);
        }
    });

    it('reports Openference\'s own wording when it refuses', async () => {
        const { fetchImpl } = scriptedFetch(reply(400, { error: 'unauthorized_client', error_description: 'Device flow not enabled for this client' }));
        await assert.rejects(startDeviceFlow({ fetchImpl }), error => {
            assert.ok(error instanceof DeviceFlowError);
            assert.equal(error.code, 'failed');
            assert.equal(error.message, 'Device flow not enabled for this client');
            return true;
        });
    });

    it('names the status when the refusal has no wording', async () => {
        const { fetchImpl } = scriptedFetch(reply(503, undefined));
        await assert.rejects(startDeviceFlow({ fetchImpl }), /HTTP 503/);
    });

    it('rejects a reply without codes', async () => {
        for (const body of [{}, { device_code: 'd' }, { user_code: 'u' }, { device_code: 7, user_code: 'u' }, null, []]) {
            const { fetchImpl } = scriptedFetch(reply(200, body));
            await assert.rejects(startDeviceFlow({ fetchImpl }), error => error instanceof DeviceFlowError && error.code === 'failed', JSON.stringify(body));
        }
    });

    it('reports a network failure as such', async () => {
        const { fetchImpl } = scriptedFetch(new TypeError('Failed to fetch'));
        await assert.rejects(startDeviceFlow({ fetchImpl }), error => error instanceof DeviceFlowError && error.code === 'network' && /Could not reach Openference/.test(error.message));
    });

    it('reports a cancelled start as cancelled, not as a network failure', async () => {
        const controller = new AbortController();
        const fetchImpl = async () => {
            controller.abort();
            throw new DOMException('The operation was aborted.', 'AbortError');
        };
        await assert.rejects(startDeviceFlow({ fetchImpl, signal: controller.signal }), error => error instanceof DeviceFlowError && error.code === 'cancelled');
    });
});

describe('pollForKey', () => {
    it('waits one interval before it asks, then returns the key', async () => {
        const time = fakeTime();
        const { fetchImpl, calls } = scriptedFetch(reply(200, { access_token: 'jwt', api_key: 'sk-new-key' }));
        const result = await pollForKey(flow, { fetchImpl, ...time });

        assert.deepEqual(result, { apiKey: 'sk-new-key' });
        assert.deepEqual(time.sleeps, [5000]);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://openference.com/oauth/token');
        assert.equal(calls[0].init.method, 'POST');
        assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
        assert.deepEqual(calls[0].form, {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: 'oad_secret',
            client_id: 'sillytavern',
        });
    });

    it('keeps asking while the sign-in is waiting for approval', async () => {
        const time = fakeTime();
        const { fetchImpl, calls } = scriptedFetch(pending(), pending(), pending(), reply(200, { api_key: 'sk-late' }));
        const result = await pollForKey(flow, { fetchImpl, ...time });

        assert.equal(result.apiKey, 'sk-late');
        assert.equal(calls.length, 4);
        assert.deepEqual(time.sleeps, [5000, 5000, 5000, 5000]);
    });

    it('never asks faster than once a second, whatever the interval', async () => {
        const time = fakeTime();
        const { fetchImpl } = scriptedFetch(reply(200, { api_key: 'sk' }));
        await pollForKey({ ...flow, intervalSeconds: 0.1 }, { fetchImpl, ...time });
        assert.deepEqual(time.sleeps, [1000]);
    });

    it('slows down by five seconds each time Openference asks it to', async () => {
        const time = fakeTime();
        const slow = () => reply(400, { error: 'slow_down' });
        const { fetchImpl } = scriptedFetch(slow(), slow(), pending(), reply(200, { api_key: 'sk' }));
        await pollForKey(flow, { fetchImpl, ...time });

        assert.deepEqual(time.sleeps, [5000, 10_000, 15_000, 15_000]);
    });

    it('stops with Openference\'s wording when it cannot create a key', async () => {
        const time = fakeTime();
        const description = 'You have reached the maximum number of API keys. Delete one in your dashboard, then connect again.';
        const { fetchImpl } = scriptedFetch(pending(), reply(400, { error: 'access_denied', error_description: description }));
        await assert.rejects(pollForKey(flow, { fetchImpl, ...time }), error => {
            assert.ok(error instanceof DeviceFlowError);
            assert.equal(error.code, 'denied');
            assert.equal(error.message, description);
            return true;
        });
    });

    it('says the sign-in was declined when the person pressed Deny', async () => {
        const { fetchImpl } = scriptedFetch(reply(400, { error: 'access_denied' }));
        await assert.rejects(pollForKey(flow, { fetchImpl, ...fakeTime() }), error => error.code === 'denied' && /declined/.test(error.message));
    });

    it('stops when the code expired', async () => {
        const { fetchImpl } = scriptedFetch(pending(), reply(400, { error: 'expired_token' }));
        await assert.rejects(pollForKey(flow, { fetchImpl, ...fakeTime() }), error => error instanceof DeviceFlowError && error.code === 'expired');
    });

    it('stops with Openference\'s wording for any other refusal', async () => {
        const { fetchImpl } = scriptedFetch(reply(401, { error: 'unauthorized_client', error_description: 'This app is not allowed to create API keys.' }));
        await assert.rejects(pollForKey(flow, { fetchImpl, ...fakeTime() }), error => error.code === 'failed' && error.message === 'This app is not allowed to create API keys.');
    });

    it('does not accept an approval that carries no key', async () => {
        for (const body of [{ access_token: 'jwt' }, { api_key: '' }, { api_key: '   ' }, { api_key: 42 }]) {
            const { fetchImpl } = scriptedFetch(reply(200, body));
            await assert.rejects(pollForKey(flow, { fetchImpl, ...fakeTime() }), error => error.code === 'failed' && /did not send a key/.test(error.message), JSON.stringify(body));
        }
    });

    it('trims the key', async () => {
        const { fetchImpl } = scriptedFetch(reply(200, { api_key: '  sk-padded\n' }));
        assert.equal((await pollForKey(flow, { fetchImpl, ...fakeTime() })).apiKey, 'sk-padded');
    });

    it('rides out a few failed polls in a row', async () => {
        const offline = () => new TypeError('Failed to fetch');
        const { fetchImpl, calls } = scriptedFetch(offline(), offline(), reply(503, undefined), reply(429, undefined), pending(), reply(200, { api_key: 'sk' }));
        const result = await pollForKey(flow, { fetchImpl, ...fakeTime() });

        assert.equal(result.apiKey, 'sk');
        assert.equal(calls.length, 6);
    });

    it('starts counting failures again after an answer about the sign-in', async () => {
        const offline = () => new TypeError('Failed to fetch');
        const answers = [];
        // Five failures, an answer, five more failures: ten in all, but never six in a row.
        for (let round = 0; round < 2; round += 1) {
            for (let i = 0; i < 5; i += 1) {
                answers.push(offline());
            }
            answers.push(pending());
        }
        answers.push(reply(200, { api_key: 'sk' }));
        const { fetchImpl } = scriptedFetch(...answers);

        assert.equal((await pollForKey(flow, { fetchImpl, ...fakeTime() })).apiKey, 'sk');
    });

    it('gives up after six failed polls in a row', async () => {
        const offline = () => new TypeError('Failed to fetch');
        const { fetchImpl, calls } = scriptedFetch(offline(), offline(), offline(), offline(), offline(), offline(), reply(200, { api_key: 'never' }));
        await assert.rejects(pollForKey(flow, { fetchImpl, ...fakeTime() }), error => error instanceof DeviceFlowError && error.code === 'network');
        assert.equal(calls.length, 6);
    });

    it('treats a busy server as a failed poll, not as a refusal', async () => {
        const busy = () => reply(502, undefined);
        const { fetchImpl } = scriptedFetch(busy(), busy(), busy(), busy(), busy(), busy());
        await assert.rejects(pollForKey(flow, { fetchImpl, ...fakeTime() }), error => error.code === 'network');
    });

    it('keeps waiting well past the first ten minutes: the code can be kept alive while the person pays', async () => {
        const time = fakeTime();
        // 20 minutes of "still waiting" at five seconds each.
        const waiting = Array.from({ length: 240 }, pending);
        const { fetchImpl, calls } = scriptedFetch(...waiting, reply(200, { api_key: 'sk-after-payment' }));
        const result = await pollForKey(flow, { fetchImpl, ...time });

        assert.equal(result.apiKey, 'sk-after-payment');
        assert.equal(calls.length, 241);
    });

    it('stops on its own after about an hour if Openference never says the code ended', async () => {
        const time = fakeTime();
        const { fetchImpl } = scriptedFetch(...Array.from({ length: 2000 }, pending));
        await assert.rejects(pollForKey(flow, { fetchImpl, ...time }), error => error instanceof DeviceFlowError && error.code === 'timeout');
        const waitedMinutes = time.sleeps.reduce((sum, ms) => sum + ms, 0) / 60_000;
        assert.ok(waitedMinutes >= 65 && waitedMinutes < 66, `waited ${waitedMinutes} minutes`);
    });

    it('stops when it is cancelled while waiting', async () => {
        const controller = new AbortController();
        const sleep = async () => controller.abort();
        const { fetchImpl, calls } = scriptedFetch(reply(200, { api_key: 'never' }));
        await assert.rejects(pollForKey(flow, { fetchImpl, sleep, now: Date.now, signal: controller.signal }), error => error instanceof DeviceFlowError && error.code === 'cancelled');
        assert.equal(calls.length, 0);
    });

    it('stops when it is cancelled during a poll', async () => {
        const controller = new AbortController();
        const fetchImpl = async () => {
            controller.abort();
            throw new DOMException('The operation was aborted.', 'AbortError');
        };
        await assert.rejects(pollForKey(flow, { fetchImpl, ...fakeTime(), signal: controller.signal }), error => error.code === 'cancelled');
    });
});

describe('abortableSleep', () => {
    it('resolves after the time', async () => {
        await abortableSleep(5);
    });

    it('rejects at once when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(abortableSleep(60_000, controller.signal), error => error instanceof DeviceFlowError && error.code === 'cancelled');
    });

    it('stops waiting when the signal aborts', async () => {
        const controller = new AbortController();
        const started = Date.now();
        const sleeping = abortableSleep(60_000, controller.signal);
        controller.abort();
        await assert.rejects(sleeping, error => error.code === 'cancelled');
        assert.ok(Date.now() - started < 1000);
    });
});
