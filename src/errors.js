export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, `${label} must be a number between ${min} and ${max}.`);
  }
  return value;
}
export function coordinates(value) {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'A location is required.');
  return {
    latitude: number(value.latitude ?? value.lat, -85, 85, 'Latitude'),
    longitude: number(value.longitude ?? value.lon, -180, 180, 'Longitude'),
  };
}
