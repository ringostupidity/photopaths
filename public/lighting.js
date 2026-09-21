// Relative image luminance, not lux. Camera exposure affects these estimates.
export function analyzePixels(pixels) {
  let sum = 0,
    squared = 0,
    dark = 0;
  const count = pixels.length / 4;
  if (!count) throw new Error('The camera frame is empty.');
  for (let i = 0; i < pixels.length; i += 4) {
    const value = (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255;
    sum += value;
    squared += value * value;
    if (value < 0.15) dark++;
  }
  const brightness = (sum / count) * 100,
    dark_fraction = dark / count;
  return {
    brightness,
    dark_fraction,
    contrast: Math.sqrt(Math.max(0, squared / count - (sum / count) ** 2)) * 100,
    score: imageScore(brightness, dark_fraction),
  };
}
export const imageScore = (brightness, darkFraction) =>
  Math.round(Math.max(0, Math.min(100, 0.7 * brightness + 30 * (1 - darkFraction))));
export const scoreLabel = (score) =>
  score == null
    ? 'Not enough data'
    : score <= 20
      ? 'Very dark'
      : score <= 40
        ? 'Dark'
        : score <= 60
          ? 'Moderate'
          : score <= 80
            ? 'Well lit'
            : 'Very well lit';
export const scoreColor = (score) =>
  score == null
    ? '#8994a2'
    : score <= 20
      ? '#b73943'
      : score <= 40
        ? '#d77931'
        : score <= 60
          ? '#bd951e'
          : '#358454';
