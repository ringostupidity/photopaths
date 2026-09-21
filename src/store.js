import Redis from 'ioredis';
import { HttpError } from './errors.js';

const PREFIX = 'photopath:v1';
const publicRecord = ({ owner, ...record }) => record;
export class Store {
  constructor(url) {
    if (!url?.startsWith('rediss://'))
      throw new Error('Set UPSTASH_REDIS_URL to your TLS rediss:// connection URL.');
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 8000,
      commandTimeout: 10000,
      retryStrategy: () => null,
    });
    this.redis.on('error', () => {}); // Request handlers return a generic 503; never log credentials.
  }
  async run(fn) {
    try {
      if (this.redis.status === 'end') {
        this.reconnecting ??= this.redis.connect().finally(() => {
          this.reconnecting = null;
        });
        await this.reconnecting;
      }
      return await fn(this.redis);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(503, 'The lighting database is unavailable. Please try again.');
    }
  }
  async ping() {
    return this.run((r) => r.ping());
  }
  async save(kind, record) {
    return this.run(async (r) => {
      const result = await r
        .multi()
        .hset(`${PREFIX}:${kind}`, record.id, JSON.stringify(record))
        .geoadd(`${PREFIX}:${kind}:geo`, record.longitude, record.latitude, record.id)
        .sadd(`${PREFIX}:owner:${record.owner}`, `${kind}:${record.id}`)
        .exec();
      if (result.some(([e]) => e)) throw new Error('Write failed');
      return publicRecord(record);
    });
  }
  async nearby(kind, lat, lon, radius) {
    return this.run(async (r) => {
      const ids = await r.call(
        'GEOSEARCH',
        `${PREFIX}:${kind}:geo`,
        'FROMLONLAT',
        lon,
        lat,
        'BYRADIUS',
        radius,
        'm',
        'ASC',
        'COUNT',
        501,
      );
      const values = ids.length ? await r.hmget(`${PREFIX}:${kind}`, ...ids.slice(0, 500)) : [];
      return {
        items: values.filter(Boolean).map((v) => publicRecord(JSON.parse(v))),
        truncated: ids.length > 500,
      };
    });
  }
  async mine(owner) {
    return this.run(async (r) => {
      const keys = await r.smembers(`${PREFIX}:owner:${owner}`);
      const values = await Promise.all(
        keys.map((key) => {
          const [kind, id] = key.split(':');
          return r
            .hget(`${PREFIX}:${kind}`, id)
            .then((v) => (v ? { kind, ...publicRecord(JSON.parse(v)) } : null));
        }),
      );
      return values.filter(Boolean).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    });
  }
  async remove(kind, id, owner) {
    return this.run(async (r) => {
      const result = await r.eval(
        `
        local raw = redis.call('HGET', KEYS[1], ARGV[1])
        if not raw then return 0 end
        if cjson.decode(raw).owner ~= ARGV[2] then return -1 end
        redis.call('HDEL', KEYS[1], ARGV[1])
        redis.call('ZREM', KEYS[2], ARGV[1])
        redis.call('SREM', KEYS[3], ARGV[3])
        redis.call('DEL', KEYS[4])
        return 1`,
        4,
        `${PREFIX}:${kind}`,
        `${PREFIX}:${kind}:geo`,
        `${PREFIX}:owner:${owner}`,
        `${PREFIX}:votes:${id}`,
        id,
        owner,
        `${kind}:${id}`,
      );
      if (result !== 1)
        throw new HttpError(
          result === 0 ? 404 : 403,
          result === 0
            ? 'Contribution not found.'
            : 'Only the contributing browser can delete this item.',
        );
    });
  }
  async vote(id, owner, action) {
    return this.run(async (r) => {
      const result = await r.eval(
        `
        local raw = redis.call('HGET', KEYS[1], ARGV[1])
        if not raw then return 'missing' end
        local report = cjson.decode(raw)
        if report.owner == ARGV[2] then return 'self' end
        if redis.call('SADD', KEYS[2], ARGV[2]) == 0 then return 'duplicate' end
        if ARGV[3] == 'confirm' then report.confirmations = report.confirmations + 1
        else report.repair_votes = report.repair_votes + 1 end
        if report.repair_votes >= 2 then report.status = 'community_resolved'
        elseif report.confirmations >= 2 then report.status = 'corroborated' end
        local encoded = cjson.encode(report)
        redis.call('HSET', KEYS[1], ARGV[1], encoded)
        return encoded`,
        2,
        `${PREFIX}:reports`,
        `${PREFIX}:votes:${id}`,
        id,
        owner,
        action,
      );
      const errors = {
        missing: [404, 'Report not found.'],
        self: [400, 'You cannot verify your own report.'],
        duplicate: [409, 'This browser has already reviewed this report.'],
      };
      if (errors[result]) throw new HttpError(...errors[result]);
      return publicRecord(JSON.parse(result));
    });
  }
  close() {
    this.redis.disconnect();
  }
}
