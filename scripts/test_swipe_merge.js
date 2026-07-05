const assert = require('assert');

require('../frontend/swipe_merge.js');

const { mergeSwipeMovie } = globalThis.SwipeMerge || {};

if (typeof mergeSwipeMovie !== 'function') {
  throw new Error('mergeSwipeMovie not loaded');
}

const prev = {
  title: 'Example',
  image: 'prev.jpg',
  imageAbsolute: 'http://example.test/prev.jpg',
  display: 'Example'
};

const incomingMissing = { title: 'Example', image: '', imageAbsolute: '' };
const mergedMissing = mergeSwipeMovie(prev, incomingMissing);
assert.strictEqual(mergedMissing.image, prev.image);
assert.strictEqual(mergedMissing.imageAbsolute, prev.imageAbsolute);

const incomingExplicitNull = { title: 'Example', image: null, imageAbsolute: null };
const mergedNull = mergeSwipeMovie(prev, incomingExplicitNull);
assert.strictEqual(mergedNull.image, null);
assert.strictEqual(mergedNull.imageAbsolute, null);

const incomingReplacement = { title: 'Example', image: 'new.jpg' };
const mergedReplacement = mergeSwipeMovie(prev, incomingReplacement);
assert.strictEqual(mergedReplacement.image, 'new.jpg');
assert.strictEqual(mergedReplacement.imageAbsolute, undefined);

const incomingAbsolute = { title: 'Example', imageAbsolute: 'http://example.test/new.jpg' };
const mergedAbsolute = mergeSwipeMovie(prev, incomingAbsolute);
assert.strictEqual(mergedAbsolute.image, undefined);
assert.strictEqual(mergedAbsolute.imageAbsolute, 'http://example.test/new.jpg');

console.log('test_swipe_merge: ok');
