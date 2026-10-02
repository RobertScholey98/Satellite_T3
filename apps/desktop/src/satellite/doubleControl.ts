/** Recognize two standalone Ctrl taps, excluding repeats, holds, and key combinations. */
export function createDoubleControlDetector() {
  const down = new Set<number>();
  let started: number | undefined;
  let previous: number | undefined;
  return (key: number, released: boolean, now: number): boolean => {
    const control = key === 0xa2 || key === 0xa3;
    if (!released) {
      if (down.has(key)) return false;
      down.add(key);
      if (control && down.size === 1) started = now;
      else {
        started = undefined;
        previous = undefined;
      }
      return false;
    }
    if (!down.delete(key) || !control) return false;
    const valid = started !== undefined && now - started <= 400 && down.size === 0;
    started = undefined;
    if (!valid) {
      previous = undefined;
      return false;
    }
    if (previous !== undefined && now - previous <= 400) {
      previous = undefined;
      return true;
    }
    previous = now;
    return false;
  };
}
