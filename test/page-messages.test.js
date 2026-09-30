// Every kind of message the server broadcasts to pages has a handler in
// public/js/websocket.js. The page drops what it has no handler for, without
// a word, so a new broadcast nobody wired up would go unnoticed.
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sources = ['lib', 'routes'].flatMap(dir => fs.readdirSync(path.join(root, dir))
    .filter(f => f.endsWith('.js') && f !== 'mock-chromecast.js')
    .map(f => path.join(root, dir, f)));

function broadcastTypes() {
    const types = new Map();
    for (const file of sources) {
        const text = fs.readFileSync(file, 'utf8');
        for (const [, type] of text.matchAll(/broadcast\(\s*\{[^}]*?type:\s*'(\w+)'/gs)) {
            types.set(type, path.relative(root, file));
        }
    }
    return types;
}

function pageHandlers() {
    const text = fs.readFileSync(path.join(root, 'public/js/websocket.js'), 'utf8');
    const block = text.slice(text.indexOf('const handlers = {'), text.indexOf('};', text.indexOf('const handlers = {')));
    return new Set([...block.matchAll(/^\s{4}(\w+):/gm)].map(m => m[1]));
}

test('the scan finds the broadcasts it should', () => {
    const types = broadcastTypes();
    for (const type of ['devices', 'playerStatus', 'volume', 'castError', 'queue']) assert.ok(types.has(type), type);
});

test('the page handles every message the server broadcasts', () => {
    const handlers = pageHandlers();
    const missing = [...broadcastTypes()].filter(([type]) => !handlers.has(type)).map(([type, file]) => `${type} (${file})`);
    assert.deepStrictEqual(missing, []);
});
