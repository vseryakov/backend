//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  backendjs 2018
//

const logger = require(__dirname + '/logger');
const lib = require(__dirname + '/lib');

// Apply an iterator function to each item in an array in parallel. Execute a callback when all items
// have been completed or immediately if there is an error provided.
//
//          lib.forEach([ 1, 2, 3 ], function (i, next) {
//              console.log(i);
//              next();
//          }, function (err) {
//              console.log('done');
//          });
lib.forEach = function(list, iterator, callback)
{
    callback = typeof callback == "function" ? callback : this.noop;
    if (!Array.isArray(list) || !list.length) return callback();
    var count = list.length;
    for (var i = 0; i < list.length; i++) {
        iterator(list[i], function(err) {
            if (err) {
                setImmediate(callback, err);
                callback = lib.noop;
                i = list.length + 1;
            } else
            if (--count == 0) {
                setImmediate(callback);
                callback = lib.noop;
            }
        });
    }
}

// Same as `forEach` except that the iterator will be called for every item in the list, all errors will be ignored
lib.forEvery = function(list, iterator, callback)
{
    callback = typeof callback == "function" ? callback : this.noop;
    if (!Array.isArray(list) || !list.length) return callback();
    var count = list.length;
    for (var i = 0; i < list.length; i++) {
        iterator(list[i], function(err) {
            if (--count == 0) {
                setImmediate(callback);
                callback = lib.noop;
            }
        });
    }
}

// Apply an iterator function to each item in an array serially. Execute a callback when all items
// have been completed or immediately if there is is an error provided.
//
//          lib.forEachSeries([ 1, 2, 3 ], function (i, next) {
//            console.log(i);
//            next();
//          }, function (err) {
//            console.log('done');
//          });
//
lib.forEachSeries = function(list, iterator, callback)
{
    callback = typeof callback == "function" ? callback : this.noop;
    if (!Array.isArray(list) || !list.length) return callback();
    function iterate(i, data) {
        if (i >= list.length) return setImmediate(callback, null, data);
        iterator(list[i], function(err, data) {
            if (err) {
                setImmediate(callback, err, data);
                callback = lib.noop;
            } else {
                iterate(++i, data);
            }
        }, data);
    }
    iterate(0);
}

// Same as `forEachSeries` except that the iterator will be called for every item in the list, all errors will be passed to the next
// item with optional additional data argument.
//
//          lib.forEverySeries([ 1, 2, 3 ], function (i, next, err, data) {
//            console.log(i, err, data);
//            next(err, i, data);
//          }, function (err, data) {
//            console.log('done', err, data);
//          });
//
lib.forEverySeries = function(list, iterator, callback)
{
    callback = typeof callback == "function" ? callback : this.noop;
    if (!Array.isArray(list) || !list.length) return callback();
    function iterate(i, err, data) {
        if (i >= list.length) return setImmediate(callback, err, data);
        iterator(list[i], function(err2, data2) {
            iterate(++i, err2, data2);
        }, err, data);
    }
    iterate(0);
}

// Apply an iterator function to each item in an array in parallel as many as specified in `limit` at a time. Execute a callback when all items
// have been completed or immediately if there is is an error provided.
lib.forEachLimit = function(list, limit, iterator, callback)
{
    callback = typeof callback == "function" ? callback : this.noop;
    if (!Array.isArray(list) || !list.length || typeof iterator != "function") return callback();
    limit = lib.toNumber(limit, { min: 1, float: 0 });
    var idx = 0, done = 0, running = 0;
    function iterate() {
        if (done >= list.length) return setImmediate(callback);
        while (running < limit && idx < list.length) {
            running++;
            iterator(list[idx++], function(err) {
                running--;
                if (err) {
                    setImmediate(callback, err);
                    callback = lib.noop;
                    idx = done = list.length + 1;
                } else {
                    if (++done >= list.length) {
                        setImmediate(callback);
                        callback = lib.noop;
                    } else {
                        iterate();
                    }
                }
            });
        }
    }
    iterate();
}

// Same as `forEachLimit` but does not stop on error, all items will be processed and errors will be collected in an array and
// passed to the final callback
lib.forEveryLimit = function(list, limit, iterator, callback)
{
    callback = typeof callback == "function" ? callback : this.noop;
    if (!Array.isArray(list) || !list.length || typeof iterator != "function") return callback();
    limit = lib.toNumber(limit, { min: 1 });
    var idx = 0, done = 0, running = 0, errors;
    function iterate() {
        if (done >= list.length) return setImmediate(callback, errors);
        while (running < limit && idx < list.length) {
            running++;
            iterator(list[idx++], (err) => {
                running--;
                if (err) errors = lib.isArray(errors, []).concat(err);
                if (++done >= list.length) {
                    setImmediate(callback, errors);
                    callback = lib.noop;
                } else {
                    iterate();
                }
            });
        }
    }
    iterate();
}

// Apply an iterator function to each item returned by the `next(item, cb)` function until it returns `null` or the iterator returns an error in the callback,
// the final callback will be called after all iterators are finished.
//
// If no item is available the `next()` should return empty value, it will be called again in `options.interval` ms if specified or
// immediately in the next tick cycle.
//
// The max number of iterators to run at the same time is controlled by `options.max`, default is 1.
//
// The maximum time waiting for items can be specified by `options.timeout`, it is not an error condition, just another way to stop
// processing if it takes too long because the `next()` function is a black box just returning items to process. Timeout will send null
// to the queue and it will stop after all iterators are finished.
//
//
//        var list = [1, 2, "", "", 3, "", 4, "", "", "", null];
//        lib.forEachItem({ max: 2, interval: 1000, timeout: 30000 },
//            function(next) {
//                next(list.shift());
//            },
//            function(item, next) {
//                console.log("item:", item);
//                next();
//            },
//            (err) => {
//                console.log("done", err);
//            });

