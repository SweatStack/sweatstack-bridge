const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function isReleaseTag(tag) {
  return RELEASE_TAG.test(tag);
}

/** Negative if `a` comes before `b`. Both are release tags. */
export function compareTags(a, b) {
  const [, ...left] = a.match(RELEASE_TAG);
  const [, ...right] = b.match(RELEASE_TAG);
  for (let part = 0; part < 3; part += 1) {
    const difference = Number(left[part]) - Number(right[part]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The newest release among these names, ignoring anything that isn't one. Null if there are none. */
export function latestTag(tags) {
  return tags.filter(isReleaseTag).sort(compareTags).at(-1) ?? null;
}

/** The changelog's sections for the releases after `after`, or all of them for null, newest first. */
export function changelogAfter(changelog, after) {
  return changelog
    .split(/^(?=## )/m)
    .filter((section) => {
      const version = section.match(/^## (\d+\.\d+\.\d+)/)?.[1];
      return version !== undefined && (after === null || compareTags(`v${version}`, after) > 0);
    })
    .join("")
    .trim();
}
