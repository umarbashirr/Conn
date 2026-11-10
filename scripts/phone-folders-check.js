'use strict';
const assert = require('assert');
const { phoneFolders } = require('../src/main/phone-folders');

const shop = {
  dir: '/work/shop',
  name: 'shop',
  sessions: [
    { id: 'aaaabbbb-cccc-4ddd-8eee-fffffffffff1', title: 'Cart total', at: 20, provider: 'claude' },
    { id: 'aaaabbbb-cccc-4ddd-8eee-fffffffffff2', title: 'Old receipt', at: 5, provider: 'claude' },
    { id: 'aaaabbbb-cccc-4ddd-8eee-fffffffffff4', title: 'Needs a look', at: 8, provider: 'claude' },
  ],
};
const conn = {
  dir: '/work/conn',
  name: 'conn',
  sessions: [
    { id: 'aaaabbbb-cccc-4ddd-8eee-fffffffffff3', title: 'Phone list', at: 40, provider: 'claude' },
  ],
};

const folders = phoneFolders([shop, conn], {
  completed: {
    'aaaabbbb-cccc-4ddd-8eee-fffffffffff2': 9,
    'aaaabbbb-cccc-4ddd-8eee-fffffffffff4': 11,
  },
  pinned: { 'aaaabbbb-cccc-4ddd-8eee-fffffffffff1': 50 },
  live: {
    'aaaabbbb-cccc-4ddd-8eee-fffffffffff3': 'working',
    'aaaabbbb-cccc-4ddd-8eee-fffffffffff4': 'waiting',
  },
});

assert.deepEqual(folders.map((folder) => folder.name), ['conn', 'shop']);
assert.equal(folders[0].chats[0].state, 'working');
assert.equal(folders[0].chats[0].title, 'Phone list');
assert.deepEqual(folders[1].chats.map((chat) => chat.title), ['Cart total', 'Needs a look']);
assert.equal(folders[1].chats[0].pinAt, 50);
assert.equal(folders[1].chats[1].state, 'waiting');
assert.deepEqual(folders[1].done.map((chat) => chat.title), ['Old receipt']);

console.log('phone-folders-check ok');
