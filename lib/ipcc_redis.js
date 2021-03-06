//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  backendjs 2018
//

const util = require('util');
const dns = require('dns');
const logger = require(__dirname + '/logger');
const core = require(__dirname + '/core');
const lib = require(__dirname + '/lib');
const ipc = require(__dirname + "/ipc");
const Client = require(__dirname + "/ipc_client");

// Cache/queue client based on Redis server using https://github.com/NodeRedis/node_redis
//
// To support more than one master Redis server in the client:
//
//    ipc-cache=redis://host1?bk-servers=host2,host3
//    ipc-cache-backup=redis://host2
//    ipc-cache-backup-options-max_attempts=3
//
// To support sentinels:
//
//    ipc-cache=redis://host1?bk-servers=host1,host3&bk-max_attempts=3&bk-sentinel-servers=host2,host3
//    ipc-cache-backup=redis://host2
//    ipc-cache-backup-options-sentinel-servers=host1,host2
//    ipc-cache-backup-options-sentinel-max_attempts=5
//
// The queue client implements reliable queue using sorted sets, one for the new messages and one for the
// messages that are being processed if timeout is provided. With the timeout this queue works similar to AWS SQS.
//
// The `queue` config property specifies the name for the queue, if not given `queue` is used
//
// The `interval` config property defines in ms how often to check for new messages after processing a message, i.e. after a messages processed
// it can poll immediately or after this amount of time
//
// The `retryInterval` config property defines in ms how often to check for new messages after an error or no data, i.e. on empty
// pool when no messages are processed it can poll immediately or after this amount of time
//
// The `visibilityTimeout` property specifies to use a shadow queue where all messages that are being processed are stored,
// while the message is processed the timestamp will be updated so the message stays in the queue, if a worker exists or crashes without
// confirming the message finished it will be put back into the work queue after `visibilityTimeout` milliseconds. The queue name that
// keeps active messages is appended with #.
//
//
// The `threshold` property defines the upper limit of how many active messages can be in the queue when to show an error message, this is
// for monitoring queue performance
//
// The rate limiter implementes Tocken Bucket algorithm using Lua script inside Redis, the only requirement is that
// all workers to use NTP for time synchronization
//
// Examples:
//
//      ipc-cache=redis://host1
//      ipc-cache-options-interval=1000
//      ipc-cache=redis://host1?bk-visibilityTimeout=30000&bk-count=2
//

