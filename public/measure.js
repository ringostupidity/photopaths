import { $, api, ready, busy, message, locate, coordsText } from './common.js';
import { analyzePixels, scoreLabel, scoreColor } from './lighting.js';
await ready;
let stream, reading, capturedAt;
const video = $('camera'),
  canvas = $('capture-preview');
function stop() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  video.hidden = true;
  $('capture').disabled = true;
  $('close-camera').hidden = true;
  $('open-camera').hidden = false;
  $('camera-placeholder').hidden = !canvas.hidden;
}
$('open-camera').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Camera access needs HTTPS or localhost and a supported browser.');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 } },
        audio: false,
      });
      if (document.hidden) {
        stop();
        return;
      }
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      canvas.hidden = true;
      $('camera-placeholder').hidden = true;
      $('open-camera').hidden = true;
      $('close-camera').hidden = false;
      $('capture').disabled = false;
      $('reading').hidden = true;
      reading = null;
      message('Hold steady and point toward the path. Capture when ready.');
    } catch {
      stop();
      throw new Error('Could not open the camera. Check camera permission and try again.');
    }
  }),
);
$('close-camera').addEventListener('click', stop);
$('capture').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    if (!stream || !video.videoWidth)
      throw new Error('Wait for the camera preview before capturing.');
    message('Getting the location for this reading…');
    const location = await locate();
    if (!stream || !video.videoWidth)
      throw new Error('The camera was closed. Open it to capture a new reading.');
    if (location.accuracy > 100)
      throw new Error(
        'GPS accuracy is over 100 m. Move outdoors and try again before sharing a reading.',
      );
    canvas.width = 320;
    canvas.height = Math.round((320 * video.videoHeight) / video.videoWidth);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    reading = {
      ...analyzePixels(context.getImageData(0, 0, canvas.width, canvas.height).data),
      latitude: location.latitude,
      longitude: location.longitude,
    };
    capturedAt = Date.now();
    canvas.hidden = false;
    stop();
    $('score').textContent = reading.score;
    $('score').style.color = scoreColor(reading.score);
    $('score-label').textContent = scoreLabel(reading.score);
    $('brightness').textContent = `${Math.round(reading.brightness)}%`;
    $('darkness').textContent = `${Math.round(reading.dark_fraction * 100)}%`;
    $('contrast').textContent = `${Math.round(reading.contrast)}%`;
    $('measurement-location').textContent =
      `${coordsText(location)} · GPS accuracy ~${Math.round(location.accuracy)} m · ${new Date(capturedAt).toLocaleTimeString()}`;
    $('share-consent').checked = false;
    $('reading').hidden = false;
    $('save-measurement').disabled = false;
    message('Reading captured. Review it and choose whether to share.');
  }).finally(() => {
    $('capture').disabled = !stream;
  }),
);
$('save-measurement').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    if (!reading) throw new Error('Capture a new reading first.');
    if (Date.now() - capturedAt > 120000)
      throw new Error('This reading is over two minutes old. Please capture a fresh reading.');
    if (!$('share-consent').checked)
      throw new Error('Check the sharing box to contribute this reading.');
    const data = await api('/api/measurements', { ...reading, consent: true });
    reading = null;
    $('reading').hidden = true;
    message(
      data.data.is_night
        ? 'Measurement shared. It is now available on the lighting map.'
        : 'Reading saved as daytime data. Only nighttime readings contribute to route visibility scores.',
    );
  }),
);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop();
});
window.addEventListener('pagehide', stop);
