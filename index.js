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
const port = config.PORT || 4000;
const sessionDir = path.join(__dirname, 'session');
const mutex = new Mutex();

let activeSock = null;
let activeFlowId = 0;
let finishingFlow = false;

app.use(express.static(path.join(__dirname, 'static')));

function emptySession() {
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

function stopActiveFlow() {
    activeFlowId++;
    finishingFlow = false;
    if (activeSock) {
        try {
            activeSock.end(undefined);
        } catch (e) {}
        activeSock = null;
    }
}

function beginFlow() {
    stopActiveFlow();
    emptySession();
    return activeFlowId;
}

function isActiveFlow(flowId) {
    return flowId === activeFlowId;
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
        browser: Browsers.macOS('Safari')
    });
}

async function sendSessionMessages(sock, flowId) {
    if (!isActiveFlow(flowId)) return;

    await delay(10000);
    if (!isActiveFlow(flowId)) return;

    const credsPath = path.join(sessionDir, 'creds.json');
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(credsPath)) break;
        await delay(1000);
        if (!isActiveFlow(flowId)) return;
    }

    if (!fs.existsSync(credsPath)) {
        throw new Error(`creds.json not found at ${credsPath}`);
    }

    finishingFlow = true;
    const userJid = jidNormalizedUser(sock.user.id);
    const url = await upload(credsPath);

    if (!isActiveFlow(flowId)) return;

    const sID = url.includes('https://mega.nz/file/')
        ? config.PREFIX + url.split('https://mega.nz/file/')[1]
        : url.replace('https://mega.nz/file/', config.PREFIX);

    await sock.sendMessage(userJid, { text: sID });
    await delay(5000);

    if (!isActiveFlow(flowId)) return;

    await sock.sendMessage(userJid, { text: config.MESSAGE });
    console.log('Session ID sent to WhatsApp');

    await delay(100);
    emptySession();
    finishingFlow = false;
}

async function pairConnector(num, res) {
    const flowId = beginFlow();

    async function runPair(isRetry) {
        if (!isActiveFlow(flowId)) return;

        if (activeSock) {
            try {
                activeSock.end(undefined);
            } catch (e) {}
            activeSock = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        try {
            const sock = makeSocket(state);
            activeSock = sock;

            if (!sock.authState.creds.registered) {
                await delay(1500);
                if (!isActiveFlow(flowId)) return;

                num = num.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(num);
                if (!res.headersSent) {
                    res.send({
                        code: code?.match(/.{1,4}/g)?.join('-') || code
                    });
                }
            } else if (isRetry) {
                console.log('Pair retry: using saved session creds');
            }

            sock.ev.on('creds.update', saveCreds);
            sock.ev.on('connection.update', async (update) => {
                if (!isActiveFlow(flowId)) return;

                const { connection, lastDisconnect } = update;
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                if (connection === 'open') {
                    console.log('Pair connected');
                    try {
                        await sendSessionMessages(sock, flowId);
                    } catch (error) {
                        console.error('Pair post-connect error:', error.message || error);
                    }
                } else if (connection === 'close' && statusCode !== DisconnectReason.loggedOut && !finishingFlow) {
                    console.log('Pair closed, reason:', statusCode);
                    const waitMs = statusCode === DisconnectReason.restartRequired ? 2000 : 10000;
                    await delay(waitMs);
                    if (isActiveFlow(flowId)) {
                        runPair(true);
                    }
                }
            });
        } catch (error) {
            console.error('Pair error:', error.message || error);
            if (!isActiveFlow(flowId)) return;

            if (!isRetry && !res.headersSent) {
                res.status(503).json({ error: 'Service Unavailable' });
            } else if (isActiveFlow(flowId)) {
                await delay(10000);
                runPair(true);
            }
        }
    }

    await runPair(false);
}

async function qrConnector(res) {
    const flowId = beginFlow();

    async function runQr(isRetry) {
        if (!isActiveFlow(flowId)) return;

        if (activeSock) {
            try {
                activeSock.end(undefined);
            } catch (e) {}
            activeSock = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        try {
            const sock = makeSocket(state);
            activeSock = sock;

            sock.ev.on('creds.update', saveCreds);
            sock.ev.on('connection.update', async (update) => {
                if (!isActiveFlow(flowId)) return;

                const { connection, lastDisconnect, qr } = update;
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                if (qr && !res.headersSent) {
                    try {
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
                    try {
                        await sendSessionMessages(sock, flowId);
                    } catch (error) {
                        console.error('QR post-connect error:', error.message || error);
                    }
                } else if (connection === 'close' && statusCode !== DisconnectReason.loggedOut && !finishingFlow) {
                    console.log('QR closed, reason:', statusCode);
                    const waitMs = statusCode === DisconnectReason.restartRequired ? 2000 : 10000;
                    await delay(waitMs);
                    if (isActiveFlow(flowId)) {
                        runQr(true);
                    }
                }
            });
        } catch (error) {
            console.error('QR error:', error.message || error);
            if (!isActiveFlow(flowId)) return;

            if (!isRetry && !res.headersSent) {
                res.status(503).json({ error: 'Service Unavailable' });
            } else if (isActiveFlow(flowId)) {
                await delay(10000);
                runQr(true);
            }
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
        console.log(error);
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
        console.log(error);
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

app.listen(port, () => {
    console.log(`Running on PORT:${port}`);
});