const client = {
    name: "redis",
    scripts: {
        sget: [
            "redis.replicate_commands()",
            "local val = redis.call(KEYS[2], KEYS[1]);",
            "local size = redis.call('scard', KEYS[1]);",
            "local ttl = tonumber(KEYS[3]);",
            "if KEYS[2] == 'spop' and ttl > 0 then",
            "  while (val) do",
            "    if redis.call('exists', val .. '#') == 0 then break; end;",
            "    val = redis.call('spop', KEYS[1]);",
            "  end;",
            "  if val then redis.call('psetex', val .. '#', ttl, ''); end;",
            "end;",
            "return {val,size};",
        ].join("\n"),

        monitor: [
            "local time = tonumber(KEYS[2]);",
            "local vals = redis.call('zrangebyscore', KEYS[1] .. '#', 0, time);",
            "redis.call('zremrangebyscore', KEYS[1] .. '#', 0, time);",
            "for i, val in ipairs(vals) do redis.call('zadd', KEYS[1], time+i, (val)); end;",
            "return redis.call('zcount', KEYS[1], '-inf', '+inf');"
        ].join("\n"),

        vpoller: [
            "local val = redis.call('zrange', KEYS[1], 0, 0)[1];",
            "if val then ",
            "  redis.call('zremrangebyrank', KEYS[1], 0, 0);",
            "  redis.call('zadd', KEYS[1] .. '#', tonumber(KEYS[2]), val);",
            "end;",
            "local count1 = redis.call('zcount', KEYS[1], '-inf', '+inf');",
            "local count2 = redis.call('zcount', KEYS[1] .. '#', '-inf', '+inf');",
            "return {val,count1,count2};"
        ].join(""),

        poller: [
            "local val = redis.call('zrange', KEYS[1], 0, 0)[1];",
            "if val then redis.call('zremrangebyrank', KEYS[1], 0, 0); end;",
            "local count = redis.call('zcount', KEYS[1], '-inf', '+inf');",
            "return {val,count};"
        ].join(""),

        stats: [
            "local count1 = redis.call('zcount', KEYS[1], '-inf', '+inf');",
            "local count2 = redis.call('zcount', KEYS[1] .. '#', '-inf', '+inf');",
            "return {count1,count2};"
        ].join(""),

        limiter: [
            "local name = KEYS[1];",
            "local rate = tonumber(KEYS[2]);",
            "local max = tonumber(KEYS[3]);",
            "local interval = tonumber(KEYS[4]);",
            "local now = tonumber(KEYS[5]);",
            "local ttl = tonumber(KEYS[6]);",
            "local reset = tonumber(KEYS[7]);",
            "local count = tonumber(redis.call('HGET', name, 'count'));",
            "local mtime = tonumber(redis.call('HGET', name, 'mtime'));",
            "if not mtime then",
            "   count = max;",
            "   mtime = now;",
            "end;",
            "if now < mtime then",
            "   mtime = now - interval;",
            "end;",
            "local elapsed = now - mtime;",
            "if count < max then",
            "   count = math.min(max, count + rate * (elapsed / interval));",
            "   redis.call('HSET', name, 'count', count);",
            "end;",
            "redis.call('HSET', name, 'mtime', now);",
            "local total = redis.call('HINCRBY', name, 'total', 1);",
            "if ttl > 0 then",
            "   redis.call('EXPIRE', name, ttl);",
            "end;",
            "if count < 1 then",
            "   if reset > 0 then",
            "      redis.call('DEL', name);",
            "   end;",
            "   return {interval - elapsed,count,total,elapsed};",
            "else",
            "   if reset > 1 and total >= reset then",
            "      redis.call('DEL', name);",
            "   else",
            "      redis.call('HSET', name, 'count', count - 1);",
            "   end;",
            "   return {0,count,total,elapsed};",
            "end"
        ].join(""),

        getset: [
            "local v = redis.call('get', KEYS[1]);",
            "if not v then",
            "   redis.call('set', KEYS[1], KEYS[3]);",
            "   local ttl = tonumber(KEYS[2]);",
            "   if ttl > 0 then",
            "      redis.call('pexpire', KEYS[1], ttl);",
            "   end;",
            "end;",
            "return v;",
        ].join(""),

        setmax: [
            "local v = tonumber(redis.call('get', KEYS[1]));",
            "if not v or v < tonumber(KEYS[2]) then",
            "   redis.call('set', KEYS[1], KEYS[2]);",
            "   local ttl = tonumber(KEYS[3]);",
            "   if ttl > 0 then",
            "      redis.call('pexpire', KEYS[1], ttl);",
            "   end;",
            "end;",
            "return v;",
        ].join(""),

        hmsetmax: [
            "local v = tonumber(redis.call('hget', KEYS[1], KEYS[2]));",
            "if not v or v < tonumber(KEYS[3]) then",
            "   redis.call('hmset', KEYS[1], KEYS[2], KEYS[3]);",
            "   local ttl = tonumber(KEYS[4]);",
            "   if ttl > 0 then",
            "      redis.call('pexpire', KEYS[1], ttl);",
            "   end;",
            "end;",
            "return v;",
        ].join(""),

        lock: [
            "local ttl = tonumber(KEYS[2]);",
            "if tonumber(KEYS[4]) == 1 then",
            "   redis.call('set', KEYS[1], KEYS[3]);",
            "   if ttl > 0 then",
            "      redis.call('pexpire', KEYS[1], ttl);",
            "   end;",
            "end;",
            "local v = redis.call('setnx', KEYS[1], KEYS[3]);",
            "if v == 1 and ttl > 0 then",
            "   redis.call('pexpire', KEYS[1], ttl);",
            "end;",
            "return v;",
        ].join(""),

    },
};
module.exports = client;

ipc.modules.push(client);

client.createClient = function(url, options)
{
    if (url.match(/^redisq?:/)) return new IpcRedisClient(url, options);
}

