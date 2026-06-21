const express = require('express');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    DisconnectReason
} = require('baileys');
const { upload } = require('./mega');
const { Mutex } = require('async-mutex');
const config = require('./config');
const path = require('path');
const { toBuffer } = require('qrcode');

const app = express();
const port = process.env.PORT || config.PORT || 4000;
const sessionDir = path.join(__dirname, 'session');
const mutex = new Mutex();

let activeSock = null;
let activeFlowId = 0;
let activeFlow = null;

app.use(express.static(path.join(__dirname, 'static')));

function emptySession() {
    try {
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('Session delete error:', e.message || e);
    }
}

function safeEndSock(sock) {
    if (!sock) return;

    try {
        sock.ev?.removeAllListeners?.('connection.update');
        sock.ev?.removeAllListeners?.('creds.update');
    } catch (e) {}

    try {
        sock.end?.(undefined);
    } catch (e) {}
}

function stopActiveFlow() {
    activeFlowId++;

    if (activeFlow) {
        activeFlow.dead = true;
        activeFlow.completed = true;

        if (activeFlow.retryTimer) {
            clearTimeout(activeFlow.retryTimer);
            activeFlow.retryTimer = null;
        }
    }

    safeEndSock(activeSock);
    activeSock = null;
    activeFlow = null;
}

function beginFlow() {
    stopActiveFlow();
    emptySession();

    const flow = {
        id: activeFlowId,
        sending: false,
        sent: false,
        completed: false,
        dead: false,
        codeRequested: false,
        qrSent: false,
        retryTimer: null
    };

    activeFlow = flow;
    return flow;
}

function isActiveFlow(flow) {
    return (
        flow &&
        activeFlow &&
        flow.id === activeFlow.id &&
        flow.id === activeFlowId &&
        !flow.dead &&
        !flow.completed
    );
}

async function finishFlow(flow, sock) {
    if (!flow || flow.completed) return;

    flow.completed = true;
    flow.dead = true;

    if (flow.retryTimer) {
        clearTimeout(flow.retryTimer);
        flow.retryTimer = null;
    }

    activeFlowId++;

    if (activeSock === sock) {
        activeSock = null;
    }

    if (activeFlow === flow) {
        activeFlow = null;
    }

    safeEndSock(sock);

    await delay(500);
    emptySession();

    console.log('Flow completed. Socket stopped. Session deleted.');
}

function makeSocket(state) {
    return makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({ level: 'fatal' }).child({ level: 'fatal' })
            )
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
        browser: Browsers.macOS('Safari'),
        markOnlineOnConnect: false
    });
}

function scheduleRetry(flow, cb, waitMs) {
    if (!isActiveFlow(flow)) return;
    if (flow.sending || flow.sent || flow.completed) return;

    if (flow.retryTimer) {
        clearTimeout(flow.retryTimer);
    }

    flow.retryTimer = setTimeout(async () => {
        flow.retryTimer = null;

        if (!isActiveFlow(flow)) return;
        if (flow.sending || flow.sent || flow.completed) return;

        await cb();
    }, waitMs);
}

async function waitForCreds(flow) {
    const credsPath = path.join(sessionDir, 'creds.json');

    for (let i = 0; i < 20; i++) {
        if (!isActiveFlow(flow)) return null;

        if (fs.existsSync(credsPath)) {
            return credsPath;
        }

        await delay(1000);
    }

    return null;
}

async function sendSessionMessages(sock, flow) {
    if (!isActiveFlow(flow)) return;

    if (flow.sending || flow.sent || flow.completed) {
        return;
    }

    flow.sending = true;

    try {
        await delay(7000);

        if (!isActiveFlow(flow)) return;

        const credsPath = await waitForCreds(flow);

        if (!credsPath) {
            throw new Error(`creds.json not found at ${path.join(sessionDir, 'creds.json')}`);
        }

        if (!sock.user?.id) {
            throw new Error('sock.user.id not found');
        }

        const userJid = jidNormalizedUser(sock.user.id);
        const url = await upload(credsPath);

        if (!isActiveFlow(flow)) return;

        const sID = url.includes('https://mega.nz/file/')
            ? config.PREFIX + url.split('https://mega.nz/file/')[1]
            : url.replace('https://mega.nz/file/', config.PREFIX);

        await sock.sendMessage(userJid, { text: sID });
        await delay(3000);

        if (!isActiveFlow(flow)) return;

        await sock.sendMessage(userJid, { text: config.MESSAGE });

        flow.sent = true;
        console.log('Session ID and message sent to WhatsApp once.');
    } catch (error) {
        console.error('Post-connect error:', error.message || error);
    } finally {
        flow.sending = false;

        // Important: finish no matter what after connect attempt,
        // so Baileys does not reconnect and spam the user.
        await finishFlow(flow, sock);
    }
}

