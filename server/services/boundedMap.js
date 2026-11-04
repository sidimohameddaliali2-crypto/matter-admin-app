// Preserve input order while keeping a fixed number of requests busy. A slow
// request must not hold up the other nineteen workers at a batch boundary.
export const boundedMap = async (items, limit, mapper) => {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await mapper(items[index], index);
    }
  }));
  return output;
};