client.parseOptions = function(val, options)
{
    if (options.keys[3] && options.keys[3].indexOf("sentinel-") == 0) {
        options.name = options.keys[3].split("-").slice(-1);
        options.obj += ".sentinel";
        options.make = "";
    }
}

function IpcRedisClient(url, options)
{
    Client.call(this, url, options);
    this.applyOptions();
    this.initClient("client", this.hostname, this.port);
    this.initSentinel();
}
util.inherits(IpcRedisClient, Client);

IpcRedisClient.prototype.close = function()
{
    Client.prototype.close.call(this);
    if (this.client) this.client.quit();
    if (this.sentinel) this.sentinel.end(true);
    this._monitorTimer = clearInterval(this._monitorTimer);
}

IpcRedisClient.prototype.applyOptions = function()
{
    if (!this.options.queue) this.options.queue = "queue";
    this.options.interval = lib.toNumber(this.options.interval, { dflt: 500, min: 50 });
    this.options.retryInterval = lib.toNumber(this.options.retryInterval, { dflt: 5000, min: 50 });
    this.options.monitorInterval = lib.toNumber(this.options.monitorInterval, { min: 0 });
    this.options.visibilityTimeout = lib.toNumber(this.options.visibilityTimeout, { min: 0 });
    this.options.threshold = lib.toNumber(this.options.threshold, { min: 0 });
    this.options.maxTimeout = lib.toNumber(this.options.maxTimeout, { dflt: 3600000, min: 60000 });
    this.options.servers = lib.strSplitUnique(this.options.servers);
    this.options.enable_offline_queue = lib.toBool(this.options.enable_offline_queue);
    if (this.options.servers.length) {
        var h = (this.hostname || "127.0.0.1") + ":" + (this.port || this.options.port || 6379);
        if (this.options.servers.indexOf(h) == -1) this.options.servers.push(h);
    }
}

IpcRedisClient.prototype.initClient = function(name, host, port)
{
    var opts = this.options[name] || this.options;
    host = String(host).split(":");
    // For reconnect or failover to work need retry policy
    var connect_timeout = lib.toNumber(opts.connect_timeout, { min: 60000, dflt: 900000 });
    var retry_max_delay = lib.toNumber(opts.retry_max_delay, { min: 1000, dflt: 30000 });
    var max_attempts = lib.toNumber(opts.max_attempts, { min: 1, dflt: 10 });
    var self = this;
    opts.retry_strategy = function(options) {
        logger.logger(options.attempt == 2 ? "error": "dev", "initClient:", name, self.url, options);
        if (options.total_retry_time > connect_timeout || (lib.isArray(opts.servers) && options.attempt > max_attempts)) {
            setTimeout(self.onError.bind(self, self.name, { code: 'CONNECTION_BROKEN', message: options.error && options.error.message }), 100);
            return undefined;
        }
        return Math.min((options.attempt % max_attempts) * 200, retry_max_delay);
    }
    var Redis = require("redis");
    var client = new Redis.createClient(host[1] || port || opts.port || 6379, host[0] || "127.0.0.1", opts);
    client.on("error", this.onError.bind(this, name));

    switch (name) {
    case "sentinel":
        client.on('pmessage', this.onSentinelMessage.bind(this));
        client.on("ready", this.onSentinelConnect.bind(this));
        break;

    default:
        client.on("ready", this.emit.bind(this, "ready"));
        client.on("message", this.onMessage.bind(this, name));
        client.on("connect", this.onConnect.bind(this, name));
    }

    if (this[name]) this[name].end(true);
    this[name] = client;
    logger.debug("initClient:", name, this.url, "connecting:", host, port);
}

IpcRedisClient.prototype.onConnect = function(name)
{
    logger.debug("onConnect:", name, this.url, "connected", this[name].address);
    this.emit("connect");
}

IpcRedisClient.prototype.onMessage = function(name, channel, msg)
{
    logger.dev("onMessage:", name, channel, msg);
    this.emit(channel, msg);
}

