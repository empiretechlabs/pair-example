const mega = require('megajs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config.js');

function randomName(ext) {
    return `${crypto.randomBytes(5).toString('hex')}${ext || '.json'}`;
}

function upload(input, name) {
    return new Promise((resolve, reject) => {
        let content;
        let fileName = name || randomName('.json');

        if (typeof input === 'string') {
            const filePath = path.resolve(input);
            if (!fs.existsSync(filePath)) {
                return reject(new Error(`Session file not found: ${filePath}`));
            }
            content = fs.readFileSync(filePath);
            if (!name) {
                fileName = randomName(path.extname(filePath) || '.json');
            }
        } else if (Buffer.isBuffer(input)) {
            content = input;
        } else {
            return reject(new Error('Upload expects a file path or buffer'));
        }

        const storage = new mega.Storage({
            email: config.EMAIL,
            password: config.PASS
        }, (err) => {
            if (err) {
                return reject(err);
            }

            try {
                const stream = storage.upload({
                    name: fileName,
                    size: content.length,
                    allowUploadBuffering: true
                });

                stream.end(content);
                stream.on('complete', (file) => {
                    file.link((linkErr, url) => (linkErr ? reject(linkErr) : resolve(url)));
                });
                stream.on('error', reject);
            } catch (error) {
                reject(error);
            }
        });
    });
}

module.exports = { upload };