lib.forEachItem = function(options, next, iterator, callback)
{
    callback = typeof callback == "function" ? callback : this.noop;
    if (!options || typeof next != "function" || typeof iterator != "function") return callback();

    function end() {
        clearTimeout(options.timer);
        delete options.timer;
        options.etime = Date.now();
        setImmediate(callback, options.error);
        callback = lib.noop;
    }
    function iterate() {
        if (!next) return;
        next((item) => {
            if (!next) return;
            if (!item && options.timeout > 0 && Date.now() - options.mtime > options.timeout) item = null;
            // End of queue
            if (item === null) {
                next = null;
                logger.dev("forEachItem:", "null:", next ? "next" : "", options.timer ? "timer" : "", options);
                if (!options.running) end();
                return;
            }
            // No item available, need to wait
            if (!item) {
                if (!options.timer) options.timer = setTimeout(() => {
                    delete options.timer;
                    logger.dev("forEachItem:", "timer:", next ? "next" : "", options.timer ? "timer" : "", options);
                    if (!next && !options.running) return end();
                    for (var i = options.running; i < options.max; i++) iterate();
                }, options.interval);
                return;
            }
            options.count++;
            options.running++;
            options.mtime = Date.now();
            iterator(item, (err) => {
                options.running--;
                if (err) next = null, options.error = err;
                logger.dev("forEachItem:", "after:", next ? "next" : "", options.timer ? "timer" : "", options);
                if (!next && !options.running) return end();
                for (var i = options.running; i < options.max; i++) iterate();
            });
        });
    }

    options.running = options.count = 0;
    options.stime = options.mtime = Date.now();
    options.timeout = lib.toNumber(options.timeout);
    options.interval = lib.toNumber(options.interval);
    options.max = lib.toNumber(options.max, { min: 1 });
    for (var i = 0; i < options.max; i++) iterate();
}

// Execute a list of functions in parallel and execute a callback upon completion or occurance of an error. Each function will be passed
// a callback to signal completion. The callback accepts an error for the first argument. The iterator and callback will be
// called via setImmediate function to allow the main loop to process I/O.
lib.parallel = function(tasks, callback)
{
    this.forEach(tasks, function itEach(task, next) {
        task(function itNext(err) {
            setImmediate(next.bind(null, err));
        });
    }, function(err) {
        if (typeof callback == "function") setImmediate(callback, err);
    });
}

// Same as `lib.parallel` but all functions will be called and any error will be ignored
lib.everyParallel = function(tasks, callback)
{
    this.forEvery(tasks, function itEach(task, next) {
        task(function itNext() {
            setImmediate(next.bind(null));
        });
    }, function() {
        if (typeof callback == "function") setImmediate(callback);
    });
}

// Execute a list of functions serially and execute a callback upon completion or occurance of an error. Each function will be passed
// a callback to signal completion. The callback accepts either an error for the first argument in which case the flow will be aborted
// and the final callback will be called immediately or some optional data to be passed to thr next iterator function as a second argument.
//
// The iterator and callback will be
// called via setImmediate function to allow the main loop to process I/O.
//
//          lib.series([
//             function(next) {
//                setTimeout(function () { next(null, "data"); }, 100);
//             },
//             function(next, data) {
//                setTimeout(function () { next(); }, 100);
//             },
//          ], function(err) {
//              console.log(err);
//          });
lib.series = function(tasks, callback)
{
    this.forEachSeries(tasks, function itSeries(task, next, data1) {
        task(function itNext(err2, data2) {
            setImmediate(next.bind(null, err2, data2));
        }, data1);
    }, function(err, data) {
        if (typeof callback == "function") setImmediate(callback, err, data);
    });
}

// Same as `lib.series` but all functions will be called with errors passed to the next task, only the last passed error will be returned
//
//          lib.everySeries([
//             function(next, err) {
//                setTimeout(function () { next("error1", "data1"); }, 100);
//             },
//             function(next, err, data) {
//                setTimeout(function () { next(err, "data2"); }, 100);
//             },
//          ], function(err, data) {
//              console.log(err, data);
//          });

lib.everySeries = function(tasks, callback)
{
    this.forEverySeries(tasks, function itSeries(task, next, err1, data1) {
        task(function itNext(err2, data2) {
            setImmediate(next.bind(null, err2, data2));
        }, err1, data1);
    }, function(err, data) {
        if (typeof callback == "function") setImmediate(callback, err, data);
    });
}

// While the test function returns true keep running the iterator, call the callback at the end if specified. All functions are called via setImmediate.
//
//          var count = 0;
//          lib.whilst(
//              function() {
//                return count < 5;
//              },
//              function (next) {
//                count++;
//                setTimeout(next, 1000);
//              },
//              function (err, data) {
//                console.log(err, data, count);
//              });
lib.whilst = function(test, iterator, callback, data)
{
    callback = typeof callback == "function" ? callback : this.noop;
    if (!test(data)) return callback(null, data);
    iterator(function itWhilst(err, data2) {
        if (err) return callback(err, data2);
        setImmediate(lib.whilst.bind(lib, test, iterator, callback, data2));
    }, data);
};

// Keep running iterator while the test function returns true, call the callback at the end if specified. All functions are called via setImmediate.
lib.doWhilst = function(iterator, test, callback, data)
{
    callback = typeof callback == "function" ? callback : this.noop;
    iterator(function itDoWhilst(err, data2) {
        if (err) return callback(err, data2);
        if (!test(data2)) return callback(err, data2);
        setImmediate(lib.doWhilst.bind(lib, iterator, test, callback, data2));
    }, data);
}
