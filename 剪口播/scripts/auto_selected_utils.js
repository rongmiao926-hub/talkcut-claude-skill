#!/usr/bin/env node

function normalizeSelectedIndices(words, indices) {
  const selected = new Set(
    Array.isArray(indices)
      ? indices.filter(index => Number.isInteger(index) && index >= 0 && index < words.length)
      : []
  );

  let addedBridgeGaps = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word || !word.isGap) continue;

    const gapDuration = Number(word.end) - Number(word.start);
    if (!(gapDuration > 0 && gapDuration < 0.5)) continue;

    let prev = i - 1;
    while (prev >= 0 && words[prev] && words[prev].isGap) prev--;

    let next = i + 1;
    while (next < words.length && words[next] && words[next].isGap) next++;

    if (prev >= 0 && next < words.length && selected.has(prev) && selected.has(next) && !selected.has(i)) {
      selected.add(i);
      addedBridgeGaps++;
    }
  }

  return {
    indices: Array.from(selected).sort((a, b) => a - b),
    addedBridgeGaps,
  };
}

module.exports = {
  normalizeSelectedIndices,
};