IpcRedisClient.prototype.onError = function(name, err)
{
    logger.error("onError:", core.role, name, err);
    if (err.code == 'CONNECTION_BROKEN') {
        this.emit("disconnect");
        var opts = this.options[name] || this.options;
        var host = opts.servers.shift();
        if (!host) return;
        opts.servers.push(host);
        logger.debug("disconnect:", core.role, name, this.url, "trying", host, "of", opts.servers);
        setTimeout(this.initClient.call(this, name, host), opts.reconnect_timeout || 50);
    }
}

IpcRedisClient.prototype.limiter = function(options, callback)
{
    var self = this;
    this.client.eval(client.scripts.limiter, 7,
                     options.name,
                     options.rate,
                     options.max,
                     options.interval,
                     Date.now(),
                     Math.ceil(options.ttl/1000),
                     options.reset,
                     function(err, rc) {
        rc = rc || lib.empty;
        if (err) logger.error("limiter:", core.role, self.url, lib.traceError(err));
        callback(lib.toNumber(rc[0]), { queueName: self.queueName, delay: lib.toNumber(rc[0]), count: lib.toNumber(rc[1]), total: lib.toNumber(rc[2]), elapsed: lib.toNumber(rc[3]) });
    });
}

IpcRedisClient.prototype.subscribe = function(channel, options, callback)
{
    Client.prototype.subscribe.call(this, channel, options, callback);
    if (!this.client.enable_offline_queue) this.client.enable_offline_queue = true;
    this.client.subscribe(channel);
}

IpcRedisClient.prototype.unsubscribe = function(channel, options, callback)
{
    Client.prototype.unsubscribe.call(this, channel, options, callback);
    if (!this.client.enable_offline_queue) this.client.enable_offline_queue = true;
    this.client.unsubscribe(channel);
}

IpcRedisClient.prototype.publish = function(channel, msg, options, callback)
{
    if (!this.client.enable_offline_queue) this.client.enable_offline_queue = true;
    this.client.publish(channel, msg, callback);
}

IpcRedisClient.prototype.stats = function(options, callback)
{
    var self = this;
    var rc = {};
    lib.parallel([
        function(next) {
            self.client.eval(client.scripts.stats, 1, self.options.queue, (err, count) => {
                if (!err) {
                    rc.queueCount = lib.toNumber(count[0]);
                    rc.queueRunning = lib.toNumber(count[1]);
                }
                next(err);
            });
        },
        function(next) {
            self.client.info(function(err, str) {
                lib.strSplit(str, "\n").filter((x) => (x.indexOf(":") > -1)).forEach((x) => {
                    x = x.split(":");
                    rc[x[0]] = x[1];
                });
                next(err);
            });
        },
    ], (err) => {
        lib.tryCall(callback, err, rc);
    });
}

IpcRedisClient.prototype.clear = function(pattern, callback)
{
    var self = this;
    if (pattern) {
        this.client.keys(pattern, function(e, keys) {
            for (var i in keys) {
                self.client.del(keys[i], lib.noop);
            }
            lib.tryCall(callback, e);
        });
    } else {
        this.client.flushall(callback);
    }
}

IpcRedisClient.prototype.get = function(key, options, callback)
{
    options = options || lib.empty;
    if (options.listName) {
        if (key == "*") {
            if (options.del) {
                this.client.spop(options.listName, 9999999999, callback);
            } else {
                this.client.smembers(options.listName, callback);
            }
        } else
        if (!key) {
            this.client.eval(client.scripts.sget, 3, options.listName, options.del ? "spop" : "srandmember", lib.toNumber(options.ttl), callback);
        } else {
            this.client.sismember(options.listName, key, callback);
        }
    } else
    if (options.mapName) {
        if (key == "*") {
            this.client.hgetall(options.mapName, callback);
        } else
        if (Array.isArray(key)) {
            this.client.hmget(options.mapName, key, callback);
        } else {
            this.client.hget(options.mapName, key, callback);
        }
    } else
    if (Array.isArray(key)) {
        this.client.mget(key, callback);
    } else
    if (options.set) {
        var ttl = lib.toNumber(options.ttl) || lib.toNumber(this.options.ttl);
        this.client.eval(client.scripts.getset, 3, key, ttl, options.set, callback);
    } else {
        this.client.get(key, callback);
    }
}

