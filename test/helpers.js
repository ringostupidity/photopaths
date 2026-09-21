import { HttpError } from '../src/errors.js';
import { distance } from '../src/scoring.js';
const clean = ({ owner, ...record }) => record;
export class MemoryStore {
  records = { reports: new Map(), measurements: new Map() };
  votes = new Map();
  async ping() {
    return 'PONG';
  }
  async save(kind, record) {
    this.records[kind].set(record.id, structuredClone(record));
    return clean(record);
  }
  async nearby(kind, lat, lon, radius) {
    return {
      items: [...this.records[kind].values()]
        .filter((r) => distance(r, { latitude: lat, longitude: lon }) <= radius)
        .map(clean),
      truncated: false,
    };
  }
  async mine(owner) {
    return Object.entries(this.records).flatMap(([kind, entries]) =>
      [...entries.values()].filter((r) => r.owner === owner).map((r) => ({ kind, ...clean(r) })),
    );
  }
  async remove(kind, id, owner) {
    const record = this.records[kind].get(id);
    if (!record) throw new HttpError(404, 'Contribution not found.');
    if (record.owner !== owner)
      throw new HttpError(403, 'Only the contributing browser can delete this item.');
    this.records[kind].delete(id);
  }
  async vote(id, owner, action) {
    const report = this.records.reports.get(id);
    if (!report) throw new HttpError(404, 'Report not found.');
    if (report.owner === owner) throw new HttpError(400, 'You cannot verify your own report.');
    const voters = this.votes.get(id) || new Set();
    if (voters.has(owner))
      throw new HttpError(409, 'This browser has already reviewed this report.');
    voters.add(owner);
    this.votes.set(id, voters);
    if (action === 'confirm') report.confirmations++;
    else report.repair_votes++;
    if (report.repair_votes >= 2) report.status = 'community_resolved';
    else if (report.confirmations >= 2) report.status = 'corroborated';
    return clean(report);
  }
}
export const fixtureProviders = {
  geocode: async (query) =>
    query === 'missing' ? [] : [{ lat: 33.911, lon: -117.89, name: 'Test park' }],
  routes: async (start, end) =>
    [0, 1].map((i) => ({
      id: `route-${i}`,
      distance: 200 + i * 20,
      duration_seconds: 180 + i * 30,
      duration: 3 + i,
      geometry: {
        type: 'LineString',
        coordinates: [
          [start.longitude, start.latitude],
          [end.longitude + i * 0.0002, end.latitude],
          [end.longitude, end.latitude],
        ],
      },
      steps: [{ instruction: 'Walk toward Test park', distance: 200 }],
    })),
  lamps: async () => ({
    ways: [
      {
        id: 123,
        name: 'Test lit path',
        lit: 'yes',
        coordinates: [
          [-117.89, 33.91],
          [-117.89, 33.911],
        ],
      },
    ],
    items: [
      {
        id: 1,
        latitude: 33.91,
        longitude: -117.89,
        status: 'Mapped infrastructure; operating status unknown',
      },
    ],
    truncated: false,
  }),
};
