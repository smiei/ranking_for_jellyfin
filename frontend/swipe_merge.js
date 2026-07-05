(function (root) {
  'use strict';

  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  function hasMeaningfulValue(val) {
    if (val === null || val === undefined) return false;
    if (typeof val === 'string') return val.trim() !== '';
    return true;
  }

  function mergeSwipeMovie(prev, incoming, options) {
    if (!prev) return incoming || {};
    if (!incoming) return { ...prev };
    const merged = { ...prev, ...incoming };
    const opts = options || {};
    const onPreserve = typeof opts.onPreserve === 'function' ? opts.onPreserve : null;

    const incomingHasImage = hasOwn(incoming, 'image');
    const incomingHasImageAbs = hasOwn(incoming, 'imageAbsolute');
    const incomingImageExplicitNull = incomingHasImage && incoming.image === null;
    const incomingAbsExplicitNull = incomingHasImageAbs && incoming.imageAbsolute === null;
    const incomingImageValue = hasMeaningfulValue(incoming.image);
    const incomingAbsValue = hasMeaningfulValue(incoming.imageAbsolute);
    const incomingHasValue = incomingImageValue || incomingAbsValue;
    const shouldPreserve = !incomingHasValue && !incomingImageExplicitNull && !incomingAbsExplicitNull;

    if (shouldPreserve && hasMeaningfulValue(prev.image)) {
      merged.image = prev.image;
      if (onPreserve) onPreserve('image', prev, incoming);
    }
    if (shouldPreserve && hasMeaningfulValue(prev.imageAbsolute)) {
      merged.imageAbsolute = prev.imageAbsolute;
      if (onPreserve) onPreserve('imageAbsolute', prev, incoming);
    }

    if (incomingImageValue && !incomingAbsValue && !incomingAbsExplicitNull) {
      delete merged.imageAbsolute;
    }
    if (incomingAbsValue && !incomingImageValue && !incomingImageExplicitNull) {
      delete merged.image;
    }

    return merged;
  }

  root.SwipeMerge = { hasMeaningfulValue, mergeSwipeMovie };
})(typeof window !== 'undefined' ? window : globalThis);