IpcRedisClient.prototype.put = function(key, val, options, callback)
{
    options = options || lib.empty;
    var ttl = lib.toNumber(options.ttl) || lib.toNumber(this.options.ttl);
    switch (typeof val) {
    case "boolean":
    case "number":
    case "string":
        break;
    default:
        if (!(options.mapName && key == "*") &&
            !(options.listName && Array.isArray(val))) val = lib.stringify(val);
    }
    if (options.listName) {
        if (lib.isEmpty(val)) return lib.tryCall(callback);
        const multi = this.client.multi();
        multi.sadd(options.listName, val);
        if (ttl > 0) multi.pexpire(options.listName, ttl);
        multi.exec(callback);
    } else
    if (options.mapName) {
        if (options.setmax) {
            this.client.eval(client.scripts.hmsetmax, 4, options.mapName, key, val, ttl, callback);
        } else {
            const multi = this.client.multi();
            if (key == "*") {
                multi.hmset(options.mapName, val);
            } else {
                multi.hmset(options.mapName, key, val);
            }
            if (ttl > 0) multi.pexpire(options.mapName, ttl);
            multi.exec(callback);
        }
    } else {
        if (options.setmax) {
            this.client.eval(client.scripts.setmax, 3, key, val, ttl, callback);
        } else
        if (ttl > 0) {
            this.client.psetex([key, ttl, val], callback || lib.noop);
        } else {
            this.client.set([key, val], callback || lib.noop);
        }
    }
}

IpcRedisClient.prototype.incr = function(key, val, options, callback)
{
    options = options || lib.empty;
    var ttl = lib.toNumber(options.ttl) || lib.toNumber(this.options.ttl);
    if (options.mapName) {
        var multi = this.client.multi();
        multi.hincrby(options.mapName, key, val);
        if (ttl > 0) multi.pexpire(options.mapName, ttl);
        multi.exec(callback);
    } else {
        if (ttl > 0) {
            this.client.multi().incrby(key, val).expire(key, Math.ceil(ttl/1000)).exec(function(e, v) {
                if (callback) callback(e, v && v[0]);
            });
        } else {
            this.client.incrby(key, val, callback);
        }
    }
}

IpcRedisClient.prototype.del = function(key, options, callback)
{
    options = options || lib.empty;
    if (options.listName) {
        this.client.srem(options.listName, key, callback || lib.noop)
    } else
    if (options.mapName) {
        if (key == "*") {
            this.client.del(options.mapName, callback || lib.noop)
        } else {
            this.client.hdel(options.mapName, key, callback || lib.noop)
        }
    } else {
        this.client.del(key, callback || lib.noop);
    }
}

IpcRedisClient.prototype.lock = function(name, options, callback)
{
    var ttl = lib.toNumber(options && options.ttl);
    var set = lib.toBool(options && options.set);
    this.client.eval(client.scripts.lock, 4, name, ttl, process.pid, set ? 1 : 0, callback);
}

IpcRedisClient.prototype.unlock = function(name, options, callback)
{
    this.client.del(name, callback || lib.noop);
}

IpcRedisClient.prototype.listen = function(options, callback)
{
    Client.prototype.listen.call(this, options, callback);
}

IpcRedisClient.prototype.unlisten = function(options, callback)
{
    Client.prototype.unlisten.call(this, options, callback);
}

IpcRedisClient.prototype.submit = function(job, options, callback)
{
    this.client.zadd(this.options.queue, Date.now(), lib.stringify(job), callback);
}

IpcRedisClient.prototype.monitorQueue = function()
{
    var self = this;
    if (!this.client.ready) return;
    var now = Date.now() - this.options.visibilityTimeout;
    this.client.eval(client.scripts.monitor, 2, this.options.queue, now, function(err, count) {
        if (err) logger.error("monitorQueue:", self.url, err);
        // Report when queue size reaches configured threshold
        if (!count || !self.options.threshold) return;
        count = lib.toNumber(count);
        if (count >= self.options.threshold) logger.error("monitorQueue:", core.role, self.url, self.options, "queue size:", count);
    });
}

IpcRedisClient.prototype.monitor = function()
{
    if (this.options.queue && !this._monitorTimer && this.options.visibilityTimeout) {
        this._monitorTimer = setInterval(this.monitorQueue.bind(this), this.options.monitorInterval || this.options.visibilityTimeout);
        this.monitorQueue();
    }
}