async function pairConnector(num, res) {
    const flow = beginFlow();

    async function runPair(isRetry = false) {
        if (!isActiveFlow(flow)) return;

        safeEndSock(activeSock);
        activeSock = null;

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        try {
            const sock = makeSocket(state);
            activeSock = sock;

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                if (!isActiveFlow(flow)) return;

                const { connection, lastDisconnect } = update;
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                if (connection === 'open') {
                    console.log('Pair connected');

                    if (!flow.sending && !flow.sent && !flow.completed) {
                        await sendSessionMessages(sock, flow);
                    }

                    return;
                }

                if (connection === 'close') {
                    if (!isActiveFlow(flow)) return;
                    if (flow.sending || flow.sent || flow.completed) return;

                    console.log('Pair closed, reason:', statusCode);

                    if (statusCode === DisconnectReason.loggedOut) {
                        await finishFlow(flow, sock);
                        return;
                    }

                    const waitMs =
                        statusCode === DisconnectReason.restartRequired ? 2000 : 10000;

                    scheduleRetry(flow, async () => {
                        await runPair(true);
                    }, waitMs);
                }
            });

            if (!sock.authState.creds.registered && !flow.codeRequested) {
                flow.codeRequested = true;

                await delay(1500);

                if (!isActiveFlow(flow)) return;

                num = num.replace(/[^0-9]/g, '');

                const code = await sock.requestPairingCode(num);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;

                if (!res.headersSent) {
                    return res.send({ code: formattedCode });
                }
            }

            if (!sock.authState.creds.registered && flow.codeRequested && isRetry) {
                console.log('Pairing code already requested. Waiting for user to pair...');
            }
        } catch (error) {
            console.error('Pair error:', error.message || error);

            if (!isActiveFlow(flow)) return;

            if (!isRetry && !res.headersSent) {
                return res.status(503).json({ error: 'Service Unavailable' });
            }

            scheduleRetry(flow, async () => {
                await runPair(true);
            }, 10000);
        }
    }

    await runPair(false);
}

async function qrConnector(res) {
    const flow = beginFlow();

    async function runQr(isRetry = false) {
        if (!isActiveFlow(flow)) return;

        safeEndSock(activeSock);
        activeSock = null;

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        try {
            const sock = makeSocket(state);
            activeSock = sock;

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                if (!isActiveFlow(flow)) return;

                const { connection, lastDisconnect, qr } = update;
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                if (qr && !flow.qrSent && !res.headersSent) {
                    try {
                        flow.qrSent = true;

                        const buffer = await toBuffer(qr);
                        res.setHeader('Content-Type', 'image/png');
                        res.end(buffer);
                    } catch (error) {
                        console.error('QR buffer error:', error.message || error);
                    }

                    return;
                }

                if (connection === 'open') {
                    console.log('QR connected');

                    if (!flow.sending && !flow.sent && !flow.completed) {
                        await sendSessionMessages(sock, flow);
                    }

                    return;
                }

                if (connection === 'close') {
                    if (!isActiveFlow(flow)) return;
                    if (flow.sending || flow.sent || flow.completed) return;

                    console.log('QR closed, reason:', statusCode);

                    if (statusCode === DisconnectReason.loggedOut) {
                        await finishFlow(flow, sock);
                        return;
                    }

                    const waitMs =
                        statusCode === DisconnectReason.restartRequired ? 2000 : 10000;

                    scheduleRetry(flow, async () => {
                        await runQr(true);
                    }, waitMs);
                }
            });
        } catch (error) {
            console.error('QR error:', error.message || error);

            if (!isActiveFlow(flow)) return;

            if (!isRetry && !res.headersSent) {
                return res.status(503).json({ error: 'Service Unavailable' });
            }

            scheduleRetry(flow, async () => {
                await runQr(true);
            }, 10000);
        }
    }

    await runQr(false);
}

app.get('/pair', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'pair.html'));
});

app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'qr.html'));
});

app.get('/paircode', async (req, res) => {
    const num = req.query.code;

    if (!num) {
        return res.status(418).json({ message: 'Phone number is required' });
    }

    const release = await mutex.acquire();

    try {
        await pairConnector(num, res);
    } catch (error) {
        console.error(error);

        if (!res.headersSent) {
            res.status(500).json({ error: 'Service Unavailable' });
        }
    } finally {
        release();
    }
});

app.get('/qrcode', async (req, res) => {
    const release = await mutex.acquire();

    try {
        await qrConnector(res);
    } catch (error) {
        console.error(error);

        if (!res.headersSent) {
            res.status(500).json({ error: 'Service Unavailable' });
        }
    } finally {
        release();
    }
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message || err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err?.message || err);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Running on PORT:${port}`);
});