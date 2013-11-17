//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

var util = require('util');
var net = require('net');
var fs = require('fs');
var path = require('path');
var backend = require(__dirname + '/backend');
var logger = require(__dirname + '/logger');
var core = require(__dirname + '/core');
var aws = require(__dirname + '/aws');
var cluster = require('cluster');
var printf = require('printf');
var gpool = require('generic-pool');
var async = require('async');
var os = require('os');

var db = {
    name: 'db',
    
    // Default database pool for the backend
    pool: 'sqlite',

    // Database connection pools, sqlite default pool is called sqlite, PostgreSQL default pool is pg, DynamoDB is ddb
    dbpool: {},
    nopool: { name: 'none', dbkeys: {}, dbcolumns: {}, unique: {}, 
              get: function() { throw "no pool" }, free: function() { throw "no pool" }, 
              prepare: function() { throw "no pool" }, put: function() { throw "no pool" }, 
              cacheColumns: function() { throw "no pool" }, value: function() {} },
        
    // Translation map for similar operators from different database drivers
    opMap: { begins_with: 'like%', eq: '=', le: '<=', lt: '<', ge: '>=', gt: '>' },

    // Config parameters              
    args: [{ name: "pool", descr: "Default pool to be used for db access without explicit pool specified" },
           { name: "no-pools", type:" bool", descr: "Do not use other db pools except default sqlite" },
           { name: "sqlite-max", type: "number", min: 1, max: 100, descr: "Max number of open connection for the pool" },
           { name: "sqlite-idle", type: "number", min: 1000, max: 86400000, descr: "Number of ms for a connection to be idle before being destroyed" },
           { name: "pg-pool", descr: "PostgreSQL pool access url or options string" },
           { name: "pg-max", type: "number", min: 1, max: 100, descr: "Max number of open connection for the pool"  },
           { name: "pg-idle", type: "number", min: 1000, max: 86400000, descr: "Number of ms for a connection to be idle before being destroyed" },
           { name: "ddb-pool", descr: "DynamoDB endpoint url" },
    ],

    // Default tables
    tables: { backend_property: [{ name: 'name', primary: 1 }, 
                                 { name: 'value' }, 
                                 { name: 'mtime' } ] ,
                                 
              backend_cookies: [ { name: 'name', primary: 1 }, 
                                 { name: 'domain', primary: 1 }, 
                                 { name: 'path', primary: 1 }, 
                                 { name: 'value' }, 
                                 { name: 'expires' } ],
                                 
              backend_queue: [ { name: 'id', primary: 1 },
                               { name: 'url' }, 
                               { name: 'postdata' }, 
                               { name: 'counter', type: 'int' }, 
                               { name: 'mtime' } ],
                               
              backend_jobs: [ { name: 'id', primary: 1 }, 
                              { name: 'type', value: "local" }, 
                              { name: 'host', value: '' }, 
                              { name: 'job' }, 
                              { name: 'mtime', type: 'int'} ],
    },

    // Initialize database pools
    init: function(callback) {
        var self = this;
        
        // Internal Sqlite database is always open
        this.sqliteInitPool({ pool: 'sqlite', db: core.name, readonly: false, max: self.sqliteMax, idle: self.sqliteIdle });
        
        // Optional pools for supported databases
        if (!self.noPools) {
            ["pg", "ddb"].forEach(function(x) {
                if (!self[x + 'Pool']) return;
                self[x + 'InitPool']({ pool: x, db: self[x + 'Pool'], max: self[x + 'Max'], idle: self[x + 'Idle'] });
            });
        }
        
        // Initialize SQL pools
        async.forEachSeries(Object.keys(this.dbpool), function(pool, next) {
            if (cluster.isWorker || core.worker) {
                db.cacheColumns({ pool: pool }, next);
            } else {
                db.initTables({ pool: pool, tables: self.tables }, next);
            }
        }, function(err) {
            logger.debug("db.init:", err);
            if (callback) callback(err);
        });
    },
    
    // Init the pool, create tables and columns
    // options properties:
    // - tables - list of tables to create or upgrade
    initTables: function(options, callback) {
        var self = this;
        if (typeof options == "function") callback = options, options = {};
        
        self.cacheColumns(options, function() {
            var changes = 0;
            async.forEachSeries(Object.keys(options.tables || {}), function(table, next) {
                // We if have columns, SQL table must be checked for missing columns and indexes
                if (self.getColumns(table, options)) {
                    self.upgrade(table, options.tables[table], options, function(err, rows) { if (rows) changes++; next() });
                } else {
                    self.create(table, options.tables[table], options, function(err, rows) { changes++; next() });
                }
            }, function() {
                logger.debug('db.initTables:', options.pool, 'changes:', changes);
                if (!changes) return callback ? callback() : null;
                self.cacheColumns(options, callback);
            });
        });
    },
    
    // Create a database pool
    // - options - an object defining the pool, the following properties define the pool:
    //   - pool - pool name/type, of not specified sqlite is used
    //   - max - max number of clients to be allocated in the pool
    //   - idle - after how many milliseconds an idle client will be destroyed
    // - createcb - a callbacl to be called when actual database client needs to be created, the callback signature is
    //     function(options, callback) and will be called with first arg an error object and second arg is the database instance
    // - cachecb - a callback for caching database tables and columns
    // - valuecb - a callback that performs value transformation if necessary for the bind parameters
    initPool: function(options, createcb, cachecb, valuecb) {
        var self = this;
        if (!options) options = {};
        if (!options.pool) options.pool = "sqlite";
        
        var pool = gpool.Pool({
            name: options.pool,
            max: options.max || 1,
            idleTimeoutMillis: options.idle || 86400 * 1000,

            create: function(callback) {
                createcb.call(self, options, function(err, client) {
                    if (!err) self.dbpool[options.pool].watch(client);
                    callback(err, client);
                });
            },
            validate: function(client) {
                return self.dbpool[this.name].serial == client.pool_serial;
            },
            destroy: function(client) {
                logger.log('pool:', 'destroy', client.pool_name, "#", client.pool_serial);
                client.close(function(err) { logger.log("pool: closed", client.pool_name, err || "") });
            },
            log: function(str, level) {
                if (level == 'info') logger.debug('pool:', str);
                if (level == 'warn') logger.log('pool:', str);
                if (level == 'error') logger.error('pool:', str);
            },            
        });
        // Aquire a connection with error reporting
        pool.get = function(callback) {
            this.acquire(function(err, client) {
                if (err) logger.error('pool:', err);
                callback(err, client);
            });
        }
        // Release or destroy a client depending on the database watch counter
        pool.free = function(client) {
            if (this.serial != client.pool_serial) {
                this.destroy(client);
            } else {
                this.release(client);
            }
        }
        // Watch for changes or syncs and reopen the database file
        pool.watch = function(client) {
            var me = this;
            if (options.watch && options.file && !this.serial) {
                this.serial = 1;
                fs.watch(options.file, function(event, filename) {
                    logger.log('pool:', 'changed', me.name, event, filename, options.file, "#", me.serial);
                    me.serial++;
                    me.destroyAllNow();
                });
            }
            // Mark the client with the current db pool serial number, if on release this number differs we
            // need to destroy the client, not return to the pool
            client.pool_serial = this.serial;
            client.pool_name = this.name;
            logger.debug('pool:', 'open', this.name, "#", this.serial);
        }
        // Call column caching callback with our pool name
        pool.cacheColumns = function(callback) {
            cachecb.call(self, { pool: this.name }, callback);
        }
        // Prepare for execution, return an object with formatted or transformed query request for the database driver of this pool
        // For SQL databases it creates a SQL statement with parameters
        pool.prepare = function(op, table, obj, opts) {
            switch (op) {
            case "new": return self.sqlCreate(table, obj, opts);
            case "upgrade": return self.sqlUpgrade(table, obj, opts);
            case "list": 
            case "select": return self.sqlSelect(table, obj, opts);
            case "get": return self.sqlSelect(table, obj, self.cloneObj(opts, {}, { count: 1 }));
            case "add": return self.sqlInsert(table, obj, opts);
            case "put": return self.sqlInsert(table, obj, core.extendObj(opts || {}, 'replace', 1));
            case "update": return self.sqlUpdate(table, obj, opts);
            case "del": return self.sqlDelete(table, obj, opts);
            }
        }
        // Execute a query, run filter if provided
        pool.query = function(client, req, opts, callback) {
            client.query(req.text, req.values || [], function(err, rows) {
                if (err) return callback(err, rows);
                if (opts.filter) rows = rows.filter(function(row) { return opts.filter(row, opts); });
                callback(err, rows);
            });
        }
        // Sqlite supports REPLACE INTO natively
        pool.put = function(table, obj, opts, callback) {
            var req = this.prepare("add", table, obj, core.extendObj(opts || {}, 'replace', 1));
            self.query(req, options, callback);
        }
        // Convert a value when using with parametrized statements or convert into appropriate database type
        pool.value = valuecb || function(val, opts) { return val; }
        pool.name = options.pool;
        pool.serial = 0;
        pool.dbcolumns = {};
        pool.dbkeys = {};
        pool.dbunique = {};
        pool.sql = true;
        pool.stats = { gets: 0, hits: 0, misses: 0, puts: 0, dels: 0, errs: 0 };
        this.dbpool[options.pool] = pool;
        logger.debug('db.initPool:', pool.name);
        return pool;
    },
    
    // Insert new object into the database
    // - obj - an object with properties for the record, primary key properties must be supplied
    add: function(table, obj, options, callback) {
        if (typeof options == "function") callback = options,options = null;

        var req = this.prepare("add", table, obj, options);
        this.query(req, options, callback);
    },

    // Add/update an object in the database, if object already exists it will be replaced with all new properties from the obj
    // - obj - an object with record properties, primary key properties must be specified
    // - options - same properties as for .select method
    put: function(table, obj, options, callback) {
        if (typeof options == "function") callback = options,options = null;
        
        // Custom handler for the operation
        var pool = this.getPool(options);
        if (pool.put) return pool.put(table, obj, options, callback);
        
        var req = this.prepare("put", table, obj, options);
        this.query(req, options, callback);
    },
    
    // Update existing object in the database.
    // - obj - is an actual record to be updated, primary key properties must be specified
    // - options - same properties as for .select method
    update: function(table, obj, options, callback) {
        if (typeof options == "function") callback = options,options = null;

        var req = this.prepare("update", table, obj, options);
        this.query(req, options, callback);
    },

    // Delete object in the database, no error if the object does not exist
    // - obj - an object with primary key properties only, other properties will be ignored
    // - options - same propetties as for .select method
    del: function(table, obj, options, callback) {
        if (typeof options == "function") callback = options,options = null;

        var req = this.prepare("del", table, obj, options);
        this.query(req, options, callback);
    },

    // Insert or update the object, check existence by the primary key or by othe keys specified.
    // - obj is a Javascript object with properties that correspond to the table columns
    // - options define additional flags that may
    //   - keys is list of column names to be used as primary key when looking for updating the record, if not specified
    //     then default primary keys for the table will be used
    //   - check_mtime defines a column name to be used for checking modification time and skip if not modified, must be a date value
    //   - check_data tell to verify every value in the given object with actual value in the database and skip update if the record is the same, if it is an array
    //     then check only specified columns
    replace: function(table, obj, options, callback) {
        var self = this;
        if (typeof options == "function") callback = options,options = {};
        if (!options) options = {};
        if (!options.keys || !options.keys.length) options.keys = self.getKeys(table, options) || [];
        
        var select = "1";
        // Use mtime to check if we need to update this record
        if (options.check_mtime && obj[options.check_mtime]) {
            select = options.check_mtime;
        } else
        // Check if values are different from existing value, skip if the records are the same by comparing every field
        if (options.check_data) {
            var cols = self.getColumns(table, options) || {};
            var list = Array.isArray(options.check_data) ? options.check_data : Object.keys(obj);
            select = list.filter(function(x) { return x[0] != "_"  && x != 'mtime' && keys.indexOf(x) == -1 && (x in cols); }).join(',');
            if (!select) select = "1";
        }
        
        var req = this.prepare("get", table, obj, { select: select });
        if (!req) {
            if (options.put_only) return callback ? callback(null, []) : null;
            return self.add(table, obj, options, callback);
        }

        // Create deep copy of the object so we have it complete inside the callback
        obj = this.cloneObj(obj);

        self.query(req, function(err, rows) {
            if (err) return callback ? callback(err, []) : null;
            
            logger.debug('db.replace:', req, result);
            if (rows.length) {
                // Skip update if specified or mtime is less or equal
                if (options.add_only || (select == options.check_mtime && self.toDate(rows[0][options.check_mtime]) >= self.toDate(obj[options.check_mtime]))) {
                    return callback ? callback(null, []) : null;
                }
                // Verify all fields by value
                if (options.check_data) {
                    var same = select == "1" || Object.keys(rows[0]).every(function(x) { return String(rows[0][x]) == String(obj[x]) });
                    // Nothing has changed
                    if (same) return callback ? callback(null, []) : null;
                }
                self.update(table, obj, keys, options, callback);
            } else {
                if (options.put_only) return callback ? callback(null, []) : null;
                self.add(table, obj, options, callback);
            }
        });
    },

    // Select objects from the database that match supplied conditions.
    // - obj - can be an object with primary key propeties set for the condition, all matching records will be returned
    // - obj - can be a list where each item is an object with primary key condition. Only records specified in the list must be returned.
    // Options can use the following special propeties:
    //  - keys - a list of columns for condition or all primary keys
    //  - ops - operators to use for comparison for properties, an object
    //  - types - type mapping between supplied and actual column types, an object
    //  - select - a list of columns or expressions to return or all columns
    //  - start - start records ith this primary key
    //  - count - how many records to return
    //  - sort - sort by this column
    //  - desc - if sorting, do in descending order
    //  - page - starting page number for pagination, uses count to find actual record to start 
    // On return, the callback can check third argument which is an object with the following properties:
    // - affected_rows - how many records this operation affected
    // - inserted_oid - last created auto generated id
    // - last_evaluated_key - last processed primary key, this can be used later to continue 
    //   pagination by passing it as .start or .page property
    select: function(table, obj, options, callback) {
        if (typeof options == "function") callback = options,options = null;

        var req = this.prepare(Array.isArray(obj) ? "list" : "select", table, obj, options);
        this.query(req, options, callback);
    },

    // Retrieve one record from the database 
    // Options can use the following special properties:
    //  - keys - a list of columns for condition or all primary keys
    //  - select - a list of columns or expressions to return or *
    //  - op - operators to use for comparison for properties
    get: function(table, obj, options, callback) {
        if (typeof options == "function") callback = options,options = null;

        var req = this.prepare("get", table, obj, options);
        this.query(req, options, callback);
    },

    // Retrieve cached result or put a record into the cache prefixed with table:key[:key...]
    // Options accept the same parameters as for the usual get action.
    // Additional options:
    // - prefix - prefix to be used for the key instead of table:
    getCached: function(table, obj, options, callback) {
        var self = this;
        if (typeof options == "function") callback = options,options = null;
        var pool = this.getPool(options);
        pool.stats.gets++;
        var keys = options.keys || this.getKeys(table, options) || [];
        var key = keys.filter(function(x) { return obj[x]} ).map(function(x) { return obj[x] }).join(":");
        var prefix = options.prefix || table;
        core.ipcGetCache(prefix + ":" + key, function(rc) {
            // Cached value retrieved
            if (rc) {
                pool.stats.hits++;
                return callback ? callback(null, JSON.parse(rc)) : null;
            }
            pool.stats.misses++;
            // Retrieve account from the database, use the parameters like in Select function
            self.get(table, obj, options, function(err, rows) {
                if (err) pool.stats.errs++;
                // Store in cache if no error
                if (rows.length && !err) {
                    pool.stats.puts++;
                    core.ipcPutCache(prefix + ":" + key, core.stringify(rows[0]));
                }
                callback(err, rows.length ? rows[0] : null);
            });
        });
   
    },
    
    // Execute query using native database driver, the query is passed directly to the driver.
    // - req - can be a string or an object with the following properties:
    //   - text - SQL statement or other query in the format of the native driver
    //   - values - parameter values for sql bindings or other driver specific data
    // - options may have the following properties:
    //   - filter - function to filter rows not to be included in the result, return false to skip row, args are: (row, options)
    // Callback is called with the following params:
    //  - callback(err, rows, info) where info holds inforamtion about the last query: inserted_oid,affected_rows,last_evaluated_key
    //    rows is always returned as a list, even in case of error it is an empty list
    query: function(req, options, callback) { 
        if (typeof options == "function") callback = options, options = {};
        if (core.typeName(req) != "object") req = { text: req };
        if (!req.text) return callback ? callback(new Error("empty statement"), []) : null;

        var pool = this.getPool(options);
        pool.get(function(err, client) {
            if (err) return callback ? callback(err, []) : null;
            var t1 = core.mnow();
            pool.query(client, req, options, function(err2, rows) {
                var info = { affected_rows: client.affected_rows, inserted_oid: client.inserted_oid, last_evaluated_key: client.last_evaluated_key };
                pool.free(client);
                if (err2) {
                    logger.error("db.query:", pool.name, req.text, req.values, err2);
                    return callback ? callback(err2, rows, info) : null;
                }
                logger.debug("db.query:", pool.name, (core.mnow() - t1), 'ms', rows.length, 'rows', req.text, req.values || "", info);
                if (callback) callback(err, rows, info);
            });
        });
    },

    // Create a table using column definitions represented as a list of objects. Each column definiton can
    // contain the following properties:
    // - name - column name
    // - type - column type, one of: int, real, string or other supported type
    // - primary - column is part of the primary key
    // - unique - column is part of an unique key
    // - index - column is part of an index
    // - value - default value for the column
    // - pub - columns is public
    // - semipub - column is not public but still retrieved to support other public columns
    // - hashindex - index that consists from primary key hash and this column for range
    // Some properties may be defined multiple times with number suffixes like: unique1, unique2, index1, index2
    create: function(table, obj, options, callback) {
        if (typeof options == "function") callback = options,options = null;

        var req = this.prepare("new", table, obj, options);
        this.query(req, options, callback);
    },
    
    // Upgrade SQL table with missing columns from the definition list
    upgrade: function(table, obj, options, callback) {
        if (typeof options == "function") callback = options,options = null;

        var req = this.prepare("upgrade", table, obj, options);
        if (!req.sql) return callback ? callback() : null;
        this.query(req, options, callback);
    },
    
    // Prepare for execution for the given operation: add, del, put, update,...
    // Returns prepared object to be passed to the driver's .query method.
    prepare: function(op, table, obj, options) {
        return this.getPool(options).prepare(op, table, obj, options);
    },

    // Return possibly converted value to be used for inserting/updating values in the database, 
    // is used for SQL parametrized statements
    value: function(options, val, vopts) {
        return this.getPool(options).value(val, vopts);
    },

    // Return database pool by name or default sqlite pool
    getPool: function(options) {
        return this.dbpool[(options || {})["pool"] || "sqlite"] || this.nopool || {};
    },

    // Return cached columns for a table or null, column is an object with column names and objects for definiton
    getColumns: function(table, options) {
        return this.getPool(options).dbcolumns[table.toLowerCase()];
    },

    // Return cached primary keys for a table or null
    getKeys: function(table, options) {
        return this.getPool(options).dbkeys[table.toLowerCase()];
    },
    
    // Reload all columns into the cache for the pool
    cacheColumns: function(options, callback) {
        this.getPool(options).cacheColumns(callback);
    },
    
    // Convert column definition list used in db.create into the format used by internal db pool functions
    convertColumns: function(cols) {
        return (cols || []).reduce(function(x,y) { x[y.name] = y; return x }, {});
    },
    
    // Prepare a record for returning to the client, cleanup all not public columns using table definition or cached table info
    // In adition, a custom list of allowed columns can be specified in the options.allowed property.
    publicPrepare: function(table, row, options) {
        var cols = options && !this.isEmpty(options.allowed) ? this.strSplit(options.allowed) : this.publicColumns(table, options);
        if (!cols.length) return row;
        for (var p in row) {
            if (cols.indexOf(p) == -1) delete row[p];
        }
        return row;
    },
    
    // Columns that are allowed to be visible, used in select to limit number of columns to be returned by a query
    // .pub property means public column
    // .semipub means not allowed but must be returned for calculations in the select to produce another public column
    // options may be used to define the column list as property columns instead of cached columns for a table
    publicColumns: function(table, options) {
        if (options && Array.isArray(options.columns)) {
            return options.columns.filter(function(x) { return x.pub || x.semipub }).map(function(x) { return x.name });
        }
        var cols = this.getColumns(options);
        return Object.keys(cols || {}).filter(function(x) { return cols[x].pub || cols[x].semipub });
    },
    
    // Quote value to be used in SQL expressions
    sqlQuote: function(val) {
        return val == null || typeof val == "undefined" ? "NULL" : ("'" + String(val).replace(/'/g,"''") + "'")
    },

    // Return properly quoted value to be used directly in SQL expressions, format according to the type
    sqlValue: function(value, type, dflt, min, max) {
        if (value == "null") return "NULL";
        switch ((type || core.typeName(value))) {
        case "expr":
        case "buffer":
            return value;

        case "real":
        case "float":
        case "double":
            return core.toNumber(value, true, dflt, min, max);

        case "int":
        case "integer":
        case "number":
            return core.toNumber(value, null, dflt, min, max);

        case "bool":
        case "boolean":
            return core.toBool(value);

        case "date":
            return this.sqlQuote((new Date(value)).toISOString());

        case "time":
            return this.sqlQuote((new Date(value)).toLocaleTimeString());

        case "mtime":
            return /^[0-9\.]+$/.test(value) ? this.toNumber(value, null, dflt, min, max) : this.sqlQuote((new Date(value)).toISOString());

        default:
            return this.sqlQuote(value);
        }
    },

    // Return list in format to be used with SQL IN ()
    sqlValueIn: function(list, type) {
        var self = this;
        if (!Array.isArray(list) || !list.length) return '';
        return list.map(function(x) { return self.sqlValue(x, type);}).join(",");
    },

    // Build SQL expressions for the column and value,
    //  op - SQL operator, default is =
    //       special operator null/not null is used to build IS NULL condition, value is ignored in this case
    //  type - can be data, string, number, float, expr, default is string
    //  dflt, min, max - are used for numeric values for validation of ranges
    //  for type expr, options.expr contains sprintf-like formatted expression to be used as is with all '%s' substituted with actual value
    sqlExpr: function(name, value, options) {
        var self = this;
        if (!name || typeof value == "undefined") return "";
        if (!options.type) options.type = "string";
        var sql = "";
        var op = (options.op || "").toLowerCase();
        if (this.opMap[op]) op = this.opMap[op];

        switch (op) {
        case "not in":
        case "in":
            var list = [];
            // Convert type into array
            switch (core.typeName(value)) {
            case "object":
                for (var p in value) list.push(value[p]);
                break;

            case "array":
                list = value;
                break;

            case "string":
                // For number array allow to be separated by comma as well, either one but not to be mixed
                if ((options.type == "number" || options.type == "int") && value.indexOf(',') > -1) {
                    list = value.split(',');
                    break;
                } else
                if (value.indexOf('|') > -1) {
                    list = value.split('|');
                    break;
                }

            default:
                list.push(value);
            }
            if (!list.length) break;
            sql += name + " " + op + " (" + self.sqlValueIn(list, options.type) + ")";
            break;

        case "between":
        case "not between":
            // If we cannot parse out 2 values, treat this as exact operator
            var list = [];
            switch (core.typeName(value)) {
            case "array":
                list = value;
                break;

            case "string":
                // For number array allow to be separated by comma as well, either one but not to be mixed
                if ((options.type == "number" || options.type == "int") && value.indexOf(',') > -1) {
                    list = value.split(',');
                    break;
                } else
                if (value.indexOf('|') > -1) {
                    list = value.split('|');
                    break;
                }
            }
            if (list.length > 1) {
                sql += name + " " + op + " " + this.sqlValue(list[0], options.type) + " AND " + this.sqlValue(list[1], options.type);
            } else {
                sql += name + "=" + this.sqlValue(value, options.type, options.value, options.min, options.max);
            }
            break;

        case "null":
        case "not null":
            sql += name + " IS " + op;
            break;

        case '@@':
            switch (core.typeName(value)) {
            case "string":
                if (value.indexOf('|') > -1) {
                    value = value.split('|');
                } else {
                    sql += name + op + " plainto_tsquery('" + (options.min || "english") + "'," + this.sqlQuote(value) + ")";
                    break;
                }

            case "array":
                value = value.map(function(x) { return "plainto_tsquery('" + (options.min || "english") + "'," + self.sqlQuote(x) + ")" }).join('||');
                sql += name + op + " (" +  value + ")";
                break;
            }
            break;

        case '~* any':
        case '!~* any':
            sql += this.sqlQuote(value) + " " + op + "(" + name + ")";
            break;

        case 'like%':
        case "ilike%":
        case "not like%":
        case "not ilike%":
            value += '%';
            op = op.substr(0, op.length-1);

        case '>':
        case '>=':
        case '<':
        case '<=':
        case '<>':
        case '!=':
        case "not like":
        case "like":
        case "ilike":
        case "not ilike":
        case "not similar to":
        case "similar to":
        case "regexp":
        case "not regexp":
        case "~":
        case "~*":
        case "!~":
        case "!~*":
        case 'match':
            sql += name + " " + op + " " + this.sqlValue(value, options.type, options.value, options.min, options.max);
            break;

        case "iregexp":
        case "not iregexp":
            sql += "LOWER(" + name + ") " + (op[0] == 'n' ? "NOT" : "") + " REGEXP " + this.sqlValue(value, options.type, options.value, options.min, options.max);
            break;
            
        case 'expr':
            if (options.expr) {
                var str = options.expr;
                if (value.indexOf('|') > -1) value = value.split('|');
                str = str.replace(/%s/g, this.sqlValue(value, options.type, null, options.min, options.max));
                str = str.replace(/%1/g, this.sqlValue(value[0], options.type, null, options.min, options.max));
                str = str.replace(/%2/g, this.sqlValue(value[1], options.type, null, options.min, options.max));
                sql += str;
            }
            break;

        default:
            sql += name + "=" + this.sqlValue(value, options.type, options.value, options.min, options.max);
            break;
        }
        return sql;
    },

    // Return time formatted for SQL usage as ISO, if no date specified returns current time
    sqlTime: function(d) {
        if (d) {
           try { d = (new Date(d)).toISOString() } catch(e) { d = '' }
        } else {
            d = (new Date()).toISOString();
        }
        return d;
    },

    // Given columns definition object, build SQL query using values from the values object, all conditions are joined using AND,
    // - columns is a list of objects with the following properties:
    //   - name - column name, also this is the key to use in the values object to get value by
    //   - col - actual column name to use in the SQL
    //   - alias - optional table prefix if multiple tables involved
    //   - value - default value
    //   - type - type of the value, this is used for proper formatting: boolean, number, float, date, time, string, expr
    //   - op - any valid SQL operation: =,>,<, between, like, not like, in, not in, ~*,.....
    //   - group - for grouping multiple columns with OR condition, all columns with the same group will be in the same ( .. OR ..)
    //   - always - only use default value if true
    //   - required - value default or supplied must be in the query, otherwise return empty SQL
    //   - search - aditional name for a value, for cases when generic field is used for search but we search specific column
    // - values - actual values for the condition as an object
    // - params if given will contain values for binding parameters
    sqlFilter: function(columns, values, params) {
        var all = [], groups = {};
        if (!values) values = {};
        if (!params) params = [];
        if (core.typeName(columns) == "object") columns = [ columns ];
        for (var i in columns) {
            var name = columns[i].name;
            // Default value for this column
            var value = columns[i].value;
            // Can we use supplied value or use only default one
            if (!columns[i].always) {
                if (values[name]) value = values[name];
                // In addition to exact field name there could be query alias to be used for this column in case of generic search field
                // which should be applied for multiple columns, this is useful to search across multiple columns or use diferent formats
                var search = columns[i].search;
                if (search) {
                    if (!Array.isArray(columns[i].search)) search = [ search ];
                    for (var j = 0; j < search.length; j++) {
                        if (values[search[j]]) value = values[search[j]];
                    }
                }
            }
            if (typeof value =="undefined" || (typeof value == "string" && !value)) {
                // Required filed is missing, return empty query
                if (columns[i].required) return "";
                // Allow empty values excplicitely
                if (!columns[i].empty) continue;
            }
            // Uset actual column name now once we got the value
            if (columns[i].col) name = columns[i].col;
            // Table prefix in case of joins
            if (columns[i].alias) name = columns[i].alias + '.' + name;
            // Wrap into COALESCE
            if (typeof columns[i].coalesce != "undefined") {
                name = "COALESCE(" + name + "," + this.sqlValue(columns[i].coalesce, columns[i].type) + ")";
            }
            var sql = "";
            // Explicit skip of the parameter
            if (columns[i].op == 'skip') {
                continue;
            } else
            // Add binding parameters
            if (columns[i].op == 'bind') {
                sql = columns[i].expr.replace('$#', '$' + (params.length + 1));
                params.push(value);
            } else
            // Special case to handle NULL
            if (columns[i].isnull && (value == "null" || value == "notnull")) {
                sql = name + " IS " + value.replace('null', ' NULL');
            } else {
                // Primary condition for the column
                sql = this.sqlExpr(name, value, columns[i]);
            }
            if (!sql) continue;
            // If group specified, that means to combine all expressions inside that group with OR
            if (columns[i].group) {
                if (!groups[columns[i].group]) groups[columns[i].group] = [];
                groups[columns[i].group].push(sql);
            } else {
                all.push(sql);
            }
        }
        var sql = all.join(" AND ");
        for (var p in groups) {
            var g = groups[p].join(" OR ");
            if (!g) continue;
            if (sql) sql += " AND ";
            sql += "(" + g + ")";
        }
        return sql;
    },

    // Build SQL orderby/limit/offset conditions, config can define defaults for sorting and paging
    sqlLimit: function(config, values) {
        if (!config) config = {};
        if (!values) values = {};
        var rc = "";

        // Sorting column, multiple nested sort orders
        var orderby = "";
        ["", "1", "2"].forEach(function(p) {
            var sort = values['_sort' + p] || config['sort' + p] || "";
            var desc = core.toBool(typeof values['_desc' + p] != "undefined" ? values['_desc' + p] : config['desc' + p]);
            if (config.names && config.names.indexOf(sort) == -1) sort = config['sort' + p] || "";
            if (!sort) return;
            // Replace by sorting expression
            if (config.expr && config.expr[sort]) sort = config.expr[sort];
            orderby += (orderby ? "," : "") + sort + (desc ? " DESC" : "");
        });
        if (orderby) {
            rc += " ORDER BY " + orderby;
        }
        // Limit clause
        var page = core.toNumber(values['_page'], false, config.page || 0, 0, 999999);
        var count = core.toNumber(values['_count'], false, config.count || 50, 1, config.max || 1000);
        var offset = core.toNumber(values['_offset'], false, config.offset || 0, 0, 999999);
        if (count) {
            rc += " LIMIT " + count;
        }
        if (offset) {
            rc += " OFFSET " + offset;
        } else
        if (page && count) {
            rc += " OFFSET " + ((page - 1) * count);
        }
        return rc;
    },

    // Build SQL where condition from the keys and object values, returns SQL statement to be used in WHERE
    // - obj - an object record properties
    // - keys - a list of primary key columns
    // - options may contains the following properties:
    //   - pool - pool to be used for driver specific functions
    //   - ops - object for other comparison operators for primary key beside =
    //   - types - type mapping for properties to be used in the condition
    sqlWhere: function(obj, keys, options) {
        var self = this;
        if (!options) options = {};
        
        // List of records to return by primary key
        if (Array.isArray(obj)) {
            if (keys.length == 1) {
                return keys[0] + " IN (" + this.sqlValueIn(obj.map(function(x) { return x[keys[0]] })) + ")"; 
            }
            return obj.map(function(x) { return "(" + keys.map(function(y) { return y + "=" + self.sqlQuote(self.value(options, x[y])) }).join(" AND ") + ")" }).join(" OR ");
        }
        
        // Regular object with conditions
        var where = [];
        (keys || []).forEach(function(k) {
            var v = obj[k];
            var op = (options.ops || {})[k];
            var type = (options.type || {})[k];
            if (!op && v == null) op = "null";
            if (!op && Array.isArray(v)) op = "in";
            var sql = self.sqlExpr(k, v, { op: op, type: type });
            if (sql) where.push(sql);
        });
        return where.join(" AND ");
    },

    // Create SQL table using column definition list with properties:
    // - name - column name
    // - type - type of the column, default is TEXT, options: int, real or other supported type
    // - value - default value for the column
    // - primary - part of the primary key
    // - unique - part of the unique key
    // - index - regular index
    // - hashindex - unique index that consist from primary key hash and range
    // options may contains:
    // - types - type mapping, convert lowecase type into other type for any specific database
    sqlCreate: function(table, obj, options, callback) {
        var self = this;
        if (typeof options == "function") callback = options, options = {};
        if (!options) options = {};
        
        function items(name) { return obj.filter(function(x) { return x[name] }).map(function(x) { return x.name }).join(','); }
        
        var sql = "CREATE TABLE IF NOT EXISTS " + table + "(" + 
                   obj.filter(function(x) { return x.name }).
                       map(function(x) { 
                           return x.name + " " + 
                           (function(t) { return (options.types || {})[t] || t })(x.type || "text") + " " + 
                           (typeof x.value != "undefined" ? "DEFAULT " + self.sqlValue(x.value, x.type) : "") }).join(",") + " " +
                   (function(x) { return x ? ",PRIMARY KEY(" + x + ")" : "" })(items('primary')) + ");";
        
        // Create indexes
        var keys = obj.filter(function(y) { return y.primary }).map(function(x) { return x.name });
        ["","1","2"].forEach(function(y) {
            sql += (function(x) { return x ? "CREATE UNIQUE INDEX IF NOT EXISTS " + table + "_udx" + y + " ON " + table + "(" + x + ");" : "" })(items('unique' + y));
            sql += (function(x) { return x ? "CREATE INDEX IF NOT EXISTS " + table + "_idx" + y + " ON " + table + "(" + x + ");" : "" })(items('index' + y));
            if (keys) sql += (function(x) { return x ? "CREATE UNIQUE INDEX IF NOT EXISTS " + table + "_rdx" + y + " ON " + table + "(" + keys[0] + "," + x + ");" : "" })(items('hashindex' + y));
        });
        
        return { text: sql, values: [] };
    },
    
    // Create ALTER TABLE ADD COLUMN statements for missing columns
    sqlUpgrade: function(table, obj, options, callback) {
        var self = this;
        if (typeof options == "function") callback = options, options = {};
        if (!options) options = {};
        
        function items(name) { return obj.filter(function(x) { return x[name] }).map(function(x) { return x.name }).join(','); }
        var dbcols = this.getColumns(table, options) || {};
        var sql = obj.filter(function(x) { return x.name && !(x.name in dbcols) }).
                      map(function(x) { 
                          return "ALTER TABLE " + table + " ADD COLUMN " + x.name + " " + 
                          (function(t) { return (options.types || {})[t] || t })(x.type || "text") + " " + 
                          (typeof x.value != "undefined" ? "DEFAULT " + self.sqlValue(x.value, x.type) : "") }).join(";");
        if (sql) sql += ";";
        
        // Create indexes
        var keys = obj.filter(function(y) { return y.primary }).map(function(x) { return x.name });
        ["","1","2"].forEach(function(y) {
            sql += (function(x) { return x ? "CREATE UNIQUE INDEX IF NOT EXISTS " + table + "_udx" + y + " ON " + table + "(" + x + ");" : "" })(items('unique' + y));
            sql += (function(x) { return x ? "CREATE INDEX IF NOT EXISTS " + table + "_idx" + y + " ON " + table + "(" + x + ");" : "" })(items('index' + y));
            if (keys) sql += (function(x) { return x ? "CREATE UNIQUE INDEX IF NOT EXISTS " + table + "_rdx" + y + " ON " + table + "(" + keys[0] + "," + x + ");" : "" })(items('hashindex' + y));
        });
        
        return { text: sql, values: [] };
    },
    
    // Select object from the database, .keys is a list of columns for condition, .select is list of columns or expressions to return
    sqlSelect: function(table, obj, options) {
        if (!options) options = {};
        var keys = options.keys;
        if (!keys || !keys.length) keys = this.getKeys(table, options) || [];
        
        // Requested columns, support only existing
        var dbcols = this.getColumns(table, options) || {};
        var cols = options.total ? "COUNT(*) AS count" :
                   options.select ? options.select.split(",").filter(function(x) { return /^[a-z0-9_]+$/.test(x) && x in dbcols; }).map(function(x) { return x }).join(",") : "";
        if (!cols) cols = "*";

        var where = this.sqlWhere(obj, keys);
        if (where) where = " WHERE " + where;
        
        var req = { text: "SELECT " + cols + " FROM " + table + where };
        if (options.sort) req.text += " ORDER BY " + options.sort + (options.desc ? " DESC " : "");
        if (options.count) req.text += " LIMIT " + options.limit;

        return req;
    },

    // Build SQL insert
    sqlInsert: function(table, obj, options) {
        if (!options) options = {};
        var names = [], pnums = [], req = { values: [] }, i = 1
        // Columns should exist prior to calling this
        var cols = this.getColumns(table, options) || {};

        for (var p in obj) {
            if (!p || p[0] == "_" || (!options.nocolumns && !(p in cols))) continue;
            // Filter not allowed columns or only allowed columns
            if (options.skip_cols && options.skip_cols.indexOf(p) > -1) continue;
            if (options.allow_cols && options.allow_cols.indexOf(p) == -1) continue;
            var v = obj[p];
            // Avoid int parse errors with empty strings
            if (!v && ["number","json"].indexOf(cols[p].type) > -1) v = null;
            // Ignore nulls, this way default value will be inserted if specified
            if (typeof v == "undefined" || (v == null && !options.add_nulls)) continue;
            names.push(p);
            pnums.push(options.placeholder || ("$" + i));
            v = this.value(options, v, cols[p]);
            req.values.push(v);
            i++;
        }
        // No columns to insert, just exit, it is not an error, return empty result
        if (!names.length) {
            logger.debug('sqlInsert:', table, 'nothing to do', obj, cols);
            return null;
        }
        req.text = (options.replace ? "REPLACE" : "INSERT") + " INTO " + table + "(" + names.join(",") + ") values(" + pnums.join(",") + ")";
        if (options.returning) req.text += " RETURNING " + options.returning;
        return req;
    },

    // Build SQL statement for update
    sqlUpdate: function(table, obj, options) {
        if (!options) options = {};
        var sets = [], req = { values: [] }, i = 1;
        var cols = this.getColumns(table, options) || {};
        var keys = options.keys;
        if (!keys || !keys.length) keys = this.getKeys(table, options) || [];

        for (p in obj) {
            if (!p || p[0] == "_" || (!options.nocolumns && !(p in cols)) || keys.indexOf(p) != -1) continue;
            var v = obj[p];
            // Filter not allowed columns or only allowed columns
            if (options.skip_cols && options.skip_cols.indexOf(p) > -1) continue;
            if (options.allow_cols && options.allow_cols.indexOf(p) == -1) continue;
            // Do not update primary columns
            if (cols[p] && cols[p].primary) continue;
            // Avoid int parse errors with empty strings
            if (!v && ["number","json"].indexOf(cols[p].type) > -1) v = null;
            // Not defined fields are skipped but nulls can be triggered by a flag
            if (typeof v == "undefined" || (v == null && options.skip_null)) continue;
            // Update only if the value is null, otherwise skip
            if (options.skip_not_null && options.skip_not_null.indexOf(p) > -1) {
                sets.push(p + "=COALESCE(" + p + ", $" + i + ")");
            } else
            // Concat mode means append new value to existing, not overwrite
            if (options.concat && options.concat.indexOf(p) > -1) {
                sets.push(p + "=CONCAT(" + p + ", $" + i + ")");
            } else {
                sets.push(p + "=" + (options.placeholder || ("$" + i)));
            }
            v = this.value(options, v, cols[p]);
            req.values.push(v);
            i++;
        }
        var where = this.sqlWhere(obj, keys, options);
        if (!sets.length || !where) {
            // No keys or columns to update, just exit, it is not an error, return empty result
            logger.debug('sqlUpdate:', table, 'nothing to do', obj, keys);
            return null;
        }
        req.values = req.values.concat(w.values);
        req.text = "UPDATE " + table + " SET " + sets.join(",") + " WHERE " + where;
        if (options.returning) req.text += " RETURNING " + options.returning;
        return req;
    },

    // Build SQL statement for delete
    sqlDelete: function(table, obj, options) {
        if (!options) options = {};
        var keys = options.keys;
        if (!keys || !keys.length) keys = this.getKeys(table, options) || [];
        
        var where = this.sqlWhere(obj, keys, options);
        if (!where) {
            // No keys or columns to update, just exit, it is not an error, return empty result
            logger.debug('sqlUpdate:', table, 'nothing to do', obj, keys);
            return null;
        }
        var req = { text: "DELETE FROM " + table + " WHERE " + where };
        if (options.returning) req.text += " RETURNING " + options.returning;
        return req;
    },
    
    // Setup primary database access
    pgInitPool: function(options) {
        var self = this;
        if (!options) options = {};
        if (!options.pool) options.pool = "pg";
        var pool = this.initPool(options, self.pgOpen, self.pgCacheColumns, self.pgValue);
        // No REPLACE INTO support, do it manually
        pool.put = function(table, obj, opts, callback) {
            self.update(table, obj, keys, opts, function(err, rows, info) {
                if (err || info.affected_rows) return callback ? callback(err, rows, info) : null; 
                self.add(table, obj, opts, callback);
            });
        }
        return pool;
    },

    // Open PostgreSQL connection, execute initial statements
    pgOpen: function(options, callback) {
        if (typeof options == "function") callback = options, options = null;
        if (!options) options = {};
        
        new backend.PgSQLDatabase(options.db, function(err) {
            if (err) {
                logger.error('pgOpen:', options, err);
                return callback ? callback(err) : null;
            }
            var pg = this;
            pg.notify(function(msg) { logger.log('notify:', msg) });

            // Execute initial statements to setup the environment, like pragmas
            var opts = Array.isArray(options.init) ? options.init : [];
            async.forEachSeries(opts, function(sql, next) {
                logger.debug('pgOpen:', conninfo, sql);
                pg.query(sql, next);
            }, function(err2) {
                logger.edebug(err2, 'pgOpen:', options);
                if (callback) callback(err2, pg);
            });
        });
    },
    
    // Always keep columns and primary keys in the cache
    pgCacheColumns: function(options, callback) {
        if (typeof options == "function") callback = options, options = null;
        if (!options) options = {};

        var pool = this.getPool(options);
        pool.get(function(err, client) {
            if (err) return callback ? callback(err, []) : null;
            
            client.query("SELECT c.table_name,c.column_name,LOWER(c.data_type) AS data_type,c.column_default,c.ordinal_position,c.is_nullable " +
                         "FROM information_schema.columns c,information_schema.tables t " +
                         "WHERE c.table_schema='public' AND c.table_name=t.table_name " +
                         "ORDER BY 5", function(err, rows) {
                pool.dbcolumns = {};
                for (var i = 0; i < rows.length; i++) {
                    if (!pool.dbcolumns[rows[i].table_name]) pool.dbcolumns[rows[i].table_name] = {};
                    // Split type cast and ignore some functions in default value expressions
                    var isserial = false, val = rows[i].column_default ? rows[i].column_default.replace(/'/g,"").split("::")[0] : null;
                    if (val && val.indexOf("nextval") == 0) val = null, isserial = true;
                    if (val && val.indexOf("ARRAY") == 0) val = val.replace("ARRAY", "").replace("[", "{").replace("]", "}");
                    var type = "";
                    switch (rows[i].data_type) {
                    case "array":
                    case "json":
                        type = rows[i].data_type;
                        break;

                    case "numeric":
                    case "bigint":
                    case "real":
                    case "integer":
                    case "smallint":
                    case "double precision":
                        type = "number";
                        break;

                    case "boolean":
                        type = "bool";
                        break;

                    case "date":
                    case "time":
                    case "timestamp with time zone":
                    case "timestamp without time zone":
                        type = "date";
                        break;
                    }
                    pool.dbcolumns[rows[i].table_name][rows[i].column_name] = { id: rows[i].ordinal_position, value: val, type: type, data_type: rows[i].data_type, isnull: rows[i].is_nullable == "YES", isserial: isserial };
                }

                client.query("SELECT c.table_name,k.column_name,constraint_type " +
                             "FROM information_schema.table_constraints c,information_schema.key_column_usage k "+
                             "WHERE constraint_type IN ('PRIMARY KEY','UNIQUE') AND c.constraint_name=k.constraint_name", function(err, rows) {
                    pool.dbkeys = {};
                    pool.dbunique = {};
                    for (var i = 0; i < rows.length; i++) {
                        var col = pool.dbcolumns[rows[i].table_name][rows[i].column_name];
                        switch (rows[i].constraint_type) {
                        case "PRIMARY KEY":
                            if (!pool.dbkeys[rows[i].table_name]) pool.dbkeys[rows[i].table_name] = [];
                            pool.dbkeys[rows[i].table_name].push(rows[i].column_name);
                            if (col) col.primary = true;
                            break;
                            
                        case "UNIQUE":
                            if (!pool.dbunique[rows[i].table_name]) pool.dbunique[rows[i].table_name] = [];
                            pool.dbunique[rows[i].table_name].push(rows[i].column_name);
                            if (col) col.unique = 1;
                            break;
                        }
                    }
                    pool.free(client);
                    if (callback) callback(err);
                });
            });
        });
    },

    // Convert js array into db PostgreSQL array format: {..}
    pgValue: function(val, opts) {
        function toArray(v) {
            return '{' + v.map(function(x) { return Array.isArray(x) ? toArray(x) : typeof x === 'undefined' || x === null ? 'NULL' : JSON.stringify(x);3 } ).join(',') + '}';
        }
        switch ((opts || {}).data_type || "") {
        case "array":
            if (Buffer.isBuffer(val)) {
                var a = [];
                for (var i = 0; i < v.length; i++) a.push(v[i]);
                val = a.join(',');
            } else
            if (Array.isArray(val)) {
                val = toArray(val);
            }
            if (val && val[0] != "{") val = "{" + v + "}";
            break;

        default:
            if (Buffer.isBuffer(val)) val = val.toJSON();
            if (Array.isArray(val)) val = String(val);
        }
        return val;
    },
    
    // Initialize local sqlite cache database by name, the db files are open in read only mode and are watched for changes,
    // if new file got copied from the master, we reopen local database
    sqliteInitPool: function(options) {
        var self = this;
        if (!options) options = {};
        if (typeof options.readonly == "undefined") options.readonly = true;
        if (typeof options.temp_store == "undefined") options.temp_store = 0;
        if (typeof options.cache_size == "undefined") options.cache_size = 50000;
        if (typeof options.busy_timeout == "undefined") options.busy_timeout = -1;
        if (typeof options.read_uncommitted == "undefined") options.read_uncommitted = true;
        
        if (!options.pool) options.pool = "sqlite";
        options.file = path.join(options.path || core.path.spool, (options.db || name)  + ".db");
        return this.initPool(options, self.sqliteOpen, self.sqliteCacheColumns, self.sqliteValue);
    },

    // Common code to open or create local Sqlite databases, execute all required initialization statements, calls callback
    // with error as first argument and database object as second
    sqliteOpen: function(options, callback) {
        if (typeof options == "function") callback = options, options = null;
        if (!options) options = {};

        new backend.SQLiteDatabase(options.file, options.readonly ? backend.OPEN_READONLY : 0, function(err) {
            if (err) {
                // Do not report errors about not existing databases
                if (err.code != "SQLITE_CANTOPEN" || !options.silent) logger.error('sqliteOpen', options.file, err);
                return callback ? callback(err) : null;
            }
            var db = this;

            // Execute initial statements to setup the environment, like pragmas
            var opts = [];
            if (typeof options.cache_size != "undefined") opts.push("PRAGMA cache_size=-" + options.cache_size);
            if (typeof options.temp_store != "undefined") opts.push("PRAGMA temp_store=" + options.temp_store);
            if (typeof options.journal_mode != "undefined") opts.push("PRAGMA journal_mode=" + options.journal_mode);
            if (typeof options.locking_mode != "undefined") opts.push("PRAGMA locking_mode=" + options.locking_mode);
            if (typeof options.synchronous != "undefined") opts.push("PRAGMA synchronous=" + options.synchronous);
            if (typeof options.read_uncommitted != "undefined") opts.push("PRAGMA read_uncommitted=" + options.read_uncommitted);
            if (typeof options.busy_timeout != "undefined") opts.push("SELECT busy_timeout(" + options.busy_timeout + ")");
            if (Array.isArray(options.init)) opts = opts.concat(options.init);
            async.forEachSeries(opts, function(sql, next) {
                logger.debug('sqliteOpen:', options.file, sql);
                db.exec(sql, next);
            }, function(err2) {
                logger.edebug(err2, 'sqliteOpen:', 'init', options.file);
                if (callback) callback(err2, db);
            });
        });
    },

    // Always keep columns and primary keys in the cache for the pool
    sqliteCacheColumns: function(options, callback) {
        if (typeof options == "function") callback = options, options = null;
        if (!options) options = {};
        
        var pool = this.getPool(options);
        pool.get(function(err, client) {
            if (err) return callback ? callback(err, []) : null;
            client.query("SELECT name FROM sqlite_master WHERE type='table'", function(err2, tables) {
                if (err2) return callback ? callback(err2) : null;
                pool.dbcolumns = {};
                pool.dbkeys = {};
                pool.dbunique = {};
                async.forEachSeries(tables, function(table, next) {
                    client.query("PRAGMA table_info(" + table.name + ")", function(err3, rows) {
                        if (err3) return next(err3);
                        for (var i = 0; i < rows.length; i++) {
                            if (!pool.dbcolumns[table.name]) pool.dbcolumns[table.name] = {};
                            if (!pool.dbkeys[table.name]) pool.dbkeys[table.name] = [];
                            // Split type cast and ignore some functions in default value expressions
                            pool.dbcolumns[table.name][rows[i].name] = { id: rows[i].cid, value: rows[i].dflt_value, type: rows[i].type.toLowerCase(), data_type: rows[i].type, isnull: !rows[i].notnull, primary: rows[i].pk };
                            if (rows[i].pk) pool.dbkeys[table.name].push(rows[i].name);
                        }
                        client.query("PRAGMA index_list(" + table.name + ")", function(err4, indexes) {
                            async.forEachSeries(indexes, function(idx, next2) {
                                if (!idx.unique) return next2();
                                client.query("PRAGMA index_info(" + idx.name + ")", function(err5, cols) {
                                    cols.forEach(function(x) {
                                        var col = pool.dbcolumns[table.name][x.name];
                                        if (!col || col.primary) return; 
                                        col.unique = 1;
                                        if (!pool.dbunique[table.name]) pool.dbunique[table.name] = [];
                                        pool.dbunique[table.name].push(x.name);
                                    });
                                    next2();
                                });
                            }, function() {
                                next();
                            });
                        });
                    });
                }, function(err4) {
                    pool.free(client);
                    if (callback) callback(err4);
                });
            });
        });
    },

    // Convert into appropriate Sqlite format
    sqliteValue: function(val, opts) {
        // Dates must be converted into seconds
        if (typeof val == "object" && val.getTime) return Math.round(val.getTime()/1000);
        return val;
    },
    
    // DynamoDB pool
    ddbInitPool: function(options) {
        var self = this;
        if (!options) options = {};
        if (!options.pool) options.pool = "ddb";

        // Redefine pool but implement the same interface
        var pool = { name: options.pool, db: options.db, dbcolumns: {}, dbkeys: {}, dbunique: {}, stats: { gets: 0, hits: 0, misses: 0, puts: 0, dels: 0, errs: 0 } };
        this.dbpool[options.pool] = pool;
        pool.last_evaluated_key = null;
        pool.affected_rows = 0;
        pool.inserted_oid = 0;
        pool.get = function(callback) { callback(null, this); }
        pool.free = function() {}
        pool.watch = function() {}
        pool.value = function(v) { return v }

        pool.cacheColumns = function(opts, callback) {
            if (typeof opts == "function") callback = opts, opts = null;
            var pool = this;
            var options = { db: pool.db };
            
            aws.ddbListTables(options, function(err, rc) {
                if (err) return callback ? callback(err) : null;
                pool.dbcolumns = {};
                pool.dbkeys = {};
                pool.dbunique = {};
                async.forEachSeries(rc.TableNames, function(table, next) {
                    aws.ddbDescribeTable(table, options, function(err, rc) {
                        if (err) return next(err);
                        rc.Table.AttributeDefinitions.forEach(function(x) {
                            if (!pool.dbcolumns[table]) pool.dbcolumns[table] = {};
                            var type = x.AttributeType == "N" ? "number" : x.AttributeType.length == 2 ? "array" : "text";
                            pool.dbcolumns[table][x.AttributeName] = { type: type, data_type: x.AttributeType };
                        });
                        rc.Table.KeySchema.forEach(function(x) {
                            if (!pool.dbkeys[table]) pool.dbkeys[table] = [];
                            pool.dbkeys[table].push(x.AttributeName);
                            pool.dbcolumns[table][x.AttributeName].primary = 1;
                        });
                        (rc.Table.LocalSecondaryIndexes || []).forEach(function(x) {
                            x.KeySchema.forEach(function(y) {
                                if (!pool.dbunique[table]) pool.dbunique[table] = [];
                                pool.dbunique[table].push(y.AttributeName);
                                pool.dbcolumns[table][y.AttributeName].index = 1;
                            });
                        });
                        next();
                    });
                }, function(err2) {
                    if (callback) callback(err2);
                });
            });
        }
        
        // Pass all parametetrs directly to the execute function
        pool.prepare = function(op, table, obj, opts) {
            return { text: table, op: op, values: obj };
        }
        
        // Simulate query as in SQL driver but performing AWS call, text will be a table name and values will be request options
        pool.query = function(client, req, opts, callback) {
            logger.log("query:", req, opts)
            var pool = this;
            var table = req.text;
            var obj = req.values;
            var options = core.extendObj(opts, "db", pool.db);
            pool.last_evaluated_key = "";
            
            switch(req.op) {
            case "new":
                var attrs = obj.filter(function(x) { return x.primary || x.hashindex }).
                                map(function(x) { return [ x.name, x.type == "int" || x.type == "real" ? "N" : "S" ] }).
                                reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});
                var keys = obj.filter(function(x, i) { return x.primary && i < 2 }).
                               map(function(x, i) { return [ x.name, i ? 'RANGE' : 'HASH' ] }).
                               reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});
                var idxs = obj.filter(function(x) { return x.hashindex }).
                               map(function(x) { return [x.name, self.newObj(obj.filter(function(y) { return y.primary })[0].name, 'HASH', x.name, 'RANGE') ] }).
                               reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});
                aws.ddbCreateTable(table, attrs, keys, idxs, options, function(err, item) {
                    callback(err, item ? [item.Item] : []);
                });
                break;
                
            case "upgrade":
                callback();
                break;
                
            case "get":
                var keys = (pool.dbkeys[table] || []).map(function(x) { return [ x, obj[x] ] }).reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});
                aws.ddbGetItem(table, keys, options, function(err, item) {
                    callback(err, item.Item ? [item.Item] : []);
                });
                break;

            case "select":
                // Only primary key columns are allowed
                var other = (options.keys || []).filter(function(x) { return pool.dbkeys[table].indexOf(x) == -1 });
                var keys = (options.keys || pool.dbkeys[table] || []).filter(function(x) { return other.indexOf(x) == -1 }).map(function(x) { return [ x, obj[x] ] }).reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});
                // If we have other key columns we have to use custom filter
                var filter = function(items) { 
                    if (other.length > 0) {
                        if (!options.ops) options.ops = {};
                        if (!options.type) options.type = {};
                        // Keep rows which satisfy all conditions
                        items = items.filter(function(row) {
                            return other.every(function(k) {
                                return core.isTrue(row[k], obj[k], options.ops[k], options.type[k]);
                            });
                        });
                    }
                    return options.filter ? items.filter(function(row) { return options.filter(row, options); }) : items; 
                }
                aws.ddbQueryTable(table, keys, options, function(err, item) {
                    if (err) return callback(err, []);
                    var count = options.count || 0;
                    var rows = filter(item.Items);
                    pool.last_evaluated_key = item.LastEvaluatedKey ? aws.fromDynamoDB(item.LastEvaluatedKey) : "";
                    count -= rows.length;
                    
                    // Keep retrieving items until we reach the end or our limit
                    async.until( 
                        function() { return pool.last_evaluated_key == "" || count <= 0; }, 
                        function(next) {
                            options.start = pool.last_evaluated_key;
                            aws.ddbQueryTable(table, keys, options, function(err, item) {
                                var items = filter(item.Items);
                                rows.push.apply(rows, items);
                                pool.last_evaluated_key = item.LastEvaluatedKey ? aws.fromDynamoDB(item.LastEvaluatedKey) : "";
                                count -= items.length;
                                next(err);
                            });                            
                        },
                        function(err) {
                            callback(err, rows);
                        });
                });
                break;

            case "list":
                var req = {};
                req[table] = obj.map(function(x) { return { keys: x, select: options.select, consistent: options.consistent } });
                aws.ddbBatchGetItem(req, options, function(err, item) {
                    if (err) return callback(err, []);
                    // Keep retrieving items until we get all items
                    var moreKeys = item.UnprocessedKeys || null;
                    var items = item.Responses[table] || [];
                    async.until(
                        function() { return moreKeys; },
                        function(next) {
                            options.RequestItems = moreKeys;
                            aws.ddbBatchGetItem({}, options, function(err, item) {
                                items.push.apply(items, item.Responses[table] || []);
                                next(err);
                            });                            
                        },
                        function(err) {
                            callback(err, items);
                        });
                });
                break;
                
            case "add":
                // Add only listed columns if there is a .columns property specified
                var o = core.cloneObj(obj, { _skip_cb: function(n,v) { return n[0] == '_' || typeof v == "undefined" || v == null || (options.columns && !(n in options.columns)); } });
                options.expected = (pool.dbkeys[table] || []).map(function(x) { return x }).reduce(function(x,y) { x[y] = null; return x }, {});
                aws.ddbPutItem(table, o, options, function(err, rc) {
                    callback(err, []);
                });
                break;

            case "put":
                // Add/put only listed columns if there is a .columns property specified
                var o = core.cloneObj(obj, { _skip_cb: function(n,v) { return n[0] == '_' || typeof v == "undefined" || v == null || (options.columns && !(n in options.columns)); } });
                aws.ddbPutItem(table, o, options, function(err, rc) {
                    callback(err, []);
                });
                break;
                
            case "update":
                var keys = (pool.dbkeys[table] || []).map(function(x) { return [ x, obj[x] ] }).reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});
                // Skip special columns, nulls, primary key columns. If we have specific list of allowed columns only keep those.
                var o = core.cloneObj(obj, { _skip_cb: function(n,v) { return n[0] == '_' || typeof v == "undefined" || v == null || keys[n] || (options.columns && !(n in options.columns)); } });
                options.expected = keys;
                aws.ddbUpdateItem(table, keys, o, options, function(err, rc) {
                    callback(err, []);
                });
                break;

            case "del":
                var keys = (pool.dbkeys[table] || []).map(function(x) { return [ x, obj[x] ] }).reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});
                aws.ddbDeleteItem(table, keys, options, function(err, rc) {
                    callback(err, []);
                });
                break;
                
            default:
                callback(new Error("invalid op"))
            }
        }
        return pool;
    },

}

module.exports = db;
core.addContext('db', db);