IpcRedisClient.prototype.poller = function()
{
    var self = this;
    if (!this.options.queue) return;
    if (!this.client.ready) return self.schedulePoller(self.options.retryInterval);

    var script = this.options.visibilityTimeout ? client.scripts.vpoller : client.scripts.poller;
    this.client.eval(script, 2, this.options.queue, Date.now(), (err, rc) => {
        if (err) logger.error("poller:", core.role, self.url, lib.traceError(err));
        if (!rc || !rc[0] || err) {
            self.schedulePoller(self.options.retryInterval);
            return;
        }
        var timer, data = rc[0];
        var msg = lib.jsonParse(data, { datatype: "obj", logger: "error" }) || data;
        if (rc[1]) msg.queueAvailableCount = rc[1];
        if (rc[2]) msg.queueInvisibleCount = rc[2];
        // Check message timestamps if not ready yet then keep it hidden
        if (self.options.visibilityTimeout) {
            var now = Date.now();
            if (msg.endTime > 0 && msg.endTime < now) {
                self.client.zrem(self.options.queue + "#", data, (err) => {
                    if (err) logger.error("redis.poller:", self.url, lib.traceError(err));
                    self.schedulePoller(self.options.retryInterval);
                });
                return;
            }
            if (msg.startTime > 0 && msg.startTime - now > self.options.interval) {
                var timeout = msg.startTime - now;
                if (timeout > self.options.maxTimeout) timeout = self.options.maxTimeout;
                self.client.zadd(self.options.queue + "#", now + timeout, data, (err) => {
                    if (err) logger.error("redis.poller:", core.role, self.url, lib.traceError(err));
                    self.schedulePoller(self.options.retryInterval);
                });
                return;
            }
            // Delete immediately, this is a one-off message not to be handled or repeated
            if (msg.noWait) {
                self.client.zrem(self.options.queue + "#", data);
            } else
            // Delay deletion in case checks need to be done for uniqueness or something else
            if (msg.noWaitTimeout > 0) {
                setTimeout(() => {
                    if (msg.done) return;
                    msg.noWait = 1;
                    self.client.zrem(self.options.queue + "#", data);
                }, msg.noWaitTimeout * 1000);
            }
        }
        // Keep updating timestamp to prevent the job being placed back to the active queue
        if (msg.visibilityTimeout > 0 || self.options.visibilityTimeout) {
            timer = setInterval(() => {
                self.client.zadd(self.options.queue + "#", Date.now(), data, (err) => {
                    if (err) logger.error("redis.poller:", core.role, self.url, lib.traceError(err));
                    if (err) clearInterval(timer);
                });
            }, (msg.visibilityTimeout || self.options.visibilityTimeout) * 0.8);

            Object.defineProperty(msg, "__msgid", { enumerable: false, value: data });
        }

        if (!self.emit("message", msg, (err, next) => {
            msg.done = 1;
            clearInterval(timer);

            if (!msg.noVisibility && (err && err.status >= 500 || msg.noWait)) {
                setTimeout(() => {
                    const timeout = Date.now() + (!msg.retryVisibilityStatus || lib.isTrue(msg.retryVisibilityStatus, err.status) ? lib.toNumber(msg.retryVisibilityTimeout) : 0);
                    self.client.zadd(self.options.queue + (self.options.visibilityTimeout ? "#" : ""), timeout, data, (err) => {
                        if (err) logger.error("redis.poller:", core.role, self.url, lib.traceError(err));
                        self.schedulePoller(self.options.interval);
                    });
                }, self.options.visibilityTimeout ? 0 : self.options.retryInterval);
            } else {
                if (self.options.visibilityTimeout) {
                    self.client.zrem(self.options.queue + "#", data, (err) => {
                        if (err) logger.error("ipc.poller:", core.role, self.url, lib.traceError(err));
                        self.schedulePoller(self.options.interval);
                    });
                } else {
                    self.schedulePoller(self.options.interval);
                }
            }
        })) {
            msg.done = 1;
            clearInterval(timer);
            self.schedulePoller(self.options.interval);
        }
    });
}

IpcRedisClient.prototype.drop = function(msg, options, callback)
{
    if (!msg.__msgid) return lib.tryCall(callback);
    this.client.zrem(this.options.queue + "#", msg.__msgid, callback);
}

IpcRedisClient.prototype.initSentinel = function()
{
    var options = this.options.sentinel;
    if (!options) return;
    options.servers = lib.strSplitUnique((options.servers || "") + "," + (this.options.host || ""));
    // Need at least one server for reconnect to work
    if (!options.servers.length) options.servers.push("");
    options.no_ready_check = false;
    options.enable_offline_queue = false;
    options.port = options.port || 26379;
    options.name = options.name || "redis";
    this.initClient("sentinel", options.servers[0]);
}

IpcRedisClient.prototype.onSentinelMessage = function(pattern, channel, msg)
{
    logger.debug("onSentinelMessage:", core.role, this.url, channel, msg)

    if (channel[0] == "+" || channel[0] == "-") channel = channel.substr(1);
    switch (channel) {
    case "reset-master":
        this.onSentinelConnect();
        break;

    case "sentinel":
        msg = lib.strSplit(msg, " ");
        if (!msg[1] || msg[5] != this.options.sentinel.name) break;
        if (this.options.sentinel.servers.indexOf(msg[1]) == -1) this.options.sentinel.servers.push(msg[1]);
        break;

    case 'switch-master':
        msg = lib.strSplit(msg, ' ');
        if (!msg[3] || msg[0] != this.options.sentinel.name) break;
        if (this.client && this.client.address == msg[3] + ":" + msg[4]) break;
        logger.error("onSentinelMessage:", "switch-master:", core.role, this.url, msg);
        this.initClient("client", msg[3], msg[4]);
        break;
    }
}

IpcRedisClient.prototype.onSentinelConnect = function()
{
    var self = this;
    logger.debug("onSentinelConnect:", core.role, this.url, this.options.sentinel);

    lib.series([
      function(next) {
          self.sentinel.punsubscribe(next);
      },
      function(next) {
          self.sentinel.send_command("SENTINEL", ["sentinels", self.options.sentinel.name], function(err, args) {
              if (err) return next(err);
              logger.debug("onSentinelConnect:", "sentinels", args);
              var servers = [];
              (Array.isArray(args) && Array.isArray(args[0]) ? args : []).forEach(function(x) {
                  var ip = "";
                  for (var i = 0; i < x.length - 1; i+= 2) {
                      if (x[i] == "ip") ip = x[i+1];
                      if (x[i] == "port") ip += ":" + x[i+1];
                  }
                  if (ip) servers.push(ip);
              });
              if (servers.indexOf(self.sentinel.address) == -1) servers.push(self.sentinel.address);
              if (servers.length) self.options.sentinel.servers = servers;
              next();
          });
      },
      function(next) {
          self.sentinel.send_command("SENTINEL", ["get-master-addr-by-name", self.options.sentinel.name], function(err, args) {
              if (err) return next(err);
              logger.debug("onSentinelConnect:", "master", args);
              var m = args[0] + ":" + args[1];
              if (self.options.servers.indexOf(m) == -1) self.options.servers.push(m);
              var h = self.client && self.client.connected && self.client.connection_options.host || self.hostname;
              var p = self.client && self.client.connected && self.client.connection_options.port || self.port || self.options.port || 6379;
              // Avoid reseting connections to the same server, have to compare IPs
              if (!/^[0-9.]+$/.test(h)) {
                  dns.lookup(h, function(e, ip) {
                      if (ip) h = ip;
                      if (args[0] != h || args[1] != p) self.initClient("client", args[0], args[1]);
                      next();
                  });
              } else {
                  if (args[0] != h || args[1] != p) self.initClient("client", args[0], args[1]);
                  next();
              }
          });
      },
      function(next) {
          self.sentinel.psubscribe('*', next);
      },
    ], function(err) {
        if (!err) return;
        logger.error("onSentinelConnect:", core.role, self.url, err);
        if (self.sentinel.connected) setTimeout(self.onSentinelConnect.bind(self), self.options.sentinel.retry_timeout || 500);
    });
}
